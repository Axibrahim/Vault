import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  integrityError, readBlock, scanFile, sha256Hex, treeDigest, verifyStoredFile,
} from "../../static/js/transfer/blocks.js";
import { BLOCK_SIZE, parseControl, parseFileMessage, validateManifest } from "../../static/js/transfer/protocol.js";
import { receiveFile } from "../../static/js/transfer/receiver.js";
import { sendFile } from "../../static/js/transfer/sender.js";
import { FakeChannel, randomBytes, settle, until } from "./harness.mjs";

const MB = 1024 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const UUID = "0b5d9f0e-6d3a-4c8e-9a53-1c7f5a1e2b3c";
const FILE_ID = "1b5d9f0e-6d3a-4c8e-9a53-1c7f5a1e2b3d";

// ---------------------------------------------------------------- the digest

test("the digest of a file is SHA-256 over the SHA-256 of each block", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 1000);
  const { hashes, digest } = await scanFile(new Blob([bytes]));
  assert.deepEqual(hashes, [sha(bytes.subarray(0, BLOCK_SIZE)), sha(bytes.subarray(BLOCK_SIZE))]);
  const joined = Buffer.concat(hashes.map((h) => Buffer.from(h, "hex")));
  assert.equal(digest, sha(joined));
});

test("an empty file has no blocks and the SHA-256 of nothing", async () => {
  const { hashes, digest } = await scanFile(new Blob([]));
  assert.deepEqual(hashes, []);
  assert.equal(digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("changing one single byte changes the digest", async () => {
  const bytes = randomBytes(BLOCK_SIZE * 2 + 5);
  const before = (await scanFile(new Blob([bytes]))).digest;
  bytes[BLOCK_SIZE + 77] ^= 1;
  assert.notEqual((await scanFile(new Blob([bytes]))).digest, before);
});

test("swapping two blocks changes the digest (the order matters)", async () => {
  const a = randomBytes(BLOCK_SIZE);
  const b = randomBytes(BLOCK_SIZE);
  const one = await scanFile(new Blob([a, b]));
  const two = await scanFile(new Blob([b, a]));
  assert.notEqual(one.digest, two.digest);
});

test("treeDigest refuses a missing or malformed block hash", async () => {
  await assert.rejects(() => treeDigest([undefined]), (e) => e.integrity === true);
  await assert.rejects(() => treeDigest(["abc"]), (e) => e.integrity === true);
  await assert.rejects(() => treeDigest([sha("a"), , sha("b")]), (e) => e.integrity === true);   // eslint-disable-line no-sparse-arrays
});

test("scanFile can be cancelled and reports progress", async () => {
  const controller = new AbortController();
  let progress = 0;
  const bytes = randomBytes(BLOCK_SIZE * 2);
  await scanFile(new Blob([bytes]), { onBytes: (n) => { progress += n; } });
  assert.equal(progress, bytes.length);
  controller.abort();
  await assert.rejects(() => scanFile(new Blob([bytes]), { signal: controller.signal }), /Cancelled/);
});

test("readBlock returns the bytes and their hash", async () => {
  const bytes = randomBytes(1234);
  const block = await readBlock(new Blob([bytes]), 0);
  assert.equal(block.hash, sha(bytes));
  assert.equal(block.hash, await sha256Hex(bytes));
});

// ---------------------------------------------------------------- reading a saved file back

test("a saved file that matches passes the read-back check", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 10);
  const { hashes } = await scanFile(new Blob([bytes]));
  const seen = [];
  await verifyStoredFile(new Blob([bytes]), bytes.length, hashes, { onBlock: (i) => seen.push(i) });
  assert.deepEqual(seen, [0, 1]);
});

test("a saved file with a damaged byte, the wrong size or missing blocks is rejected", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 10);
  const { hashes } = await scanFile(new Blob([bytes]));

  const damaged = bytes.slice();
  damaged[BLOCK_SIZE + 3] ^= 0x10;
  await assert.rejects(() => verifyStoredFile(new Blob([damaged]), bytes.length, hashes), (e) => e.integrity && /does not match/.test(e.message));
  await assert.rejects(() => verifyStoredFile(new Blob([bytes.subarray(0, 100)]), bytes.length, hashes), (e) => e.integrity && /wrong size/.test(e.message));
  await assert.rejects(() => verifyStoredFile(new Blob([bytes]), bytes.length, hashes.slice(0, 1)), (e) => e.integrity && /incomplete/.test(e.message));
});

