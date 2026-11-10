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