// The shared text box, end to end: a real signed connection between two sessions.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fileOf, makePair, randomBytes, settle, until } from "./harness.mjs";
import { MAX_TEXT_CHARS } from "../../static/js/transfer/text.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const live = (side) => side.ui.textStates.at(-1) === "live";

async function connected() {
  const pair = makePair();
  pair.desktop.session.syncText(pair.phone.id, true);
  await until(() => live(pair.desktop) && live(pair.phone));
  return pair;
}

test("the computer opens a signed text link to the phone while the phone is online", async () => {
  const { desktop, phone } = await connected();
  assert.equal(desktop.signaling.sentOffers.length, 1);
  assert.equal(desktop.signaling.sentOffers[0].kind, "clip");
  assert.equal(phone.signaling.verifiedOffers, 1, "the phone checked the signature of the text link too");
  assert.deepEqual(phone.signaling.pinned, [[desktop.id, "AAAA-BBBB-CCCC"]]);
  assert.equal(desktop.session.busy, false, "the text link is not a file transfer");
  assert.equal(phone.session.busy, false);
});

test("the phone never dials: only the computer does", async () => {
  const { phone, desktop } = makePair();
  phone.session.syncText(desktop.id, true);
  await settle(10);
  assert.equal(phone.signaling.sentOffers.length, 0);
});

test("nothing is dialled for an offline device, an unknown device, or twice", async () => {
  const { desktop, phone } = makePair();
  desktop.session.syncText(phone.id, false);
  desktop.session.syncText("nobody", true);
  desktop.session.syncText(null, false);
  await settle(10);
  assert.equal(desktop.signaling.sentOffers.length, 0);
  desktop.session.syncText(phone.id, true);
  desktop.session.syncText(phone.id, true);
  await until(() => live(desktop));
  assert.equal(desktop.signaling.sentOffers.length, 1);
});

test("text typed on either device shows up on the other", async () => {
  const { desktop, phone } = await connected();
  desktop.session.setText("https://example.com/long/link?x=1");
  await until(() => phone.ui.text === "https://example.com/long/link?x=1");
  phone.session.setText("thanks, got it");
  await until(() => desktop.ui.text === "thanks, got it");
});

test("both devices typing at once end up with the same text", async () => {
  const { desktop, phone } = await connected();
  desktop.session.setText("from the computer");
  phone.session.setText("from the phone");
  await until(() => desktop.session.text.doc.body === phone.session.text.doc.body && desktop.session.text.doc.rev >= 1);
  await wait(300);
  assert.equal(desktop.session.text.doc.body, phone.session.text.doc.body);
});

test("text written before the link existed is delivered when it comes up", async () => {
  const pair = makePair();
  pair.desktop.session.setText("written first");
  pair.desktop.session.syncText(pair.phone.id, true);
  await until(() => pair.phone.ui.text === "written first");
});

test("files can be sent while the text link is open", async () => {
  const { desktop, phone } = await connected();
  const bytes = randomBytes(300_000);
  await desktop.session.send([fileOf("with-text.bin", bytes)], phone.id);
  await until(() => phone.ui.receivedInfo);
  assert.deepEqual(phone.sink.files.get("with-text.bin"), bytes);
  assert.ok(live(desktop) && live(phone), "the text link survived the transfer");
});

test("a text link carries exactly one channel", async () => {
  const { phone } = await connected();
  const extra = { label: `f:${crypto.randomUUID()}`, closed: false, close() { this.closed = true; } };
  phone.session._onChannel(phone.session.clip, extra);
  assert.equal(extra.closed, true);
  const second = { label: "txt", closed: false, close() { this.closed = true; } };
  phone.session._onChannel(phone.session.clip, second);
  assert.equal(second.closed, true);
});

test("an oversized or malformed message cuts the link, changes nothing, and the computer reconnects with a new signature", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop, phone } = await connected();
    desktop.session.clip.ctl.send(JSON.stringify({ t: "text", rev: 5, body: "x".repeat(MAX_TEXT_CHARS + 1) }));
    await until(() => phone.session.clip === null);
    assert.equal(phone.ui.text, "");
    assert.equal(phone.ui.textStates.at(-1), "offline");
    await until(() => desktop.session.clip === null);

    mock.timers.tick(2100);                                   // the first retry
    await until(() => desktop.signaling.sentOffers.length === 2);
    await until(() => live(desktop) && live(phone));
    assert.equal(phone.signaling.verifiedOffers, 2);
  } finally {
    mock.timers.reset();
  }
});

test("garbage, binary data and floods are cut off", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const attack of [
      (ch) => ch.send("{{{ not json"),
      (ch) => ch.send(new Uint8Array([1, 2, 3])),
      (ch) => { for (let i = 1; i <= 60; i += 1) ch.send(JSON.stringify({ t: "text", rev: i, body: "spam" })); },
    ]) {
      const { desktop, phone } = await connected();
      attack(desktop.session.clip.ctl);
      await until(() => phone.session.clip === null);
      assert.equal(phone.ui.textStates.at(-1), "offline");
      desktop.session.stop();
    }
  } finally {
    mock.timers.reset();
  }
});

test("late text after the link ended is never accepted", async () => {
  const { desktop, phone } = await connected();
  const channel = phone.session.clip.ctl;
  phone.session._fail(phone.session.clip, new Error("gone"));
  channel._emit("message", { data: JSON.stringify({ t: "text", rev: 99, body: "late" }) });
  phone.session.text.receive(JSON.stringify({ t: "text", rev: 99, body: "late" }));
  assert.equal(phone.ui.text, "");
  assert.ok(desktop);
});