test("integrityError marks the error", () => {
  assert.equal(integrityError("x").integrity, true);
});

// ---------------------------------------------------------------- the file list and the new messages

const entry = (extra = {}) => ({ id: FILE_ID, name: "a.txt", size: 5, type: "text/plain", digest: "a".repeat(64), ...extra });

test("the file list must carry a SHA-256 digest for every file", () => {
  const manifest = validateManifest({ batch: UUID, files: [entry()] });
  assert.equal(manifest.files[0].digest, "a".repeat(64));
  for (const digest of [undefined, null, "", "A".repeat(64), "a".repeat(63), "g".repeat(64), 12]) {
    assert.throws(() => validateManifest({ batch: UUID, files: [entry({ digest })] }), /Bad file digest/);
  }
});

test("parseControl keeps the digest of each file", () => {
  const msg = parseControl(JSON.stringify({ t: "manifest", batch: UUID, files: [entry()] }));
  assert.equal(msg.files[0].digest, "a".repeat(64));
});

test("the verify keep-alive message is understood and validated", () => {
  assert.deepEqual(parseFileMessage('{"t":"verify","i":3}'), { t: "verify", i: 3 });
  assert.throws(() => parseFileMessage('{"t":"verify","i":-1}'), /Bad verify/);
  assert.throws(() => parseFileMessage('{"t":"verify"}'), /Bad verify/);
});

// ---------------------------------------------------------------- sender and receiver, wired straight together

function wire() {
  const network = { tamper: null };
  const sending = new FakeChannel("f:" + FILE_ID);
  const receiving = new FakeChannel("f:" + FILE_ID);
  sending.peer = receiving;
  receiving.peer = sending;
  sending.network = receiving.network = network;
  sending.open();
  receiving.open();
  return { network, sending, receiving };
}

function memoryWriter(size, { corrupt = false } = {}) {
  const store = new Uint8Array(size);
  const log = { writes: [], finished: false, aborted: false };
  return {
    log,
    store,
    writeBlock: async (index, bytes) => {
      log.writes.push(index);
      const copy = bytes.slice();
      if (corrupt) copy[0] ^= 1;
      store.set(copy, index * BLOCK_SIZE);
    },
    finish: async (hashes) => {
      await verifyStoredFile(new Blob([store]), size, hashes);
      log.finished = true;
      return { name: "x" };
    },
    abort: async () => { log.aborted = true; },
  };
}

async function setup(bytes, { corrupt = false, digest, active } = {}) {
  const scan = await scanFile(new Blob([bytes]));
  const channels = wire();
  const writer = memoryWriter(bytes.length, { corrupt });
  const hashes = [];
  const received = receiveFile(channels.receiving, {
    meta: { size: bytes.length, digest: digest ?? scan.digest }, writer, hashes, active,
  });
  received.catch(() => {});
  const sent = (overrides = {}) => sendFile(channels.sending, new Blob([bytes]), { hashes: scan.hashes, ...overrides });
  return { ...channels, writer, hashes, received, sent, scan };
}

test("a file sent through sender and receiver arrives complete and verified", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 4321);
  const t = await setup(bytes);
  await t.sent();
  await t.received;
  assert.deepEqual(t.writer.store, bytes);
  assert.deepEqual(t.hashes, t.scan.hashes);
  assert.ok(t.writer.log.finished);
});

test("the receiver says done only after the saved file passed its check", async () => {
  const bytes = randomBytes(2000);
  const t = await setup(bytes);
  const order = [];
  const finish = t.writer.finish;
  t.writer.finish = async (h) => { const r = await finish(h); order.push("verified"); return r; };
  const send = t.receiving.send.bind(t.receiving);
  t.receiving.send = (data) => { if (typeof data === "string" && data.includes('"done"')) order.push("done"); send(data); };
  await t.sent();
  await t.received;
  assert.deepEqual(order, ["verified", "done"]);
});

