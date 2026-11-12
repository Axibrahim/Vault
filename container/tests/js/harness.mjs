// A fake network that lets two real TransferSession objects talk to each other inside a test:
// fake WebRTC connections and data channels, fake signalling, a fake receiving disk.
// It can also misbehave on purpose (corrupt, duplicate or drop messages, cut the connection).
import { webcrypto } from "node:crypto";
import { verifyStoredFile } from "../../static/js/transfer/blocks.js";
import { TransferSession } from "../../static/js/transfer/session.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function until(condition, ms = 5000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting for: " + condition);
    await tick();
  }
}

export const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await tick(); };

export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
  return bytes;
}

export const fileOf = (name, bytes, type = "application/octet-stream") => new File([bytes], name, { type });

// ---------------------------------------------------------------- channels and connections

export class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "connecting";
    this.bufferedAmount = 0;
    this.listeners = {};
    this.peer = null;
    this.network = null;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  _emit(type, event = {}) {
    if (this[`on${type}`]) this[`on${type}`](event);
    for (const fn of this.listeners[type] || []) fn(event);
  }

  open() {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this._emit("open");
  }

  send(data) {
    if (this.readyState !== "open") throw new Error("the channel is not open");
    const copy = typeof data === "string" ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const delivered = this.network.tamper ? this.network.tamper(this, copy) : [copy];
    for (const item of delivered) {
      setImmediate(() => {
        if (this.peer && this.peer.readyState === "open") this.peer._emit("message", { data: item });
      });
    }
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this._emit("close");
    const other = this.peer;
    if (other && other.readyState !== "closed") {
      setImmediate(() => { other.readyState = "closed"; other._emit("close"); });
    }
  }
}

export class FakeNetwork {
  constructor() {
    this.pcs = [];
    this.nextId = 1;
    this.tamper = null;          // (channel, data) => [data, ...]  (return [] to drop, two items to duplicate)
    this.RTC = makeRtc(this);
  }

  // The connection breaks: every connection fails and every channel closes.
  drop() {
    for (const pc of this.pcs) pc._state("failed");
    for (const pc of this.pcs) for (const channel of pc.channels) channel.close();
  }
}

function makeRtc(network) {
  return class FakePc {
    constructor() {
      this.id = network.nextId++;
      this.connectionState = "new";
      this.channels = [];
      this.pending = [];
      this.remote = null;
      this.connected = false;
      this.remoteDescription = null;
      this.localDescription = null;
      network.pcs.push(this);
    }

    async createOffer() { return { type: "offer", sdp: `v=0 offer-${this.id} ${"x".repeat(30)}` }; }
    async createAnswer() { return { type: "answer", sdp: `v=0 answer-${this.id} ${"x".repeat(30)}` }; }
    async setLocalDescription(description) { this.localDescription = description; }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
      const found = /(?:offer|answer)-(\d+)/.exec(description.sdp);
      this.remote = network.pcs.find((pc) => pc.id === Number(found[1]));
      if (description.type === "answer") this._connect(this.remote);
    }

    async addIceCandidate() {}

    createDataChannel(label) {
      const mine = new FakeChannel(label);
      const theirs = new FakeChannel(label);
      mine.peer = theirs;
      theirs.peer = mine;
      mine.network = theirs.network = network;
      this.channels.push(mine);
      if (this.connected) this._hand(mine, theirs); else this.pending.push([mine, theirs]);
      return mine;
    }

    _hand(mine, theirs) {
      this.remote.channels.push(theirs);
      this.remote.ondatachannel({ channel: theirs });
      setImmediate(() => { mine.open(); theirs.open(); });
    }

    _connect(other) {
      this.connected = true;
      this.remote = other;
      this._state("connected");
      other._state("connected");
      for (const [mine, theirs] of this.pending.splice(0)) this._hand(mine, theirs);
    }

    _state(value) {
      this.connectionState = value;
      if (this.onconnectionstatechange) this.onconnectionstatechange();
    }

    close() {
      if (this.connectionState === "closed") return;
      this._state("closed");
      for (const channel of this.channels) channel.close();
      if (this.remote) setImmediate(() => this.remote._state("failed"));
    }
  };
}

// ---------------------------------------------------------------- signalling and storage

export class FakeSignaling {
  constructor(hub, deviceId) {
    this.hub = hub;
    this.deviceId = deviceId;
    this.sentOffers = [];
    this.closes = [];
    this.records = [];
    this.verifiedOffers = 0;
    this.pinned = [];
    this.failVerifyOffer = false;
    this.failVerifyAnswer = false;
  }

  getIceServers = async () => [];

