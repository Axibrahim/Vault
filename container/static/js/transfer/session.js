// One device's side of every transfer: dialling, answering, agreeing on the file list,
// moving the files and surviving a dropped connection. The browser pieces (RTCPeerConnection,
// the server calls and the screen) are passed in, which is also how the tests run it.
import {
  BLOCK_SIZE, CONTROL_LABEL, FILE_PREFIX, LANES, blockCount, parseControl, resumeBlock,
} from "./protocol.js";
import { cleanMime, formatBytes, safeFileName } from "./safety.js";
import { scanFile } from "./blocks.js";
import { Lifecycle, S } from "./lifecycle.js";
import { sendFile } from "./sender.js";
import { TEXT_LABEL, TextSync } from "./text.js";
import { receiveFile } from "./receiver.js";
import { listen, signaling as realSignaling } from "./signaling.js";

const DIAL_TIMEOUT_MS = 30_000;
const DROP_GRACE_MS = 8_000;
const PAINT_EVERY_MS = 250;
const PARTIAL_TTL_MS = 30 * 60 * 1000;
const STALL_MS = 60_000;          // no byte, acknowledgement or message for this long: the transfer is dead
const WATCH_EVERY_MS = 5_000;
const SEEN_OFFERS = 50;           // transfer ids remembered, so a replayed offer is ignored
const TEXT_LINK_MAX_MS = 6 * 60 * 60 * 1000;   // the text link is replaced by a freshly authenticated one this often
const TEXT_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