test("choosing another device, or none, closes the old text link", async () => {
  const { desktop, phone } = await connected();
  desktop.session.syncText(null, false);
  assert.equal(desktop.session.clip, null);
  await until(() => phone.session.clip === null);
  assert.equal(desktop.signaling.closes.at(-1).reason, "error");
  assert.equal(phone.ui.textStates.at(-1), "offline");
});

test("removing the phone (a 'revoked' notice from the server) ends the link without a retry storm", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop } = await connected();
    const id = desktop.session.clip.transferId;
    const closesBefore = desktop.signaling.closes.length;
    await desktop.session._onEvent({ type: "closed", transferId: id, reason: "revoked" });
    assert.equal(desktop.session.clip, null);
    assert.equal(desktop.signaling.closes.length, closesBefore, "the server already knows, so it is not told again");

    desktop.session.syncText(desktop.session.wantText.peerId, false);          // the phone is now offline
    mock.timers.tick(60_000);
    await settle(10);
    assert.equal(desktop.signaling.sentOffers.length, 1, "no new connection is made for an offline device");
  } finally {
    mock.timers.reset();
  }
});

test("a text link is replaced by a freshly authenticated one after six hours", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop, phone } = await connected();
    mock.timers.tick(6 * 60 * 60 * 1000 + 1);
    await until(() => desktop.session.clip === null);
    mock.timers.tick(2100);
    await until(() => desktop.signaling.sentOffers.length === 2);
    await until(() => live(desktop) && live(phone));
    assert.equal(phone.signaling.verifiedOffers, 2);
  } finally {
    mock.timers.reset();
  }
});

test("the retry delay grows and a successful link resets it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop, phone, network } = makePair();
    phone.signaling.failVerifyOffer = true;                      // the phone refuses every text link
    desktop.session.syncText(phone.id, true);
    for (const [expected, wait_] of [[1, 0], [2, 2100], [3, 5100], [4, 15_100], [5, 30_100], [6, 30_100]]) {
      if (wait_) mock.timers.tick(wait_);
      await until(() => desktop.signaling.sentOffers.length === expected);
      await until(() => desktop.session.clip === null);
    }
    phone.signaling.failVerifyOffer = false;
    mock.timers.tick(30_100);
    await until(() => live(desktop) && live(phone));
    assert.equal(desktop.session.textTries, 0);
    assert.ok(network);
  } finally {
    mock.timers.reset();
  }
});

test("a replayed text offer is ignored, and a stranger's text offer is declined", async () => {
  const { desktop, phone, hub } = await connected();
  const offer = hub.delivered.find((d) => d.event.type === "offer").event;
  const verified = phone.signaling.verifiedOffers;
  await phone.session._onEvent(offer);
  assert.equal(phone.signaling.verifiedOffers, verified);

  const id = crypto.randomUUID();
  await phone.session._onEvent({ type: "offer", transferId: id, kind: "clip", from: "a9999999-9999-4999-8999-999999999999", sdp: "v=0 offer-1 xxxxxxxxxxxxxxxxxxxxxx" });
  assert.deepEqual(phone.signaling.closes.at(-1), { transferId: id, reason: "declined" });
  assert.ok(desktop);
});

test("a second text offer from another device does not replace a live link", async () => {
  const { phone } = await connected();
  const other = "a8888888-8888-4888-8888-888888888888";
  phone.session.setPeers([{ id: other, name: "Other PC" }, ...[...phone.session.peers].map(([id, name]) => ({ id, name }))]);
  const live_ = phone.session.clip;
  const id = crypto.randomUUID();
  await phone.session._onEvent({ type: "offer", transferId: id, kind: "clip", from: other, sdp: "v=0 offer-1 xxxxxxxxxxxxxxxxxxxxxx" });
  assert.equal(phone.session.clip, live_);
  assert.equal(live_.ended, false);
});

test("a new text offer from the same computer replaces the old link", async () => {
  const { desktop, phone } = await connected();
  const old = phone.session.clip;
  desktop.session._fail(desktop.session.clip, new Error("blip"));        // the phone has not noticed yet
  desktop.session.syncText(phone.id, true);
  desktop.session.textRetry && clearTimeout(desktop.session.textRetry);
  desktop.session.textRetry = null;
  desktop.session.syncText(phone.id, true);
  await until(() => phone.session.clip && phone.session.clip !== old && live(phone));
  assert.equal(old.ended, true);
});

test("stopping the session closes the text link and stops reconnecting", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop, phone } = await connected();
    desktop.session.stop();
    assert.equal(desktop.session.clip, null);
    mock.timers.tick(60_000);
    await settle(10);
    assert.equal(desktop.signaling.sentOffers.length, 1);
    await until(() => phone.session.clip === null);
  } finally {
    mock.timers.reset();
  }
});

test("the text can be cleared on both devices", async () => {
  const { desktop, phone } = await connected();
  desktop.session.setText("secret");
  await until(() => phone.ui.text === "secret");
  desktop.session.setText("");
  await until(() => phone.ui.text === "");
});

test("a text link that never opens is ended and retried", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { desktop, phone, network } = makePair();
    network.RTC.prototype.createDataChannel = (label) => ({ label, readyState: "connecting", addEventListener() {}, close() {} });
    desktop.session.syncText(phone.id, true);
    await until(() => desktop.signaling.sentOffers.length === 1);
    await settle(10);
    mock.timers.tick(31_000);
    await until(() => desktop.session.clip === null);
    assert.equal(desktop.ui.textStates.at(-1), "offline");
  } finally {
    mock.timers.reset();
  }
});