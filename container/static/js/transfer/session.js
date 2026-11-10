// One device's side of every transfer: dialling, answering, agreeing on the file list,
// moving the files and surviving a dropped connection. The browser pieces (RTCPeerConnection,
// the server calls and the screen) are passed in, which is also how the tests run it.
import {
  BLOCK_SIZE, CONTROL_LABEL, FILE_PREFIX, LANES, blockCount, parseControl, resumeBlock,
} from "./protocol.js";
import { cleanMime, formatBytes, safeFileName } from "./safety.js";
import { sendFile } from "./sender.js";
import { receiveFile } from "./receiver.js";
import { listen, signaling as realSignaling } from "./signaling.js";

const DIAL_TIMEOUT_MS = 30_000;
const DROP_GRACE_MS = 8_000;
const PAINT_EVERY_MS = 250;
const PARTIAL_TTL_MS = 30 * 60 * 1000;

const closeSafe = (thing) => { try { thing.close(); } catch (err) { /* already closed */ } };

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  d.promise.catch(() => {});      // never an "unhandled rejection"; whoever awaits it still sees the error
  return d;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class TransferSession {
  constructor({ identity, uid, peerId, peerName = "the other device", sink, ui, deps = {} }) {
    this.identity = identity;
    this.uid = uid;
    this.peerId = peerId;
    this.peerName = peerName;
    this.sink = sink;
    this.ui = ui;
    this.signaling = deps.signaling || realSignaling;
    this.RTC = deps.RTCPeerConnection || globalThis.RTCPeerConnection;

    this.link = null;       // the live connection, if any
    this.outgoing = null;   // the batch being sent (kept so it can be resumed)
    this.partial = null;    // the batch being received (kept so it can be resumed)
    this.progress = null;
    this.stopListening = null;
  }

  start() {
    this.stopListening = listen(this.identity.deviceId, (evt) => this._onEvent(evt), this.signaling);
  }

  stop() {
    if (this.stopListening) this.stopListening();
    if (this.link) this._fail(this.link, new Error("stopped"));
    this._discardPartial();
    this.outgoing = null;
  }

  get busy() {
    return Boolean(this.link || this.outgoing || this.partial);
  }

  // ---------------------------------------------------------------- sending

  async send(list) {
    if (this.busy) throw new Error("A transfer is already in progress");
    if (!this.peerId) throw new Error("No device to send to");

    const files = list.map((file) => {
      const name = safeFileName(file.name);
      return { id: crypto.randomUUID(), file, name, size: file.size, type: cleanMime(file.type, name), startBlock: 0, done: false };
    });
    this.outgoing = { batch: crypto.randomUUID(), files, total: files.reduce((n, f) => n + f.size, 0) };
    await this._run();
  }

  async resume() {
    if (!this.outgoing || this.link) return;
    await this._run();
  }

  async cancel() {
    const link = this.link;
    this.outgoing = null;
    if (link && link.transferId) {
      await this.signaling.close(this.identity, link.transferId, "cancelled").catch(() => {});
    }
    if (link) this._fail(link, new Error("cancelled"));
    this._discardPartial();
    this.ui.hide();
  }

  async _run() {
    const out = this.outgoing;
    let link = null;
    this._startProgress(out.total, out.files.reduce((n, f) => n + (f.done ? f.size : 0), 0));
    this.ui.show("loading", `Connecting to ${this.peerName}`, "Opening a private connection", null, false);

    try {
      link = await this._dial();
      const accept = await Promise.race([this._offerFiles(link, out), link.dead.promise]);
      await Promise.race([this._upload(link, out, accept), link.dead.promise]);

      link.ctl.send(JSON.stringify({ t: "all-done" }));
      await this.signaling.close(this.identity, link.transferId, "done").catch(() => {});
      this.outgoing = null;
      this._retire(link);
      this.ui.sent(out.files.length, out.total);
    } catch (err) {
      if (link) this._fail(link, err);
      if (!this.outgoing) return;                      // cancelled on purpose

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
      }
    }
  }

  async _dial() {
    const link = this._newLink("sender");
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
    link.ctl = link.pc.createDataChannel(CONTROL_LABEL);
    this._wireControl(link, link.ctl);

    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    link.offerSdp = offer.sdp;

    const { transferId } = await this.signaling.sendOffer(this.identity, this.peerId, offer.sdp);
    link.transferId = transferId;
    for (const evt of link.early.splice(0)) await this._onEvent(evt);   // an answer can beat the reply to our offer
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

    link.ctl.send(JSON.stringify({
      t: "manifest",
      batch: out.batch,
      files: out.files.map(({ id, name, size, type }) => ({ id, name, size, type })),
    }));
    return reply.promise.then((accept) => {
      if (accept.batch !== out.batch) throw new Error("The other device answered about a different batch");
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
      signal: link.abort.signal,
      onBytes: (n) => this._tick(n),
    });
    f.done = true;
    closeSafe(channel);
  }

  // --------------------------------------------------------------- receiving

  async _onOffer(evt) {
    if (evt.from !== this.peerId) {
      await this.signaling.close(this.identity, evt.transferId, "declined").catch(() => {});
      return;
    }
    if (this.link) {
      await this.signaling.close(this.identity, evt.transferId, "declined").catch(() => {});
      return;
    }

    const link = this._newLink("receiver");
    link.transferId = evt.transferId;
    this.link = link;

    try {
      const printed = await this.signaling.verifyOffer(evt, this.identity.deviceId);
      await this.signaling.pinPeer(this.uid, evt.from, printed);

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
      this.signaling.close(this.identity, evt.transferId, "error").catch(() => {});
    }
  }

  _onChannel(link, channel) {
    if (link.ended) return closeSafe(channel);

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
    if (link.manifest) return;
    link.manifest = manifest;
    const resuming = this.partial && this.partial.batch === manifest.batch;

    const decline = (reason) => {
      link.ctl.send(JSON.stringify({ t: "decline", reason }));
      this.signaling.close(this.identity, link.transferId, "declined").catch(() => {});
      this._fail(link, new Error("declined"));
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
        manifest,
        files: new Map(manifest.files.map((meta) => [meta.id, { meta, writer: null, verified: 0, result: null }])),
      };
    }

    this.partial.transferId = link.transferId;
    const have = manifest.files.map((meta) => {
      const entry = this.partial.files.get(meta.id);
      const done = Boolean(entry && entry.result);
      return { id: meta.id, done, have: done ? meta.size : Math.min(meta.size, (entry ? entry.verified : 0) * BLOCK_SIZE) };
    });
    this._startProgress(manifest.total, have.reduce((n, f) => n + f.have, 0));
    this.ui.show("loading", `Receiving from ${this.peerName}`, "", this.progress.done / Math.max(1, manifest.total), false);
    link.ctl.send(JSON.stringify({ t: "accept", batch: manifest.batch, files: have }));
    this._maybeComplete(link);
  }

  _onFileChannel(link, channel) {
    const id = channel.label.slice(FILE_PREFIX.length);
    const entry = this.partial && link.manifest && this.partial.batch === link.manifest.batch
      ? this.partial.files.get(id) : null;
    if (!entry || entry.result) return closeSafe(channel);

    if (!entry.writer) {
      entry.writer = this.sink.open(entry.meta);
      entry.writer.catch(() => {});
    }
    receiveFile(channel, {
      meta: entry.meta,
      writer: entry.writer,
      startBlock: entry.verified,
      onBytes: (n) => this._tick(n),
      onBlock: (i) => { entry.verified = i + 1; },
    }).then((result) => {
      entry.result = result;
      this._maybeComplete(link);
    }).catch((err) => this._fail(link, err));
  }

  _maybeComplete(link) {
    const partial = this.partial;
    if (!partial || link.ended || ![...partial.files.values()].every((e) => e.result)) return;

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

  _newLink(side) {
    return {
      side, pc: null, ctl: null, transferId: null, offerSdp: null, manifest: null,
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
    channel.onopen = () => link.opened.resolve();
    if (channel.readyState === "open") link.opened.resolve();
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
      if (msg.t === "accept" && link.onAccept) link.onAccept(msg);
      else if (msg.t === "decline" && link.onDecline) link.onDecline(msg.reason);
      else if (msg.t === "cancel") this._fail(link, new Error("The other device cancelled"));
    } else if (msg.t === "manifest") {
      this._onManifest(link, msg).catch((err) => this._fail(link, err));
    } else if (msg.t === "cancel") {
      this._discardPartial();
      this._fail(link, new Error("The other device cancelled"));
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

    const link = this.link;
    if (!link) return;
    if (!link.transferId) {
      link.early.push(evt);
      return;
    }
    if (evt.transferId !== link.transferId) return;

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
      if (link.side === "receiver" && evt.reason !== "error") this._discardPartial();
      const err = Object.assign(new Error(`The other device ended the transfer (${evt.reason})`), {
        declined: evt.reason === "declined" ? "user" : undefined,
        cancelled: evt.reason === "cancelled",
        quiet: evt.reason === "cancelled" && link.side === "receiver",   // already shown above
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

  // Normal end of a connection: let the last messages through, then close.
  _retire(link) {
    link.closing = true;
    link.ended = true;
    if (this.link === link) this.link = null;
    setTimeout(() => closeSafe(link.pc), 1500);
  }

  // Something went wrong. Keep the partly received batch: the sender can resume it.
  _fail(link, error) {
    if (link.ended) return;
    link.ended = true;
    link.abort.abort();
    clearTimeout(link.dropTimer);
    closeSafe(link.pc);
    if (this.link === link) this.link = null;
    link.opened.reject(error);
    link.dead.reject(error);
    if (error.quiet) return;

    if (link.side === "receiver" && this.partial) {
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