  sendOffer = async (identity, toDeviceId, sdp, kind = "files") => {
    const transferId = crypto.randomUUID();
    this.sentOffers.push({ transferId, toDeviceId, kind });
    this.hub.transfers.set(transferId, { from: identity.deviceId, to: toDeviceId });
    this.hub.deliver(toDeviceId, { type: "offer", transferId, kind, from: identity.deviceId, sdp });
    return { transferId };
  };

  sendAnswer = async (identity, transferId, offerSdp, sdp) => {
    const t = this.hub.transfers.get(transferId);
    this.hub.deliver(t.from, { type: "answer", transferId, from: identity.deviceId, sdp });
  };

  sendIce = async () => {};

  close = async (identity, transferId, reason) => {
    this.closes.push({ transferId, reason });
    const t = this.hub.transfers.get(transferId);
    if (!t) return;
    const peer = identity.deviceId === t.from ? t.to : t.from;
    this.hub.deliver(peer, { type: "closed", transferId, reason });
  };

  record = async (identity, transferId, toDeviceId, files, bytes) => {
    this.records.push({ transferId, toDeviceId, files, bytes });
  };

  verifyOffer = async () => {
    this.verifiedOffers += 1;
    if (this.failVerifyOffer) throw new Error("Signature check failed");
    return "AAAA-BBBB-CCCC";
  };

  verifyAnswer = async () => {
    if (this.failVerifyAnswer) throw new Error("Signature check failed");
    return "AAAA-BBBB-CCCC";
  };

  pinPeer = async (uid, deviceId, printed) => { this.pinned.push([deviceId, printed]); };
}

// A receiving "disk" in memory. It writes blocks where it is told to and can be made to misbehave.
export class MemorySink {
  constructor() {
    this.files = new Map();       // name -> Uint8Array of what was saved
    this.opened = [];
    this.aborted = [];
    this.allowed = true;
    this.corruptOnWrite = false;  // the "disk" silently damages what it stores
  }

  async ready() { return this.allowed; }

  open(meta) {
    const store = new Uint8Array(meta.size);
    const name = meta.name;
    this.opened.push(name);
    return Promise.resolve({
      name,
      writeBlock: async (index, bytes) => {
        const copy = bytes.slice();
        if (this.corruptOnWrite && copy.length) copy[0] ^= 0xff;
        store.set(copy, index * 8 * 1024 * 1024);
      },
      finish: async (hashes) => {
        await verifyStoredFile(new Blob([store]), meta.size, hashes);
        this.files.set(name, store);
        return { name };
      },
      abort: async () => { this.aborted.push(name); },
    });
  }
}

export class FakeUi {
  constructor() {
    this.shown = [];
    this.receivedInfo = null;
    this.sentInfo = null;
    this.hidden = 0;
    this.accept = true;
    this.text = "";
    this.textStates = [];
  }

  show(kind, title, detail, progress, resumable) { this.shown.push({ kind, title, detail, progress, resumable }); }
  hide() { this.hidden += 1; }
  askAccept = async () => this.accept;
  received(results, manifest) { this.receivedInfo = { results, manifest }; }
  sent(count, total) { this.sentInfo = { count, total }; }
  textChanged(body) { this.text = body; }
  textStatus(status) { this.textStates.push(status); }
  get last() { return this.shown[this.shown.length - 1]; }
}

// ---------------------------------------------------------------- a pair of devices

export class Hub {
  constructor() {
    this.sessions = new Map();
    this.transfers = new Map();
    this.delivered = [];
  }

  deliver(deviceId, event) {
    this.delivered.push({ deviceId, event });
    const session = this.sessions.get(deviceId);
    setImmediate(() => session && session._onEvent(event));
  }
}

export function makePair({ network = new FakeNetwork() } = {}) {
  const hub = new Hub();
  const make = (id, name, peerId, peerName, { dialsText }) => {
    const signaling = new FakeSignaling(hub, id);
    const ui = new FakeUi();
    const sink = new MemorySink();
    const session = new TransferSession({
      identity: { deviceId: id }, uid: "user-1", peers: [{ id: peerId, name: peerName }], sink, ui, dialsText,
      deps: { signaling, RTCPeerConnection: network.RTC },
    });
    hub.sessions.set(id, session);
    return { id, name, signaling, ui, sink, session };
  };
  const desktopId = "d0000000-0000-4000-8000-000000000001";
  const phoneId = "f0000000-0000-4000-8000-000000000002";
  const desktop = make(desktopId, "Home PC", phoneId, "My phone", { dialsText: true });
  const phone = make(phoneId, "My phone", desktopId, "Home PC", { dialsText: false });
  return { network, hub, desktop, phone };
}