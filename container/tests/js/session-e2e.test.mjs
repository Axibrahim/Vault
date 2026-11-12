// Two real TransferSession objects talking over a fake network that can misbehave on purpose.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { FakeNetwork, fileOf, makePair, randomBytes, settle, until } from "./harness.mjs";
import { S } from "../../static/js/transfer/lifecycle.js";

const MB = 1024 * 1024;
const OFFER_FROM_DESKTOP = (hub) => hub.delivered.filter((d) => d.event.type === "offer");
const manifestFor = (id, bytes, digest) => ({
  t: "manifest", batch: crypto.randomUUID(), total: bytes.length,
  files: [{ id, name: "a.bin", size: bytes.length, type: "application/octet-stream", digest, kind: "files" }],
});

function parse(data) {
  try { return typeof data === "string" ? JSON.parse(data) : null; } catch (err) { return null; }
}

// ================================================================ a normal transfer

test("files of every kind arrive complete, and success is reported only after they were verified", async () => {
  const { desktop, phone } = makePair();
  const big = randomBytes(17 * MB);
  const small = randomBytes(1000);
  const empty = new Uint8Array(0);

  let savedWhenRecorded = -1;
  const record = desktop.signaling.record;
  desktop.signaling.record = async (...args) => { savedWhenRecorded = phone.sink.files.size; return record(...args); };

  await desktop.session.send([fileOf("big.mov", big, "video/quicktime"), fileOf("small.txt", small), fileOf("empty.txt", empty)], phone.id);
  await until(() => phone.ui.receivedInfo);

  assert.deepEqual(phone.sink.files.get("big.mov"), big);
  assert.deepEqual(phone.sink.files.get("small.txt"), small);
  assert.deepEqual(phone.sink.files.get("empty.txt"), empty);
  assert.equal(savedWhenRecorded, 3, "the sender must not record success before every file was verified and saved");
  assert.equal(desktop.ui.sentInfo.count, 3);
  assert.equal(desktop.signaling.records.length, 1);
  assert.equal(desktop.signaling.closes.at(-1).reason, "done");
  assert.equal(desktop.session.busy, false);
  await until(() => phone.session.busy === false);
});

test("every connection is a new, signed, authenticated session", async () => {
  const { desktop, phone } = makePair();
  await desktop.session.send([fileOf("a.txt", randomBytes(100))], phone.id);
  await until(() => phone.ui.receivedInfo);
  assert.equal(phone.signaling.verifiedOffers, 1);
  assert.deepEqual(phone.signaling.pinned, [[desktop.id, "AAAA-BBBB-CCCC"]]);
  assert.equal(desktop.signaling.sentOffers[0].kind, "files");
});

// ================================================================ attacks on the data

async function sendWithTamper(tamper, { bytes = randomBytes(200_000), phoneSetup } = {}) {
  const pair = makePair();
  if (phoneSetup) phoneSetup(pair.phone);
  pair.network.tamper = tamper;
  await pair.desktop.session.send([fileOf("doc.bin", bytes)], pair.phone.id);
  await settle(40);
  return pair;
}

test("a corrupted block is thrown away: nothing is saved, nothing is reported as received", async () => {
  let flipped = false;
  const { desktop, phone } = await sendWithTamper((channel, data) => {
    if (typeof data !== "string" && !flipped) { new Uint8Array(data)[7] ^= 1; flipped = true; }
    return [data];
  });
  assert.equal(phone.sink.files.size, 0);
  assert.equal(phone.ui.receivedInfo, null);
  assert.deepEqual(phone.sink.aborted, ["doc.bin"]);               // the partial file is removed
  assert.equal(phone.session.partial, null);                       // and it is never offered for a resume
  assert.equal(phone.ui.last.title, "A file was damaged");
  assert.equal(desktop.signaling.records.length, 0);
  assert.equal(desktop.ui.sentInfo, null);
  assert.equal(desktop.ui.last.kind, "interrupted");
});

test("a lying file list (wrong digest) is refused even though every block is fine", async () => {
  const { desktop, phone } = await sendWithTamper((channel, data) => {
    const msg = parse(data);
    if (msg && msg.t === "manifest") { msg.files[0].digest = "0".repeat(64); return [JSON.stringify(msg)]; }
    return [data];
  });
  assert.equal(phone.sink.files.size, 0);
  assert.equal(phone.ui.receivedInfo, null);
  assert.deepEqual(phone.sink.aborted, ["doc.bin"]);
  assert.equal(desktop.signaling.records.length, 0);
});