test("a block with one flipped byte is rejected and never written", async () => {
  const bytes = randomBytes(3000);
  const t = await setup(bytes);
  let flipped = false;
  t.network.tamper = (channel, data) => {
    if (typeof data !== "string" && !flipped) { new Uint8Array(data)[5] ^= 1; flipped = true; }
    return [data];
  };
  await assert.rejects(t.sent(), /damaged file/);
  await assert.rejects(t.received, (e) => e.integrity === true);
  assert.deepEqual(t.writer.log.writes, []);
  assert.equal(t.writer.log.finished, false);
});

test("a repeated chunk is rejected", async () => {
  const bytes = randomBytes(300_000);
  const t = await setup(bytes);
  let count = 0;
  t.network.tamper = (channel, data) => (typeof data !== "string" && (count += 1) === 2 ? [data, data] : [data]);
  await assert.rejects(t.sent());
  await assert.rejects(t.received);
  assert.equal(t.writer.log.finished, false);
});

test("a missing chunk is rejected", async () => {
  const bytes = randomBytes(300_000);
  const t = await setup(bytes);
  let count = 0;
  t.network.tamper = (channel, data) => (typeof data !== "string" && (count += 1) === 2 ? [] : [data]);
  await assert.rejects(t.sent());
  await assert.rejects(t.received, /out of order/);
  assert.equal(t.writer.log.finished, false);
});

test("a repeated block message is rejected", async () => {
  const bytes = randomBytes(2000);
  const t = await setup(bytes);
  t.network.tamper = (channel, data) => (typeof data === "string" && data.includes('"block"') ? [data, data] : [data]);
  await assert.rejects(t.sent());
  await assert.rejects(t.received);
  assert.equal(t.writer.log.finished, false);
});

test("blocks arriving out of order are rejected", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 10);
  const t = await setup(bytes);
  t.network.tamper = (channel, data) => (typeof data === "string" && data.includes('"i":0') && data.includes('"block"')
    ? [data.replace('"i":0', '"i":1')] : [data]);
  await assert.rejects(t.sent());
  await assert.rejects(t.received, /out of order/);
});

test("a file that ends early is rejected", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 10);
  const t = await setup(bytes);
  t.network.tamper = (channel, data) => (typeof data === "string" && data.includes('"block"') && data.includes('"i":1') ? [] : [data]);
  await assert.rejects(t.sent());
  await assert.rejects(t.received, /ended early/);
});

test("a wrong digest in the file list rejects a file whose every block is fine", async () => {
  const bytes = randomBytes(5000);
  const t = await setup(bytes, { digest: "0".repeat(64) });
  await assert.rejects(t.sent(), /damaged file/);
  await assert.rejects(t.received, (e) => e.integrity && /expected hash/.test(e.message));
  assert.equal(t.writer.log.finished, false);
});

test("a disk that damages what it stores is caught by the read-back check", async () => {
  const bytes = randomBytes(5000);
  const t = await setup(bytes, { corrupt: true });
  await assert.rejects(t.sent(), /damaged file/);
  await assert.rejects(t.received, (e) => e.integrity && /does not match/.test(e.message));
  assert.equal(t.writer.log.finished, false);
});

test("data after the file is complete is ignored, never written or counted", async () => {
  const bytes = randomBytes(2000);
  const t = await setup(bytes);
  await t.sent();
  const result = await t.received;
  const before = t.writer.log.writes.length;
  t.receiving._emit("message", { data: new ArrayBuffer(100) });
  t.receiving._emit("message", { data: JSON.stringify({ t: "block", i: 0, h: "a".repeat(64) }) });
  await settle();
  assert.equal(t.writer.log.writes.length, before);
  assert.equal(result.name, "x");
});

test("nothing is accepted once the transfer is over", async () => {
  const bytes = randomBytes(2000);
  let open = true;
  const t = await setup(bytes, { active: () => open });
  open = false;
  const sent = t.sent();
  sent.catch(() => {});
  await assert.rejects(t.received, /transfer is over/);
  assert.deepEqual(t.writer.log.writes, []);
});

test("a block that is being verified when the transfer ends is not written", async () => {
  const bytes = randomBytes(2000);
  let open = true;
  const t = await setup(bytes, { active: () => open });
  const send = t.receiving.send.bind(t.receiving);
  t.network.tamper = (channel, data) => {
    if (typeof data === "string" && data.includes('"block"')) setImmediate(() => { open = false; });
    return [data];
  };
  t.sent().catch(() => {});
  await assert.rejects(t.received);
  assert.deepEqual(t.writer.log.writes, []);
  assert.ok(send);
});

