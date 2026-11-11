import test from "node:test";
import assert from "node:assert/strict";

import {
  describeDevice, describeTransfer, fullTime, initialOf, relativeTime, removalWarning, summarizeActivity,
} from "../../static/js/ui/settings-format.js";
import { connectionAdvice, hasRelay } from "../../static/js/transfer/protocol.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

test("the badge shows the first letter of the email, or a question mark", () => {
  assert.equal(initialOf("eliza@example.com"), "E");
  assert.equal(initialOf("  bahz@example.com"), "B");
  assert.equal(initialOf(""), "?");
  assert.equal(initialOf(null), "?");
});

test("times are shown the way people say them", () => {
  assert.equal(relativeTime(ago(5), NOW), "just now");
  assert.equal(relativeTime(ago(50), NOW), "1 min ago");
  assert.equal(relativeTime(ago(600), NOW), "10 min ago");
  assert.equal(relativeTime(ago(7200), NOW), "2 h ago");
  assert.equal(relativeTime(ago(3 * 86_400), NOW), "3 d ago");
  assert.equal(relativeTime(ago(30 * 86_400), NOW), new Date(NOW - 30 * 86_400_000).toLocaleDateString([], { dateStyle: "medium" }));
  assert.equal(relativeTime(null, NOW), "unknown");
  assert.equal(relativeTime(new Date(NOW + 60_000).toISOString(), NOW), "just now");   // clocks can differ a little
});

test("full times fall back to unknown", () => {
  assert.equal(fullTime(null), "unknown");
  assert.match(fullTime("2026-11-11T12:00:00Z"), /2026/);
});

test("a device row says what it is and whether it is this one", () => {
  const phone = { id: "p1", type: "phone", name: "My phone", createdAt: ago(7200), fingerprint: "AAAA-BBBB-CCCC" };
  assert.deepEqual(describeDevice(phone, "p1", NOW), {
    name: "My phone", kind: "Phone", mine: true, added: "Added 2 h ago", fingerprint: "AAAA-BBBB-CCCC",
  });
  const pc = { id: "c1", type: "desktop", name: "Home PC", createdAt: null, fingerprint: "DDDD-EEEE-FFFF" };
  const row = describeDevice(pc, "p1", NOW);
  assert.equal(row.kind, "Computer");
  assert.equal(row.mine, false);
  assert.equal(row.added, "Added unknown");
});

test("the remove question matches what will happen", () => {
  const pc = { type: "desktop", name: "Home PC" };
  const phone = { type: "phone", name: "My phone" };
  assert.match(removalWarning(pc, true, false), /Remove this computer\?/);
  assert.match(removalWarning(phone, true, false), /Remove this phone\?/);
  assert.match(removalWarning(pc, false, true), /last computer.*removes your phones/);
  assert.match(removalWarning(pc, false, false), /Remove Home PC\?/);
  assert.match(removalWarning(phone, false, true), /Remove My phone\?/);   // only a computer drags phones along
});

test("the activity summary adds up sent and received", () => {
  assert.equal(summarizeActivity([], "me"), "No transfers in the last 30 days.");
  const items = [
    { fromId: "me", bytes: 2_000_000 },
    { fromId: "other", bytes: 500_000 },
    { fromId: "me", bytes: 1_000_000 },
  ];
  assert.equal(summarizeActivity(items, "me"), "3 transfers in the last 30 days: 3.0 MB sent, 500 KB received.");
  assert.equal(summarizeActivity(items.slice(0, 1), "me"), "1 transfer in the last 30 days: 2.0 MB sent, 0 B received.");
  assert.equal(summarizeActivity(items, null), "3 transfers in the last 30 days.");
});

test("a history row says who sent it, even when this browser is not a device", () => {
  const item = { fromId: "c1", fromName: "Home PC", toId: "p1", toName: "My phone", files: 2, bytes: 1500 };
  assert.equal(describeTransfer(item, "c1").title, "Sent to My phone");
  assert.equal(describeTransfer(item, "p1").title, "Received from Home PC");
  assert.equal(describeTransfer(item, null).title, "Home PC to My phone");
  assert.match(describeTransfer(item, "c1").detail, /^2 files/);
});

test("relay servers are spotted, and the advice changes with them", () => {
  assert.equal(hasRelay([{ urls: ["stun:a:3478"] }]), false);
  assert.equal(hasRelay([]), false);
  assert.equal(hasRelay([{ urls: "turn:a:3478" }]), true);
  assert.equal(hasRelay([{ urls: ["stun:a", "turns:b:443?transport=tcp"] }]), true);
  assert.match(connectionAdvice(true), /open on both devices/);
  assert.match(connectionAdvice(false), /no relay server/);
});