test("a disk that damages the file is caught before success is reported", async () => {
  const { desktop, phone } = await sendWithTamper(null, { phoneSetup: (p) => { p.sink.corruptOnWrite = true; } });
  assert.equal(phone.sink.files.size, 0);
  assert.equal(phone.ui.receivedInfo, null);
  assert.equal(desktop.signaling.records.length, 0);
  assert.equal(desktop.ui.sentInfo, null);
});

test("a repeated chunk is rejected", async () => {
  let n = 0;
  const { phone } = await sendWithTamper((channel, data) => (typeof data !== "string" && (n += 1) === 3 ? [data, data] : [data]));
  assert.equal(phone.sink.files.size, 0);
  assert.equal(phone.ui.receivedInfo, null);
});

test("a missing chunk is rejected", async () => {
  let n = 0;
  const { phone } = await sendWithTamper((channel, data) => (typeof data !== "string" && (n += 1) === 2 ? [] : [data]));
  assert.equal(phone.sink.files.size, 0);
  assert.equal(phone.ui.receivedInfo, null);
});

test("a file that changes while it is being sent is not sent", async () => {
  const { desktop, phone } = makePair();
  const bytes = randomBytes(1 * MB);
  let reads = 0;
  const shifty = {
    name: "changing.bin", type: "application/octet-stream", size: bytes.length,
    slice: (a, b) => ({
      arrayBuffer: async () => {
        reads += 1;
        const out = bytes.slice(a, b);
        if (reads > 1) out[0] ^= 1;                                   // the first read is the scan, the next is the send
        return out.buffer;
      },
    }),
  };
  await desktop.session.send([shifty], phone.id);
  await settle(30);
  assert.equal(phone.sink.files.size, 0);
  assert.match(desktop.ui.last.detail, /changed while it was being sent/);
  assert.equal(desktop.session.outgoing.files[0].digest, null, "a changed file must be checked again before another try");
});

// ================================================================ interruption, cleanup, resume

async function interruptedAfterAck(blockIndex) {
  const pair = makePair();
  const bytes = randomBytes(20 * MB);                                // three blocks: 8 + 8 + 4 MiB
  const state = { resumed: false, bytesAfterResume: 0 };
  pair.network.tamper = (channel, data) => {
    const msg = parse(data);
    if (msg && msg.t === "ack" && msg.i === blockIndex && !state.resumed) setImmediate(() => pair.network.drop());
    if (state.resumed && typeof data !== "string") state.bytesAfterResume += data.byteLength;
    return [data];
  };
  await pair.desktop.session.send([fileOf("long.bin", bytes)], pair.phone.id);
  await until(() => pair.phone.ui.last && pair.phone.ui.last.title === "Transfer interrupted");
  return { ...pair, bytes, state };
}

test("an interrupted transfer keeps what was verified, and resumes as a brand new authenticated connection", async () => {
  const { desktop, phone, network, bytes, state } = await interruptedAfterAck(1);
  assert.equal(desktop.session.link, null);
  assert.equal(phone.session.link, null);
  assert.equal(desktop.ui.last.kind, "interrupted");
  const kept = [...phone.session.partial.files.values()][0];
  assert.equal(kept.hashes.length, 2, "blocks 0 and 1 were verified and kept");

  state.resumed = true;
  network.tamper = ((original) => (channel, data) => {
    if (typeof data !== "string") state.bytesAfterResume += data.byteLength;
    return original(channel, data);
  })(() => [arguments[1]]);
  network.tamper = (channel, data) => { if (typeof data !== "string") state.bytesAfterResume += data.byteLength; return [data]; };

  await desktop.session.resume();
  await until(() => phone.ui.receivedInfo);

  assert.deepEqual(phone.sink.files.get("long.bin"), bytes);
  assert.equal(state.bytesAfterResume, 4 * MB, "only the missing block is sent again");
  assert.equal(desktop.signaling.sentOffers.length, 2);
  assert.notEqual(desktop.signaling.sentOffers[0].transferId, desktop.signaling.sentOffers[1].transferId);
  assert.equal(phone.signaling.verifiedOffers, 2, "the resume was authenticated again, not trusted from before");
});