test("a closed channel fails the transfer", async () => {
  const t = await setup(randomBytes(100_000));
  t.sending.close();
  await assert.rejects(t.received, /Connection closed/);
});

test("a long read-back check keeps the sender informed", async () => {
  const bytes = randomBytes(2000);
  const t = await setup(bytes);
  const finish = t.writer.finish;
  t.writer.finish = async (h) => { await new Promise((r) => setTimeout(r, 1300)); return finish(h); };
  const kinds = [];
  const original = t.receiving.send.bind(t.receiving);
  t.receiving.send = (data) => { if (typeof data === "string") kinds.push(JSON.parse(data).t); original(data); };
  await t.sent();
  await t.received;
  assert.ok(kinds.includes("verify"), "the receiver should say it is still checking");
  assert.equal(kinds.at(-1), "done");
});

test("a resumed file starts from the blocks that were already verified", async () => {
  const bytes = randomBytes(BLOCK_SIZE * 2 + 99);
  const scan = await scanFile(new Blob([bytes]));
  const channels = wire();
  const writer = memoryWriter(bytes.length);
  writer.store.set(bytes.subarray(0, BLOCK_SIZE), 0);                 // block 0 was received before the interruption
  const hashes = [scan.hashes[0]];
  const received = receiveFile(channels.receiving, { meta: { size: bytes.length, digest: scan.digest }, writer, hashes });
  await sendFile(channels.sending, new Blob([bytes]), { hashes: scan.hashes, startBlock: 1 });
  await received;
  assert.deepEqual(writer.log.writes, [1, 2]);
  assert.deepEqual(writer.store, bytes);
});

test("a file with nothing in it is accepted and checked", async () => {
  const t = await setup(new Uint8Array(0));
  await t.sent();
  await t.received;
  assert.ok(t.writer.log.finished);
});

test("the sender refuses to run without the block hashes from the scan", async () => {
  const { sending } = wire();
  await assert.rejects(sendFile(sending, new Blob([randomBytes(10)]), {}), /not checked before sending/);
  await assert.rejects(sendFile(sending, new Blob([randomBytes(10)]), { hashes: [] }), /not checked before sending/);
});

test("a file that changed after it was scanned is not sent", async () => {
  const bytes = randomBytes(5000);
  const t = await setup(bytes);
  const changed = bytes.slice();
  changed[10] ^= 1;
  await assert.rejects(sendFile(t.sending, new Blob([changed]), { hashes: t.scan.hashes }), (e) => e.integrity && /changed while/.test(e.message));
  assert.equal(t.writer.log.writes.length, 0);
});

test("nothing is sent after the transfer was cancelled", async () => {
  const bytes = randomBytes(BLOCK_SIZE + 5);
  const t = await setup(bytes);
  const controller = new AbortController();
  const sentMessages = [];
  const original = t.sending.send.bind(t.sending);
  t.sending.send = (data) => { sentMessages.push(data); original(data); };
  const sending = sendFile(t.sending, new Blob([bytes]), { hashes: t.scan.hashes, signal: controller.signal, onBytes: () => controller.abort() });
  await assert.rejects(sending, /Cancelled/);
  const countAtAbort = sentMessages.length;
  await settle();
  assert.equal(sentMessages.length, countAtAbort);
  assert.ok(countAtAbort <= 2);
});

test("an error from the other side is reported, and garbage from it is refused", async () => {
  const bytes = randomBytes(200_000);
  const t = await setup(bytes);
  t.receiving.onmessage = null;
  const sending = sendFile(t.sending, new Blob([bytes]), { hashes: t.scan.hashes });
  t.sending._emit("message", { data: JSON.stringify({ t: "error", reason: "disk full" }) });
  await assert.rejects(sending, /disk full/);

  const t2 = await setup(bytes);
  const sending2 = sendFile(t2.sending, new Blob([bytes]), { hashes: t2.scan.hashes });
  t2.sending._emit("message", { data: "not json" });
  await assert.rejects(sending2, /unexpected/);
});

test("activity is reported while data moves", async () => {
  const bytes = randomBytes(5000);
  const t = await setup(bytes);
  let sender = 0;
  await t.sent({ onActivity: () => { sender += 1; } });
  await t.received;
  assert.ok(sender > 0);
  await until(() => true);
});