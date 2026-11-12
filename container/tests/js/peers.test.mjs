import test from "node:test";
import assert from "node:assert/strict";

import { issueFor, sessionSummary, stateOf } from "../../static/js/ui/peers.js";

const pc = { id: "c1", name: "Home PC" };

test("a device that is not in the presence list is offline", () => {
  assert.equal(stateOf({}, "c1"), "offline");
  assert.equal(stateOf({ c1: "ready" }, "c1"), "ready");
});

test("every problem has its own sentence, and a ready device has none", () => {
  assert.equal(issueFor(pc, "ready"), null);
  assert.match(issueFor(pc, "offline"), /Home PC is offline/);
  assert.match(issueFor(pc, "busy"), /busy/);
  assert.match(issueFor(pc, "blocked"), /Allow folder access/);
});

test("the session is green only when both sides are ready", () => {
  const ok = sessionSummary({ role: "phone", peer: pc, peerState: "ready", ownState: "ready" });
  assert.deepEqual(ok, { state: "ready", text: "Session active with Home PC" });

  assert.equal(sessionSummary({ role: "phone", peer: pc, peerState: "offline", ownState: "ready" }).state, "offline");
  assert.equal(sessionSummary({ role: "phone", peer: pc, peerState: "blocked", ownState: "ready" }).state, "blocked");
  assert.equal(sessionSummary({ role: "desktop", peer: pc, peerState: "ready", ownState: "blocked" }).state, "blocked");
  assert.equal(sessionSummary({ role: "desktop", peer: pc, peerState: "ready", ownState: "busy" }).state, "busy");
});

test("with nobody to talk to the session is red and says what to do", () => {
  assert.equal(sessionSummary({ role: "desktop", peer: null, peerState: "offline", ownState: "ready" }).text, "No phone paired yet");
  assert.equal(sessionSummary({ role: "phone", peer: null, peerState: "offline", ownState: "ready" }).text, "No computer set up yet");
});
// ---------------------------------------------------------------- dropping files onto the page

import { dropState } from "../../static/js/ui/peers.js";

const phone = { id: "p1", name: "My phone" };
const ready = { role: "desktop", peer: phone, peerState: "ready", ownState: "ready", busy: false };

test("a file may be dropped only when the session is ready", () => {
  assert.deepEqual(dropState(ready), { ok: true, message: "Drop to send to My phone" });
});

test("every reason a drop is refused has its own sentence", () => {
  assert.equal(dropState({ ...ready, role: "phone" }).ok, false);
  assert.match(dropState({ ...ready, role: "phone" }).message, /from your computer/);
  assert.match(dropState({ ...ready, peer: null }).message, /Pair a phone/);
  assert.match(dropState({ ...ready, busy: true }).message, /Wait for the current transfer/);
  assert.match(dropState({ ...ready, ownState: "busy" }).message, /Wait for the current transfer/);
  assert.match(dropState({ ...ready, ownState: "blocked" }).message, /Allow folder access/);
  assert.match(dropState({ ...ready, peerState: "offline" }).message, /offline/);
  assert.match(dropState({ ...ready, peerState: "busy" }).message, /busy/);
  assert.match(dropState({ ...ready, peerState: "blocked" }).message, /cannot receive yet/);
  for (const peerState of ["offline", "busy", "blocked"]) assert.equal(dropState({ ...ready, peerState }).ok, false);
});