test("the server is told when a connection fails, exactly once, with the old transfer id", async () => {
  const { desktop, phone } = await interruptedAfterAck(0);
  const oldId = desktop.signaling.sentOffers[0].transferId;
  const sender = desktop.signaling.closes.filter((c) => c.transferId === oldId);
  assert.deepEqual(sender.map((c) => c.reason), ["error"]);
  const receiver = phone.signaling.closes.filter((c) => c.transferId === oldId);
  assert.ok(receiver.length <= 1);
});

test("an old connection's messages cannot revive a transfer after it ended", async () => {
  const { desktop, phone } = await interruptedAfterAck(0);
  const oldId = desktop.signaling.sentOffers[0].transferId;
  const before = desktop.ui.shown.length;
  await desktop.session._onEvent({ type: "answer", transferId: oldId, from: phone.id, sdp: "v=0 answer-1 xxxxxxxxxxxxxxxxxxxxxx" });
  await desktop.session._onEvent({ type: "ice", transferId: oldId, candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
  assert.equal(desktop.session.link, null);
  assert.equal(desktop.ui.shown.length, before);
});

test("cancelling discards the partial file, tells the server once, and late data is refused", async () => {
  const pair = makePair();
  const { desktop, phone, network } = pair;
  let lateChannel = null;
  network.tamper = (channel, data) => {
    const msg = parse(data);
    if (channel.label.startsWith("f:")) lateChannel = channel.peer.label.startsWith("f:") ? (channel.peer === channel ? channel : channel) : channel;
    if (msg && msg.t === "ack" && msg.i === 0) setImmediate(() => desktop.session.cancel());
    return [data];
  };
  await desktop.session.send([fileOf("c.bin", randomBytes(20 * MB))], phone.id);
  await until(() => phone.ui.last && phone.ui.last.title === "Cancelled");

  assert.equal(phone.session.partial, null);
  assert.deepEqual(phone.sink.aborted, ["c.bin"]);
  assert.equal(desktop.session.outgoing, null);
  assert.equal(desktop.session.busy, false);
  assert.equal(desktop.signaling.closes.filter((c) => c.reason === "cancelled").length, 1);
  assert.equal(phone.session.link, null);

  // data that was still on the wire is not accepted any more
  const before = phone.sink.aborted.length;
  for (const channel of [lateChannel, lateChannel && lateChannel.peer]) {
    if (channel) channel._emit("message", { data: new ArrayBuffer(1000) });
  }
  await settle();
  assert.equal(phone.sink.files.size, 0);
  assert.equal(phone.sink.aborted.length, before);
});

test("cancelling before the connection is up still tells nobody a lie and cleans up", async () => {
  const { desktop, phone } = makePair();
  const sending = desktop.session.send([fileOf("a.bin", randomBytes(5000))], phone.id);
  await desktop.session.cancel();
  await sending;
  assert.equal(desktop.session.outgoing, null);
  assert.equal(desktop.session.busy, false);
});

test("cancelling while the files are still being checked stops the check", async () => {
  const { desktop, phone } = makePair();
  const sending = desktop.session.send([fileOf("a.bin", randomBytes(20 * MB))], phone.id);
  await settle(2);
  await desktop.session.cancel();
  await sending;
  assert.equal(desktop.signaling.sentOffers.length, 0, "no connection is opened for a cancelled transfer");
  assert.equal(desktop.session.busy, false);
});

test("declining sends nothing and opens no file", async () => {
  const { desktop, phone } = makePair();
  phone.ui.accept = false;
  await desktop.session.send([fileOf("a.bin", randomBytes(5000))], phone.id);
  await settle(20);
  assert.equal(desktop.ui.last.title, "Not sent");
  assert.match(desktop.ui.last.detail, /declined/);
  assert.equal(desktop.session.outgoing, null);
  assert.deepEqual(phone.sink.opened, []);
  assert.equal(phone.signaling.closes.filter((c) => c.reason === "declined").length, 1);
});

test("a receiver that cannot save (no folder access) declines with a clear reason", async () => {
  const { desktop, phone } = makePair();
  phone.sink.allowed = false;
  await desktop.session.send([fileOf("a.bin", randomBytes(5000))], phone.id);
  await settle(20);
  assert.match(desktop.ui.last.detail, /allow access to the folder/);
  assert.equal(phone.ui.last.title, "Could not receive");
});

test("data channels opened before the transfer was accepted are closed", async () => {
  const { phone } = makePair();
  const link = phone.session._newLink("receiver");
  phone.session.link = link;
  const channel = { label: `f:${crypto.randomUUID()}`, closed: false, close() { this.closed = true; } };
  phone.session._onChannel(link, channel);
  assert.equal(channel.closed, true);
  const other = { label: "surprise", closed: false, close() { this.closed = true; } };
  phone.session._onChannel(link, other);
  assert.equal(other.closed, true);
  link.ended = true;
  const late = { label: "ctl", closed: false, close() { this.closed = true; } };
  phone.session._onChannel(link, late);
  assert.equal(late.closed, true);
});

test("a data channel for a file that is not in the list is closed", async () => {
  const { phone } = makePair();
  const link = phone.session._newLink("receiver");
  link.manifest = { batch: "b" };
  phone.session.link = link;
  link.life.move(S.WAITING);
  link.life.move(S.TRANSFERRING);
  phone.session.partial = { batch: "b", files: new Map() };
  const channel = { label: `f:${crypto.randomUUID()}`, closed: false, close() { this.closed = true; } };
  phone.session._onChannel(link, channel);
  assert.equal(channel.closed, true);
});

test("a second file list on the same connection is ignored", async () => {
  const { phone } = makePair();
  const link = phone.session._newLink("receiver");
  link.manifest = { batch: "first" };
  await phone.session._onManifest(link, { batch: "second", files: [], total: 0 });
  assert.equal(link.manifest.batch, "first");
});

test("a file list is only accepted while the connection is live", async () => {
  const { phone } = makePair();
  const link = phone.session._newLink("receiver");
  link.life.move(S.CANCELLED);
  await phone.session._onManifest(link, { batch: "x", files: [], total: 0 });
  assert.equal(link.manifest, null);
});

test("an 'accept' that arrives at the wrong moment is ignored by the sender", () => {
  const { desktop } = makePair();
  const link = desktop.session._newLink("sender");
  let accepted = 0;
  link.onAccept = () => { accepted += 1; };
  desktop.session._onControl(link, { t: "accept", batch: "b", files: [] });         // still connecting
  link.life.move(S.WAITING);
  desktop.session._onControl(link, { t: "accept", batch: "b", files: [] });
  assert.equal(accepted, 1);
});

test("the sender stops when the other side cancels, and shows why", () => {
  const { desktop } = makePair();
  const link = desktop.session._newLink("sender");
  desktop.session.link = link;
  desktop.session._onControl(link, { t: "cancel" });
  assert.equal(link.life.state, S.CANCELLED);
  assert.equal(desktop.session.link, null);
});

// ================================================================ replay and impersonation

async function offerEvent(pair) {
  const sending = pair.desktop.session.send([fileOf("a.txt", randomBytes(100))], pair.phone.id);
  await until(() => OFFER_FROM_DESKTOP(pair.hub).length === 1);
  await sending;
  return OFFER_FROM_DESKTOP(pair.hub)[0].event;
}

test("a replayed offer is ignored: no second connection, no second signature check", async () => {
  const pair = makePair();
  const event = await offerEvent(pair);
  await until(() => pair.phone.ui.receivedInfo);
  const verified = pair.phone.signaling.verifiedOffers;
  await pair.phone.session._onEvent(event);
  await pair.phone.session._onEvent(event);
  assert.equal(pair.phone.signaling.verifiedOffers, verified);
  assert.equal(pair.phone.session.link, null);
});

test("an offer whose signature does not verify is refused and never answered", async () => {
  const pair = makePair();
  pair.phone.signaling.failVerifyOffer = true;
  await pair.desktop.session.send([fileOf("a.txt", randomBytes(100))], pair.phone.id);
  await settle(20);
  assert.equal(pair.phone.session.link, null);
  assert.deepEqual(pair.phone.signaling.pinned, []);
  assert.deepEqual(pair.phone.signaling.closes.map((c) => c.reason), ["error"]);
  assert.deepEqual(pair.phone.sink.opened, []);
});

test("an answer whose signature does not verify ends the connection", async () => {
  const pair = makePair();
  pair.desktop.signaling.failVerifyAnswer = true;
  await pair.desktop.session.send([fileOf("a.txt", randomBytes(100))], pair.phone.id);
  await settle(20);
  assert.equal(pair.desktop.session.link, null);
  assert.equal(pair.desktop.ui.last.kind, "interrupted");
  assert.deepEqual(pair.phone.sink.opened, []);
});

test("an offer from a device that is not one of mine is declined without checking anything", async () => {
  const { phone, desktop } = makePair();
  const stranger = "a1111111-1111-4111-8111-111111111111";
  const id = crypto.randomUUID();
  await phone.session._onEvent({ type: "offer", transferId: id, kind: "files", from: stranger, sdp: "v=0 offer-1 xxxxxxxxxxxxxxxxxxxxxx" });
  assert.deepEqual(phone.signaling.closes, [{ transferId: id, reason: "declined" }]);
  assert.equal(phone.signaling.verifiedOffers, 0);
  assert.equal(phone.session.link, null);
  assert.ok(desktop);
});

test("an offer from another device while a transfer is running is declined, and the running one is untouched", async () => {
  const { phone } = makePair();
  const other = "a2222222-2222-4222-8222-222222222222";
  phone.session.setPeers([...phone.session.peers].map(([id, name]) => ({ id, name })).concat({ id: other, name: "Other PC" }));
  const running = phone.session._newLink("receiver");
  running.peerId = phone.session.peers.keys().next().value;
  phone.session.link = running;
  const id = crypto.randomUUID();
  await phone.session._onEvent({ type: "offer", transferId: id, kind: "files", from: other, sdp: "v=0 offer-1 xxxxxxxxxxxxxxxxxxxxxx" });
  assert.equal(phone.session.link, running);
  assert.equal(running.ended, false);
  assert.deepEqual(phone.signaling.closes, [{ transferId: id, reason: "declined" }]);
});

test("a fresh signed offer from the same device replaces its dead connection (this is how resume works)", async () => {
  const { desktop, phone } = makePair();
  phone.ui.askAccept = () => new Promise(() => {});                 // the first connection is stuck waiting for a tap
  desktop.signaling.close = async () => {};                         // and the old connection is never reported closed
  desktop.session.send([fileOf("a.bin", randomBytes(2000))], phone.id);
  await until(() => phone.session.link && phone.session.link.manifest);
  const old = phone.session.link;

  phone.ui.askAccept = async () => true;
  desktop.session._fail(desktop.session.link, new Error("Wi-Fi dropped"));
  await desktop.session.resume();
  await until(() => phone.ui.receivedInfo);

  assert.equal(old.ended, true);
  assert.equal(old.life.state, S.FAILED);
  assert.equal(phone.signaling.verifiedOffers, 2);
  assert.deepEqual(phone.sink.files.get("a.bin").length, 2000);
});

// ================================================================ resuming is bound to the device that started

async function partialFrom(phone, peerId, bytes) {
  const id = crypto.randomUUID();
  const aborted = [];
  const manifest = { ...manifestFor(id, bytes, "a".repeat(64)), batch: crypto.randomUUID() };
  phone.session.partial = {
    batch: manifest.batch, peerId, manifest, transferId: "old",
    files: new Map([[id, { meta: manifest.files[0], hashes: ["b".repeat(64)], result: null, run: null,
      writer: Promise.resolve({ abort: async () => aborted.push("aborted") }) }]]),
  };
  return { manifest, id, aborted };
}

test("a batch can be resumed by the device that started it", async () => {
  const { phone } = makePair();
  const bytes = randomBytes(10);
  const { manifest } = await partialFrom(phone, "peer-1", bytes);
  const link = phone.session._newLink("receiver");
  link.peerId = "peer-1";
  link.ctl = { sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
  link.transferId = "new";
  phone.session.link = link;
  let asked = 0;
  phone.ui.askAccept = async () => { asked += 1; return true; };
  await phone.session._onManifest(link, manifest);
  assert.equal(asked, 0, "a resume does not ask again");
  assert.equal(link.ctl.sent[0].t, "accept");
  assert.equal(link.ctl.sent[0].files[0].have, 10, "the one verified block is not asked for again");
});

test("another device cannot take over somebody else's partial batch by repeating its id", async () => {
  const { phone } = makePair();
  const bytes = randomBytes(10);
  const { manifest, aborted } = await partialFrom(phone, "peer-1", bytes);
  const link = phone.session._newLink("receiver");
  link.peerId = "peer-2";
  link.ctl = { sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
  link.transferId = "new";
  phone.session.link = link;
  let asked = 0;
  phone.ui.askAccept = async () => { asked += 1; return true; };
  await phone.session._onManifest(link, manifest);
  assert.equal(asked, 1, "it has to be accepted like any new transfer");
  assert.deepEqual(aborted, ["aborted"], "the old partial data is thrown away, not given to the new sender");
  assert.equal(phone.session.partial.peerId, "peer-2");
  assert.equal([...phone.session.partial.files.values()][0].hashes.length, 0);
});

// ================================================================ time: stalls, expiry

test("a transfer that goes silent is ended, and its partial data is cleaned up later", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    const { phone } = makePair();
    const link = phone.session._newLink("receiver");
    link.transferId = crypto.randomUUID();
    link.peerId = "p";
    phone.session.link = link;
    link.life.move(S.WAITING);
    link.life.move(S.TRANSFERRING);
    phone.session._watch(link);

    mock.timers.tick(50_000);
    assert.equal(link.ended, false, "a short silence is fine");
    phone.session._touch(link);
    mock.timers.tick(50_000);
    assert.equal(link.ended, false, "activity resets the clock");
    mock.timers.tick(20_000);
    assert.equal(link.ended, true);
    assert.equal(link.life.state, S.EXPIRED);
    assert.equal(phone.session.link, null);
    assert.deepEqual(phone.signaling.closes.map((c) => c.reason), ["error"]);
  } finally {
    mock.timers.reset();
  }
});

test("an interrupted transfer is forgotten after half an hour, on both devices", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const pair = makePair();
    const { desktop, phone, network } = pair;
    network.tamper = (channel, data) => {
      const msg = parse(data);
      if (msg && msg.t === "ack" && msg.i === 0) setImmediate(() => network.drop());
      return [data];
    };
    await desktop.session.send([fileOf("long.bin", randomBytes(20 * MB))], phone.id);
    await until(() => phone.ui.last && phone.ui.last.title === "Transfer interrupted");
    assert.ok(phone.session.partial);
    assert.ok(desktop.session.outgoing);
    assert.equal(desktop.session.busy, true);

    mock.timers.tick(30 * 60 * 1000 + 1000);
    await settle();
    assert.equal(phone.session.partial, null);
    assert.deepEqual(phone.sink.aborted, ["long.bin"]);
    assert.equal(desktop.session.outgoing, null);
    assert.equal(desktop.session.busy, false);
    assert.ok(phone.ui.hidden >= 1 && desktop.ui.hidden >= 1);
  } finally {
    mock.timers.reset();
  }
});