const closeSafe = (thing) => { try { thing.close(); } catch (err) { /* already closed */ } };

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  d.promise.catch(() => {});      // never an "unhandled rejection"; whoever awaits it still sees the error
  return d;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { expired: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class TransferSession {
  constructor({ identity, uid, peers = [], sink, ui, deps = {}, dialsText = false }) {
    this.identity = identity;
    this.uid = uid;
    this.setPeers(peers);
    this.peerId = null;                       // who the current transfer is with
    this.peerName = "the other device";
    this.sink = sink;
    this.ui = ui;
    this.signaling = deps.signaling || realSignaling;
    this.RTC = deps.RTCPeerConnection || globalThis.RTCPeerConnection;

    this.link = null;       // the live connection, if any
    this.outgoing = null;   // the batch being sent (kept so it can be resumed)
    this.partial = null;    // the batch being received (kept so it can be resumed)
    this.progress = null;
    this.stopListening = null;
    this.seen = new Set();  // transfer ids already handled: an offer is never acted on twice

    // The shared text box has its own connection, separate from file transfers.
    this.clip = null;
    this.dialsText = dialsText;                 // only the computer dials, so two devices never dial each other at once
    this.wantText = null;                       // { peerId, online }: who the text box should be connected to
    this.textRetry = null;
    this.textTries = 0;
    this.text = new TextSync(identity.deviceId, {
      onText: (body) => ui.textChanged && ui.textChanged(body),
      onStatus: (status) => ui.textStatus && ui.textStatus(status),
    });
  }

  _remember(transferId) {
    this.seen.add(transferId);
    if (this.seen.size > SEEN_OFFERS) this.seen.delete(this.seen.values().next().value);
  }

  // The devices this one may talk to: [{ id, name }]. It can change while the page is open.
  setPeers(list) {
    this.peers = new Map(list.map((p) => [p.id, p.name]));
    this.peerTypes = new Map(list.map((p) => [p.id, p.type]));
  }

  start() {
    this.stopListening = listen(this.identity.deviceId, (evt) => this._onEvent(evt), this.signaling);
  }

  stop() {
    if (this.stopListening) this.stopListening();
    this.wantText = null;
    clearTimeout(this.textRetry);
    if (this.clip) this._fail(this.clip, new Error("stopped"));
    if (this.link) this._fail(this.link, new Error("stopped"));
    this._discardPartial();
    this._dropOutgoing();
  }

  _dropOutgoing() {
    if (this.outgoing) {
      clearTimeout(this.outgoing.expiry);
      this.outgoing.abort.abort();
    }
    this.outgoing = null;
  }

  get busy() {
    return Boolean(this.link || this.outgoing || this.partial);
  }

  // ---------------------------------------------------------------- sending

  async send(list, peerId) {
    if (this.busy) throw new Error("A transfer is already in progress");
    if (!this.peers.has(peerId)) throw new Error("No device to send to");

    const files = list.map((file) => {
      const name = safeFileName(file.name);
      return {
        id: crypto.randomUUID(), file, name, size: file.size, type: cleanMime(file.type, name),
        startBlock: 0, done: false, hashes: null, digest: null,    // hashes + digest are filled in by _prepare()
      };
    });
    this.outgoing = {
      batch: crypto.randomUUID(), files, total: files.reduce((n, f) => n + f.size, 0), peerId,
      abort: new AbortController(), expiry: null,
    };
    await this._run();
  }

  async resume() {
    if (!this.outgoing || this.link) return;
    clearTimeout(this.outgoing.expiry);
    await this._run();               // a resume is a brand new connection: new offer, new signature, new transfer id
  }

  async cancel() {
    const link = this.link;
    this._dropOutgoing();
    if (link) await this._close(link, "cancelled");
    if (link) this._fail(link, Object.assign(new Error("cancelled"), { cancelled: true, remoteClosed: true }));
    this._discardPartial();
    this.ui.hide();
  }

  async _run() {
    const out = this.outgoing;
    this.peerId = out.peerId;
    this.peerName = this.peers.get(out.peerId) || this.peerName;
    let link = null;
    this._startProgress(out.total, out.files.reduce((n, f) => n + (f.done ? f.size : 0), 0));
    this.ui.show("loading", `Connecting to ${this.peerName}`, "Opening a private connection", null, false);

    try {
      await this._prepare(out);
      link = await this._dial();
      const accept = await Promise.race([this._offerFiles(link, out), link.dead.promise]);
      await Promise.race([this._upload(link, out, accept), link.dead.promise]);

      // Every file was received AND checked by the other device (that is what its "done" means).
      link.ctl.send(JSON.stringify({ t: "all-done" }));
      await this.signaling.record(this.identity, link.transferId, out.peerId, out.files.length, out.total).catch(() => {});
      await this._close(link, "done");
      this._dropOutgoing();
      this._retire(link);
      this.ui.sent(out.files.length, out.total);
    } catch (err) {
      if (link) this._fail(link, err);
      if (!this.outgoing) return;                      // cancelled on purpose

      if (err.integrity) {                             // the file changed on disk: it has to be checked again
        for (const f of out.files) Object.assign(f, { hashes: null, digest: null, startBlock: 0, done: false });
      }

      if (err.cancelled) {
        this.outgoing = null;
        this.ui.show("interrupted", "Cancelled", "The other device cancelled the transfer.", null, false);
      } else if (err.declined) {
        this.outgoing = null;
        const why = err.declined === "folder"
          ? "Open Vault on the computer and allow access to the folder."
          : err.declined === "busy" ? "The other device is busy with another transfer." : "The other device declined the files.";
        this.ui.show("interrupted", "Not sent", why, null, false);
      } else {
        this.ui.show("interrupted", "Transfer interrupted", err.message || "The connection was lost", null, true);
        // an interrupted transfer cannot wait for ever: after a while it is forgotten
        clearTimeout(out.expiry);
        out.expiry = setTimeout(() => {
          if (this.outgoing === out && !this.link) {
            this._dropOutgoing();
            this.ui.hide();
          }
        }, PARTIAL_TTL_MS);
        if (out.expiry.unref) out.expiry.unref();
      }
    }
  }

  // Reads every file once and works out its SHA-256 (the digest the other device must match).
  async _prepare(out) {
    let done = 0;
    for (const f of out.files) {
      if (f.digest) continue;
      const { hashes, digest } = await scanFile(f.file, {
        signal: out.abort.signal,
        onBytes: (bytes) => {
          done += bytes;
          this.ui.show("loading", "Checking your files", `${formatBytes(done)} of ${formatBytes(out.total)} · so they can be verified on arrival`,
            out.total ? done / out.total : 0, false);
        },
      });
      f.hashes = hashes;
      f.digest = digest;
    }
    if (out.abort.signal.aborted) throw new Error("Cancelled");
  }

  async _dial() {
    const link = this._newLink("sender");
    link.peerId = this.peerId;
    this.link = link;
    try {
      return await this._dialInto(link);
    } catch (err) {
      this._fail(link, err);
      throw err;
    }
  }

  async _dialInto(link) {
    link.pc = new this.RTC({ iceServers: await this.signaling.getIceServers() });
    this._wirePc(link);
    link.ctl = link.pc.createDataChannel(link.kind === "clip" ? TEXT_LABEL : CONTROL_LABEL);
    this._wireControl(link, link.ctl);

    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    link.offerSdp = offer.sdp;

    const { transferId } = await this.signaling.sendOffer(this.identity, link.peerId, offer.sdp, link.kind);
    link.transferId = transferId;
    for (const evt of link.early.splice(0)) await this._onLinkEvent(link, evt);   // an answer can beat the reply to our offer
    this._flushLocalIce(link);

    await Promise.race([
      withTimeout(link.opened.promise, DIAL_TIMEOUT_MS, "Could not connect. If you are on mobile data, a relay (TURN) server may be needed."),
      link.dead.promise,
    ]);
    return link;
  }

  _offerFiles(link, out) {
    const reply = deferred();
    link.onAccept = reply.resolve;
    link.onDecline = (reason) => reply.reject(Object.assign(new Error("declined"), { declined: reason }));

    link.life.move(S.WAITING);
    link.ctl.send(JSON.stringify({
      t: "manifest",
      batch: out.batch,
      files: out.files.map(({ id, name, size, type, digest }) => ({ id, name, size, type, digest })),
    }));
    return reply.promise.then((accept) => {
      if (accept.batch !== out.batch) throw new Error("The other device answered about a different batch");
      link.life.require(S.WAITING);
      link.life.move(S.TRANSFERRING);
      this._watch(link);
      for (const f of out.files) {
        const entry = accept.files.find((x) => x.id === f.id);
        if (!entry || entry.have > f.size) { f.startBlock = 0; continue; }
        f.done = f.done || entry.done;
        f.startBlock = resumeBlock(f.size, entry.have);
      }
      this.progress.done = out.files.reduce((n, f) => n + (f.done ? f.size : Math.min(f.size, f.startBlock * BLOCK_SIZE)), 0);
      return accept;
    });
  }

  async _upload(link, out) {
    const todo = out.files.filter((f) => !f.done);
    const lane = async () => {
      while (todo.length) await this._sendOne(link, todo.shift());
    };
    await Promise.all(Array.from({ length: Math.min(LANES, todo.length) }, lane));
  }

  async _sendOne(link, f) {
    link.life.require(S.TRANSFERRING);               // no data unless this transfer is accepted and still running
    const channel = link.pc.createDataChannel(FILE_PREFIX + f.id);
    if (channel.readyState !== "open") {
      await new Promise((resolve, reject) => {
        channel.onopen = resolve;
        channel.onerror = () => reject(new Error("Could not open a channel"));
        channel.onclose = () => reject(new Error("Connection closed"));
      });
    }
    await sendFile(channel, f.file, {
      startBlock: f.startBlock,
      hashes: f.hashes,
      signal: link.abort.signal,
      onBytes: (n) => { this._touch(link); this._tick(n); },
      onActivity: () => this._touch(link),
    });
    f.done = true;
    closeSafe(channel);
  }

  // --------------------------------------------------------------- receiving

  async _onOffer(evt) {
    if (this.seen.has(evt.transferId)) return;       // a replayed offer is never acted on twice
    this._remember(evt.transferId);

    if (!this.peers.has(evt.from)) return this._refuse(evt, "declined");
    const kind = evt.kind === "clip" ? "clip" : "files";
    const slot = kind === "clip" ? "clip" : "link";

    // Every connection is a new authenticated session: the signature on THIS offer is checked
    // before anything else happens, including before an older connection is replaced.
    let printed;
    try {
      printed = await this.signaling.verifyOffer(evt, this.identity.deviceId);
      await this.signaling.pinPeer(this.uid, evt.from, printed);
    } catch (err) {
      return this._refuse(evt, "error");
    }

    if (this[slot]) {
      // the same device calling again means its old connection is dead (that is how a resume starts)
      if (this[slot].side !== "receiver" || this[slot].peerId !== evt.from) return this._refuse(evt, "declined");
      this._fail(this[slot], Object.assign(new Error("A new connection replaced this one"), { remoteClosed: true }));
    }

    if (kind === "files") {
      this.peerId = evt.from;
      this.peerName = this.peers.get(evt.from);
    }

    const link = this._newLink("receiver", kind);
    link.transferId = evt.transferId;
    link.peerId = evt.from;
    this[slot] = link;

    try {
      link.pc = new this.RTC({ iceServers: await this.signaling.getIceServers() });
      this._wirePc(link);
      link.pc.ondatachannel = (e) => this._onChannel(link, e.channel);

      await link.pc.setRemoteDescription({ type: "offer", sdp: evt.sdp });
      await this._flushRemoteIce(link);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      await this.signaling.sendAnswer(this.identity, evt.transferId, evt.sdp, answer.sdp);
      this._flushLocalIce(link);
    } catch (err) {
      this._fail(link, err);
    }
  }

  _refuse(evt, reason) {
    return this.signaling.close(this.identity, evt.transferId, reason).catch(() => {});
  }

  _onChannel(link, channel) {
    if (link.ended) return closeSafe(channel);

    if (link.kind === "clip") {                       // the text link carries exactly one channel, and nothing else
      if (channel.label === TEXT_LABEL && !link.ctl) {
        link.ctl = channel;
        this._wireControl(link, channel);
      } else {
        closeSafe(channel);
      }
      return;
    }

    if (channel.label === CONTROL_LABEL) {
      link.ctl = channel;
      this._wireControl(link, channel);
    } else if (channel.label.startsWith(FILE_PREFIX)) {
      this._onFileChannel(link, channel);
    } else {
      closeSafe(channel);
    }
  }

  async _onManifest(link, manifest) {
    if (link.manifest || !link.life.move(S.WAITING)) return;     // one file list per connection, and only while it is live
    link.manifest = manifest;
    // A batch can only be resumed by the very device that started it.
    const resuming = Boolean(this.partial && this.partial.batch === manifest.batch && this.partial.peerId === link.peerId);

    const decline = (reason) => {
      link.ctl.send(JSON.stringify({ t: "decline", reason }));
      this._close(link, "declined");
      this._fail(link, Object.assign(new Error("declined"), { declined: reason, remoteClosed: true }));
    };

    if (!(await this.sink.ready())) {
      this.ui.show("interrupted", "Could not receive", "Allow access to the receiving folder first.", null, false);
      return decline("folder");
    }

    if (!resuming) {
      this.ui.show("loading", `${this.peerName} wants to send`, `${manifest.files.length} file(s), ${formatBytes(manifest.total)}`, null, false);
      if (!(await this.ui.askAccept(manifest))) return decline("user");
      if (link.ended) return;
      this._discardPartial();
      this.partial = {
        batch: manifest.batch,
        peerId: link.peerId,
        manifest,
        files: new Map(manifest.files.map((meta) => [meta.id, { meta, writer: null, hashes: [], result: null, run: null }])),
      };
    }

    this.partial.transferId = link.transferId;
    const have = manifest.files.map((meta) => {
      const entry = this.partial.files.get(meta.id);
      const done = Boolean(entry && entry.result);
      return { id: meta.id, done, have: done ? meta.size : Math.min(meta.size, (entry ? entry.hashes.length : 0) * BLOCK_SIZE) };
    });
    this._startProgress(manifest.total, have.reduce((n, f) => n + f.have, 0));
    this.ui.show("loading", `Receiving from ${this.peerName}`, "", this.progress.done / Math.max(1, manifest.total), false);
    if (!link.life.move(S.TRANSFERRING)) return;                 // cancelled while the person was deciding
    this._watch(link);
    link.ctl.send(JSON.stringify({ t: "accept", batch: manifest.batch, files: have }));
    this._maybeComplete(link);
  }

  _onFileChannel(link, channel) {
    if (link.life.state !== S.TRANSFERRING) return closeSafe(channel);    // data only after accepting, never after the end
    const id = channel.label.slice(FILE_PREFIX.length);
    const entry = this.partial && link.manifest && this.partial.batch === link.manifest.batch
      ? this.partial.files.get(id) : null;
    if (!entry || entry.result) return closeSafe(channel);

    if (!entry.writer) {
      entry.writer = this.sink.open(entry.meta);
      entry.writer.catch(() => {});
    }
    const run = {};
    entry.run = run;           // an older connection's late work can never touch this file again
    receiveFile(channel, {
      meta: entry.meta,
      writer: entry.writer,
      hashes: entry.hashes,
      onBytes: (n) => { this._touch(link); this._tick(n); },
      onActivity: () => this._touch(link),
      active: () => !link.ended && entry.run === run && link.life.state === S.TRANSFERRING,
    }).then((result) => {
      entry.result = result;
      this._maybeComplete(link);
    }).catch((err) => {
      if (err.integrity) this._discardPartial();      // damaged data is never kept for a resume
      this._fail(link, err);
    });
  }

  _maybeComplete(link) {
    const partial = this.partial;
    if (!partial || link.ended || link.life.state !== S.TRANSFERRING) return;
    if (![...partial.files.values()].every((e) => e.result)) return;

    const results = partial.manifest.files.map((meta) => ({ ...meta, ...partial.files.get(meta.id).result }));
    this.partial = null;
    this._retire(link);
    this.ui.received(results, partial.manifest);
  }

  async _discardPartial() {
    const partial = this.partial;
    this.partial = null;
    if (!partial) return;
    clearTimeout(partial.expiry);
    for (const entry of partial.files.values()) {
      if (entry.writer && !entry.result) {
        try { (await entry.writer).abort(); } catch (err) { /* nothing was opened */ }
      }
    }
  }

  // ------------------------------------------------------------- connection

  _newLink(side, kind = "files") {
    return {
      side, kind, pc: null, ctl: null, transferId: null, offerSdp: null, manifest: null, peerId: null,
      life: new Lifecycle(), lastActivity: Date.now(), watchdog: null, closeSent: false,
      opened: deferred(), dead: deferred(), abort: new AbortController(),
      early: [], localIce: [], remoteIce: [], iceSent: 0, ended: false, closing: false, dropTimer: null,
      onAccept: null, onDecline: null,
    };
  }

  _wirePc(link) {
    link.pc.onicecandidate = (e) => {
      if (e.candidate && e.candidate.candidate) {
        link.localIce.push(e.candidate);
        this._flushLocalIce(link);
      }
    };
    link.pc.onconnectionstatechange = () => {
      const state = link.pc.connectionState;
      if (state === "connected") clearTimeout(link.dropTimer);
      else if (state === "failed") this._fail(link, new Error("The connection failed"));
      else if (state === "disconnected") {
        clearTimeout(link.dropTimer);
        link.dropTimer = setTimeout(() => {
          if (link.pc.connectionState !== "connected") this._fail(link, new Error("The connection was lost"));
        }, DROP_GRACE_MS);
      } else if (state === "closed" && !link.closing) this._fail(link, new Error("The connection was closed"));
    };
  }

  _wireControl(link, channel) {
    const opened = () => {
      link.opened.resolve();
      if (link.kind === "clip") this._textOpened(link, channel);
    };
    channel.onopen = opened;
    if (channel.readyState === "open") opened();
    if (link.kind === "clip") {
      channel.onmessage = (event) => {
        try {
          this.text.receive(event.data);
        } catch (err) {
          this._fail(link, Object.assign(new Error("The other device sent something unexpected"), { quiet: true }));
        }
      };
      return;
    }
    channel.onmessage = (event) => {
      let msg;
      try {
        msg = parseControl(event.data);
      } catch (err) {
        return this._fail(link, new Error("The other device sent something unexpected"));
      }
      this._onControl(link, msg);
    };
  }

  _onControl(link, msg) {
    if (link.side === "sender") {
      if (msg.t === "accept" && link.onAccept && link.life.state === S.WAITING) link.onAccept(msg);
      else if (msg.t === "decline" && link.onDecline) link.onDecline(msg.reason);
      else if (msg.t === "cancel") this._fail(link, Object.assign(new Error("The other device cancelled"), { cancelled: true }));
    } else if (msg.t === "manifest") {
      this._onManifest(link, msg).catch((err) => this._fail(link, err));
    } else if (msg.t === "cancel") {
      this._discardPartial();
      this._fail(link, Object.assign(new Error("The other device cancelled"), { cancelled: true, quiet: true }));
    }
  }

  async _onEvent(evt) {
    if (evt.type === "offer") return this._onOffer(evt);

    // The sender cancelled. The connection often drops before this message arrives,
    // so it is handled even when there is no live link any more.
    if (evt.type === "closed" && evt.reason === "cancelled" && this.partial && this.partial.transferId === evt.transferId) {
      this._discardPartial();
      this.ui.show("interrupted", "Cancelled", `${this.peerName} cancelled the transfer.`, null, false);
    }

    for (const link of [this.link, this.clip]) {
      if (!link) continue;
      if (!link.transferId) link.early.push(evt);                 // we are still dialling: keep it for later
      else if (evt.transferId === link.transferId) await this._onLinkEvent(link, evt);
    }
  }

  async _onLinkEvent(link, evt) {
    if (link.ended || evt.transferId !== link.transferId) return;

    if (evt.type === "answer" && link.side === "sender") {
      try {
        const printed = await this.signaling.verifyAnswer(evt, link.offerSdp);
        await this.signaling.pinPeer(this.uid, evt.from, printed);
        await link.pc.setRemoteDescription({ type: "answer", sdp: evt.sdp });
        await this._flushRemoteIce(link);
      } catch (err) {
        this._fail(link, err);
      }
    } else if (evt.type === "ice") {
      link.remoteIce.push({ candidate: evt.candidate, sdpMid: evt.sdpMid, sdpMLineIndex: evt.sdpMLineIndex });
      await this._flushRemoteIce(link);
    } else if (evt.type === "closed") {
      if (evt.reason === "done") return;
      if (link.kind === "files" && link.side === "receiver" && evt.reason !== "error") this._discardPartial();
      const err = Object.assign(new Error(`The other device ended the transfer (${evt.reason})`), {
        declined: evt.reason === "declined" ? "user" : undefined,
        cancelled: evt.reason === "cancelled",
        quiet: evt.reason === "cancelled" && link.side === "receiver",   // already shown above
        remoteClosed: true,                                              // the server already knows it is over
      });
      this._fail(link, err);
    }
  }

  async _flushRemoteIce(link) {
    if (!link.pc || !link.pc.remoteDescription) return;
    for (const candidate of link.remoteIce.splice(0)) {
      await link.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  // Candidates are signed one by one, and the server limits requests, so send a handful in order.
  _flushLocalIce(link) {
    if (!link.transferId || link.flushing) return;
    link.flushing = true;
    (async () => {
      while (link.localIce.length && !link.ended) {
        const candidate = link.localIce.shift();
        if (link.iceSent >= 25) continue;
        link.iceSent += 1;
        await this.signaling.sendIce(this.identity, link.transferId, candidate).catch(() => {});
      }
      link.flushing = false;
    })();
  }

  // Tells the server this connection is over (once, and never for an end the server announced itself).
  _close(link, reason) {
    if (!link.transferId || link.closeSent) return Promise.resolve();
    link.closeSent = true;
    return this.signaling.close(this.identity, link.transferId, reason).catch(() => {});
  }

  _touch(link) {
    link.lastActivity = Date.now();
  }

  // While data should be flowing, silence for too long means the other side is gone or frozen.
  _watch(link) {
    this._touch(link);
    clearInterval(link.watchdog);
    link.watchdog = setInterval(() => {
      if (Date.now() - link.lastActivity > STALL_MS) {
        this._fail(link, Object.assign(new Error("The transfer stalled: nothing arrived for a minute"), { expired: true }));
      }
    }, WATCH_EVERY_MS);
    if (link.watchdog.unref) link.watchdog.unref();
  }

  // Normal end of a connection: let the last messages through, then close.
  _retire(link) {
    if (!link.life.move(S.COMPLETED)) return;
    clearInterval(link.watchdog);
    link.closing = true;
    link.ended = true;
    if (this.link === link) this.link = null;
    setTimeout(() => closeSafe(link.pc), 1500);
  }

  // Something went wrong. Everything that belongs to this connection stops, and the server is told.
  // The partly received batch is kept (the sender can resume it) unless the data itself is bad.
  _fail(link, error) {
    if (link.ended) return;
    link.ended = true;
    const ending = error.cancelled ? S.CANCELLED : error.declined ? S.DECLINED : error.expired ? S.EXPIRED : S.FAILED;
    link.life.move(ending);
    link.abort.abort();
    clearTimeout(link.dropTimer);
    clearInterval(link.watchdog);
    closeSafe(link.pc);
    if (this.link === link) this.link = null;
    if (this.clip === link) this.clip = null;
    clearTimeout(link.rotation);
    link.opened.reject(error);
    link.dead.reject(error);
    if (!error.remoteClosed) this._close(link, error.cancelled ? "cancelled" : error.declined ? "declined" : "error");
    if (link.kind === "clip") return this._textEnded(link);
    if (error.quiet) return;

    if (error.integrity) {
      this.ui.show("interrupted", "A file was damaged", "A file failed its integrity check and was thrown away. Send it again.", null, false);
    } else if (link.side === "receiver" && this.partial) {
      const kept = this.partial;
      clearTimeout(kept.expiry);
      kept.expiry = setTimeout(() => {
        if (this.partial === kept) {
          this._discardPartial();
          this.ui.hide();
        }
      }, PARTIAL_TTL_MS);
      if (kept.expiry.unref) kept.expiry.unref();
      this.ui.show("interrupted", "Transfer interrupted", `Waiting for ${this.peerName} to continue`, null, false);
    } else if (link.side === "receiver" && error.message !== "declined") {
      this.ui.show("interrupted", "Could not connect", error.message, null, false);
    }
  }

  // ------------------------------------------------------------ shared text

  // The controller says who the text box should talk to and whether that device is online.
  // Only the computer dials. It keeps one live link to the chosen device while that device is online.
  syncText(peerId, online) {
    this.wantText = peerId ? { peerId, online } : null;
    if (this.clip && (!peerId || this.clip.peerId !== peerId)) {
      this._fail(this.clip, new Error("Another device was chosen"));
    }
    if (!peerId || !online || this.clip || this.textRetry || !this.peers.has(peerId) || !this._dialsTextTo(peerId)) return;
    this._openClip(peerId);
  }

  // Who opens the text link: a computer always dials a phone. Between two phones, the one with the lower id dials,
  // so they never dial each other at the same moment.
  _dialsTextTo(peerId) {
    if (this.dialsText) return true;
    return this.peerTypes.get(peerId) === "phone" && this.identity.deviceId < peerId;
  }

  // The person typed.
  setText(body) {
    this.text.edit(body);
  }

  async _openClip(peerId) {
    const link = this._newLink("sender", "clip");
    link.peerId = peerId;
    this.clip = link;
    this.text.setStatus("connecting");
    try {
      await this._dialInto(link);
    } catch (err) {
      this._fail(link, err);
    }
  }

  // The channel is open: the text link is live. It lives for a limited time, then a new,
  // freshly authenticated one replaces it.
  _textOpened(link, channel) {
    if (link.ended || this.clip !== link || !link.life.move(S.WAITING) || !link.life.move(S.TRANSFERRING)) return;
    this.textTries = 0;
    this.text.attach(link.peerId, (obj) => {
      if (!link.ended && channel.readyState === "open") channel.send(JSON.stringify(obj));
    });
    link.rotation = setTimeout(() => this._fail(link, Object.assign(new Error("Renewing the text link"), { expired: true })), TEXT_LINK_MAX_MS);
    if (link.rotation.unref) link.rotation.unref();
  }

  _textEnded(link) {
    this.text.detach();
    this.text.setStatus("offline");
    if (!this.wantText || !this._dialsTextTo(this.wantText.peerId) || !this.wantText.online || this.textRetry) return;
    const wait = TEXT_RETRY_MS[Math.min(this.textTries, TEXT_RETRY_MS.length - 1)];
    this.textTries += 1;
    this.textRetry = setTimeout(() => {
      this.textRetry = null;
      if (this.wantText) this.syncText(this.wantText.peerId, this.wantText.online);
    }, wait);
    if (this.textRetry.unref) this.textRetry.unref();
  }

  // --------------------------------------------------------------- progress

  _startProgress(total, done) {
    this.progress = { total, done, samples: [[Date.now(), done]], lastPaint: 0 };
  }

  _tick(bytes) {
    const p = this.progress;
    if (!p) return;
    p.done += bytes;

    const now = Date.now();
    if (now - p.lastPaint < PAINT_EVERY_MS) return;
    p.lastPaint = now;
    p.samples.push([now, p.done]);
    while (p.samples.length > 2 && now - p.samples[0][0] > 4000) p.samples.shift();

    const [t0, d0] = p.samples[0];
    const speed = now > t0 ? ((p.done - d0) * 1000) / (now - t0) : 0;
    const left = speed > 0 ? Math.ceil((p.total - p.done) / speed) : null;
    const eta = left === null ? "" : left >= 60 ? ` · ${Math.ceil(left / 60)} min left` : ` · ${left} s left`;
    const verb = this.link && this.link.side === "receiver" ? "Receiving from" : "Sending to";

    this.ui.show(
      "loading",
      `${verb} ${this.peerName}`,
      `${formatBytes(p.done)} of ${formatBytes(p.total)} · ${formatBytes(speed)}/s${eta}`,
      p.total ? p.done / p.total : 0,
      false,
    );
  }
}

export { blockCount };