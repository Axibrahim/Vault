import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TEXT_CHARS, TextSync, parseTextMessage, wins } from "../../static/js/transfer/text.js";

const msg = (rev, body) => JSON.stringify({ t: "text", rev, body });

test("a text message must be exactly the expected shape", () => {
  assert.deepEqual(parseTextMessage(msg(3, "hi")), { rev: 3, body: "hi" });
  assert.deepEqual(parseTextMessage(msg(0, "")), { rev: 0, body: "" });
  for (const bad of [
    undefined, 5, "{}", "null", "[]", "not json",
    JSON.stringify({ t: "other", rev: 1, body: "x" }),
    JSON.stringify({ t: "text", rev: -1, body: "x" }),
    JSON.stringify({ t: "text", rev: 1.5, body: "x" }),
    JSON.stringify({ t: "text", rev: 2 ** 40, body: "x" }),
    JSON.stringify({ t: "text", rev: "1", body: "x" }),
    JSON.stringify({ t: "text", rev: 1, body: 7 }),
    JSON.stringify({ t: "text", rev: 1 }),
    msg(1, "x".repeat(MAX_TEXT_CHARS + 1)),
  ]) assert.throws(() => parseTextMessage(bad));
  assert.doesNotThrow(() => parseTextMessage(msg(1, "x".repeat(MAX_TEXT_CHARS))));
});

test("the newer version wins; on a tie the larger device id wins", () => {
  assert.ok(wins({ rev: 2, from: "a" }, { rev: 1, from: "z" }));
  assert.ok(!wins({ rev: 1, from: "z" }, { rev: 2, from: "a" }));
  assert.ok(wins({ rev: 1, from: "b" }, { rev: 1, from: "a" }));
  assert.ok(!wins({ rev: 1, from: "a" }, { rev: 1, from: "b" }));
  assert.ok(!wins({ rev: 1, from: "a" }, { rev: 1, from: "a" }));
});

function pair() {
  const a = { texts: [], states: [], wire: [] };
  const b = { texts: [], states: [], wire: [] };
  a.sync = new TextSync("a-device", { onText: (t) => a.texts.push(t), onStatus: (s) => a.states.push(s) });
  b.sync = new TextSync("b-device", { onText: (t) => b.texts.push(t), onStatus: (s) => b.states.push(s) });
  const flush = (from, to) => { for (const m of from.wire.splice(0)) to.sync.receive(JSON.stringify(m)); };
  const join = () => {
    a.sync.attach("b-device", (m) => a.wire.push(m));
    b.sync.attach("a-device", (m) => b.wire.push(m));
  };
  return { a, b, flush, join };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("typing on one device appears on the other", async () => {
  const { a, b, flush, join } = pair();
  join();
  a.wire.length = 0; b.wire.length = 0;
  a.sync.edit("https://example.com/a?b=c");
  await wait(250);
  flush(a, b);
  assert.deepEqual(b.texts, ["https://example.com/a?b=c"]);
  b.sync.edit("reply");
  await wait(250);
  flush(b, a);
  assert.deepEqual(a.texts, ["reply"]);
});

test("a burst of typing is sent as one message", async () => {
  const { a, join } = pair();
  join();
  a.wire.length = 0;
  for (const text of ["h", "he", "hel", "hell", "hello"]) a.sync.edit(text);
  await wait(250);
  assert.equal(a.wire.length, 1);
  assert.equal(a.wire[0].body, "hello");
});

test("two devices typing at the same moment end up with the same text", async () => {
  const { a, b, flush, join } = pair();
  join();
  a.wire.length = 0; b.wire.length = 0;
  a.sync.edit("from a");
  b.sync.edit("from b");
  await wait(250);
  flush(a, b);
  flush(b, a);
  assert.equal(a.sync.doc.body, b.sync.doc.body);
  assert.equal(a.sync.doc.body, "from b");                    // same revision: the larger device id wins
});

test("a newer local edit is not overwritten by an older remote one", async () => {
  const { a, b, flush, join } = pair();
  join();
  a.wire.length = 0; b.wire.length = 0;
  a.sync.edit("one");
  a.sync.edit("two");
  b.sync.edit("old");
  await wait(250);
  flush(b, a);
  assert.equal(a.sync.doc.body, "two");
  assert.deepEqual(a.texts, []);
});

test("a device that joins later receives the current text", async () => {
  const { a, b, flush } = pair();
  a.sync.edit("written while alone");
  a.sync.attach("b-device", (m) => a.wire.push(m));
  b.sync.attach("a-device", (m) => b.wire.push(m));
  flush(a, b);
  assert.deepEqual(b.texts, ["written while alone"]);
});

test("editing with no link keeps the text and sends it when a link appears", async () => {
  const { a, b, flush } = pair();
  a.sync.edit("offline note");
  await wait(250);
  assert.equal(a.wire.length, 0);
  a.sync.attach("b-device", (m) => a.wire.push(m));
  b.sync.attach("a-device", (m) => b.wire.push(m));
  flush(a, b);
  assert.deepEqual(b.texts, ["offline note"]);
});

test("nothing is accepted or sent once the link is gone", async () => {
  const { a, b, flush, join } = pair();
  join();
  a.wire.length = 0; b.wire.length = 0;
  b.sync.detach();
  a.sync.edit("late");
  await wait(250);
  flush(a, b);                                                   // late data from the old link
  assert.deepEqual(b.texts, []);
  b.sync.edit("typed after the link ended");
  await wait(250);
  assert.equal(b.wire.length, 0);
});

test("detaching cancels a message that was waiting to be sent", async () => {
  const { a, join } = pair();
  join();
  a.wire.length = 0;
  a.sync.edit("never sent");
  a.sync.detach();
  await wait(250);
  assert.equal(a.wire.length, 0);
});

test("text is cut to the limit and unchanged text is not resent", async () => {
  const { a, join } = pair();
  join();
  a.wire.length = 0;
  a.sync.edit("x".repeat(MAX_TEXT_CHARS + 50));
  assert.equal(a.sync.doc.body.length, MAX_TEXT_CHARS);
  await wait(250);
  a.wire.length = 0;
  a.sync.edit("x".repeat(MAX_TEXT_CHARS + 50));
  await wait(250);
  assert.equal(a.wire.length, 0);
});

test("garbage from the other device throws, so the link can be cut", () => {
  const { b, join } = pair();
  join();
  assert.throws(() => b.sync.receive("{{{"));
  assert.throws(() => b.sync.receive(msg(1, "x".repeat(MAX_TEXT_CHARS + 1))));
  assert.throws(() => b.sync.receive(new ArrayBuffer(8)));
});

test("a flood of messages throws, and the limit applies per second", () => {
  let now = 1000;
  const sync = new TextSync("me", { now: () => now });
  sync.attach("peer", () => {});
  for (let i = 0; i < 40; i += 1) sync.receive(msg(i + 1, "x"));
  assert.throws(() => sync.receive(msg(99, "x")), /Too many messages/);
  now += 1500;
  assert.doesNotThrow(() => sync.receive(msg(100, "ok")));
});

test("status changes are reported once", () => {
  const states = [];
  const sync = new TextSync("me", { onStatus: (s) => states.push(s) });
  sync.setStatus("connecting");
  sync.setStatus("connecting");
  sync.attach("peer", () => {});
  sync.detach();
  sync.setStatus("offline");
  assert.deepEqual(states, ["connecting", "live", "offline"]);
});