test("stopping the session cleans everything up and is safe to repeat", async () => {
  const pair = makePair();
  const { desktop, phone } = pair;
  phone.ui.askAccept = async () => true;
  pair.network.tamper = (channel, data) => {
    const msg = parse(data);
    if (msg && msg.t === "ack" && msg.i === 0) setImmediate(() => phone.session.stop());
    return [data];
  };
  desktop.session.send([fileOf("long.bin", randomBytes(20 * MB))], phone.id).catch(() => {});
  await until(() => phone.session.link === null && phone.session.partial === null && phone.sink.aborted.length === 1);
  phone.session.stop();
  phone.session.stop();
  assert.equal(phone.sink.aborted.length, 1);
  desktop.session.stop();
  assert.equal(desktop.session.outgoing, null);
});

test("a transfer cannot be started while another one is open, or to a device that is not paired", async () => {
  const { desktop, phone } = makePair();
  await assert.rejects(desktop.session.send([fileOf("a", randomBytes(5))], "nobody"), /No device to send to/);
  desktop.session.outgoing = {};
  await assert.rejects(desktop.session.send([fileOf("a", randomBytes(5))], phone.id), /already in progress/);
});

test("resume does nothing when there is nothing to resume or a connection is open", async () => {
  const { desktop } = makePair();
  await desktop.session.resume();
  desktop.session.outgoing = { expiry: null };
  desktop.session.link = {};
  await desktop.session.resume();
  assert.equal(desktop.signaling.sentOffers.length, 0);
});

test("a connection that never opens is ended with a clear message", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop, phone, network } = makePair();
    network.RTC.prototype.createDataChannel = (label) => ({ label, readyState: "connecting", addEventListener() {}, close() {} });
    const sending = desktop.session.send([fileOf("a", randomBytes(5))], phone.id);
    await until(() => desktop.signaling.sentOffers.length === 1);
    await settle(10);
    mock.timers.tick(31_000);
    await sending;
    assert.match(desktop.ui.last.detail, /Could not connect/);
    assert.equal(desktop.session.link, null);
  } finally {
    mock.timers.reset();
  }
});