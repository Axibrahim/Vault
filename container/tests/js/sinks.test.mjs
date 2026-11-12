import test from "node:test";
import assert from "node:assert/strict";
import { FolderSink, PhoneSink } from "../../static/js/transfer/sinks.js";
import { BLOCK_SIZE } from "../../static/js/transfer/protocol.js";
import { scanFile } from "../../static/js/transfer/blocks.js";
import { randomBytes } from "./harness.mjs";

// A folder in memory with the same calls the browser's folder handle has.
function fakeDir({ corrupt = false, failQuery = false } = {}) {
  const files = new Map();
  const log = { removed: [], aborted: [] };
  const handleFor = (name) => ({
    async createWritable() {
      let data = new Uint8Array(0);
      return {
        async write({ position, data: chunk }) {
          const next = new Uint8Array(Math.max(data.length, position + chunk.length));
          next.set(data);
          const bytes = chunk.slice();
          if (corrupt && bytes.length) bytes[0] ^= 0xff;
          next.set(bytes, position);
          data = next;
        },
        async close() { files.set(name, data); },
        async abort() { log.aborted.push(name); },
      };
    },
    async getFile() { return new Blob([files.get(name) ?? new Uint8Array(0)]); },
  });
  return {
    files,
    log,
    async queryPermission() { return failQuery ? "prompt" : "granted"; },
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw Object.assign(new Error("none"), { name: "NotFoundError" });
      if (!files.has(name)) files.set(name, new Uint8Array(0));
      return handleFor(name);
    },
    async removeEntry(name) {
      if (!files.has(name)) throw new Error("not found");
      files.delete(name);
      log.removed.push(name);
    },
  };
}

async function receive(writerPromise, bytes) {
  const writer = await writerPromise;
  const { hashes } = await scanFile(new Blob([bytes]));
  for (let i = 0; i < hashes.length; i += 1) {
    await writer.writeBlock(i, bytes.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
  }
  return { writer, hashes };
}

const metaOf = (bytes, name = "a.bin") => ({ id: "1b5d9f0e-6d3a-4c8e-9a53-1c7f5a1e2b3d", name, size: bytes.length, type: "application/octet-stream" });

test("the computer saves a verified file into the chosen folder", async () => {
  const dir = fakeDir();
  const sink = new FolderSink(dir);
  assert.equal(await sink.ready(), true);
  const bytes = randomBytes(BLOCK_SIZE + 100);
  const { writer, hashes } = await receive(sink.open(metaOf(bytes)), bytes);
  assert.deepEqual(await writer.finish(hashes), { name: "a.bin" });
  assert.deepEqual(dir.files.get("a.bin"), bytes);
});

test("a file damaged on its way to disk is deleted, not kept", async () => {
  const dir = fakeDir({ corrupt: true });
  const sink = new FolderSink(dir);
  const bytes = randomBytes(5000);
  const { writer, hashes } = await receive(sink.open(metaOf(bytes)), bytes);
  await assert.rejects(writer.finish(hashes), (e) => e.integrity === true);
  assert.equal(dir.files.has("a.bin"), false);
  assert.deepEqual(dir.log.removed, ["a.bin"]);
  assert.equal(sink.reserved.has("a.bin"), false);
});

test("a damaged file is removed even if the folder refuses to remove it", async () => {
  const dir = fakeDir({ corrupt: true });
  dir.removeEntry = async () => { throw new Error("locked"); };
  const sink = new FolderSink(dir);
  const bytes = randomBytes(100);
  const { writer, hashes } = await receive(sink.open(metaOf(bytes)), bytes);
  await assert.rejects(writer.finish(hashes), (e) => e.integrity === true);
});

test("an aborted transfer leaves no file behind", async () => {
  const dir = fakeDir();
  const sink = new FolderSink(dir);
  const writer = await sink.open(metaOf(randomBytes(10)));
  await writer.abort();
  assert.equal(dir.files.has("a.bin"), false);
  assert.deepEqual(dir.log.aborted, ["a.bin"]);
  assert.equal(sink.reserved.has("a.bin"), false);
});

test("abort copes with a stream that is already closed and a file that is already gone", async () => {
  const dir = fakeDir();
  const sink = new FolderSink(dir);
  const writer = await sink.open(metaOf(randomBytes(10)));
  dir.files.delete("a.bin");
  await writer.abort();
});

test("two files with the same name get different names", async () => {
  const dir = fakeDir();
  const sink = new FolderSink(dir);
  const one = await sink.open(metaOf(randomBytes(5)));
  const two = await sink.open(metaOf(randomBytes(5)));
  assert.equal(one.name, "a.bin");
  assert.equal(two.name, "a (1).bin");
});

test("the folder must still be writable", async () => {
  assert.equal(await new FolderSink(fakeDir({ failQuery: true })).ready(), false);
});

test("a folder that cannot be asked about is an error, not a silent 'free'", async () => {
  const dir = fakeDir();
  dir.getFileHandle = async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); };
  const sink = new FolderSink(dir);
  await assert.rejects(sink.open(metaOf(randomBytes(5))), /denied/);
});

// ---------------------------------------------------------------- the phone

test("the phone keeps verified blocks and returns the file", async () => {
  const sink = new PhoneSink();
  assert.equal(await sink.ready(), true);
  const bytes = randomBytes(BLOCK_SIZE + 7);
  const { writer, hashes } = await receive(sink.open({ ...metaOf(bytes, "photo.jpg"), type: "image/jpeg" }), bytes);
  const result = await writer.finish(hashes);
  assert.equal(result.name, "photo.jpg");
  assert.equal(result.file.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), bytes);
  result.discard();
});

test("the phone refuses a file that does not match and frees its name", async () => {
  const sink = new PhoneSink();
  const bytes = randomBytes(300);
  const { writer, hashes } = await receive(sink.open(metaOf(bytes)), bytes);
  hashes[0] = "f".repeat(64);
  await assert.rejects(writer.finish(hashes), (e) => e.integrity === true);
  assert.equal(sink.used.has("a.bin"), false);
});

test("an aborted receive on the phone frees everything", async () => {
  const sink = new PhoneSink();
  const writer = await sink.open(metaOf(randomBytes(5)));
  assert.ok(sink.used.has("a.bin"));
  await writer.abort();
  assert.equal(sink.used.has("a.bin"), false);
});

// the phone's private file system (where the browser has one)
function withPrivateFileSystem(run) {
  return async () => {
    const root = new Map();
    const dirs = new Map();
    const parts = new Map();
    const dirHandle = {
      async getFileHandle(name) {
        if (!parts.has(name)) parts.set(name, new Uint8Array(0));
        const handle = {
          async createWritable() {
            let data = new Uint8Array(0);
            return {
              async write({ position, data: chunk }) {
                const next = new Uint8Array(Math.max(data.length, position + chunk.length));
                next.set(data);
                next.set(chunk, position);
                data = next;
              },
              async close() { parts.set(name, data); },
              async abort() {},
            };
          },
          async getFile() { return new Blob([parts.get(name)]); },
        };
        return handle;
      },
      async removeEntry(name) { parts.delete(name); },
    };
    const storage = {
      async getDirectory() {
        return {
          async getDirectoryHandle(name) { dirs.set(name, true); return dirHandle; },
          async removeEntry(name) { dirs.delete(name); root.set("purged", name); },
        };
      },
    };
    const had = Object.getOwnPropertyDescriptor(globalThis.navigator, "storage");
    Object.defineProperty(globalThis.navigator, "storage", { value: storage, configurable: true });
    globalThis.FileSystemFileHandle = class { createWritable() {} };
    try {
      await run({ parts, dirs, root });
    } finally {
      delete globalThis.FileSystemFileHandle;
      if (had) Object.defineProperty(globalThis.navigator, "storage", had); else delete globalThis.navigator.storage;
    }
  };
}

test("the phone's private storage: a verified file is returned and the scratch copy removable", withPrivateFileSystem(async ({ parts }) => {
  const sink = new PhoneSink();
  const bytes = randomBytes(2048);
  const meta = metaOf(bytes, "doc.pdf");
  const { writer, hashes } = await receive(sink.open(meta), bytes);
  const result = await writer.finish(hashes);
  assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), bytes);
  assert.ok(parts.has(`${meta.id}.part`));
  await result.discard();
  assert.equal(parts.has(`${meta.id}.part`), false);
}));

test("the phone's private storage: a damaged file is deleted from the scratch area", withPrivateFileSystem(async ({ parts }) => {
  const sink = new PhoneSink();
  const bytes = randomBytes(500);
  const meta = metaOf(bytes);
  const { writer, hashes } = await receive(sink.open(meta), bytes);
  hashes[0] = "e".repeat(64);
  await assert.rejects(writer.finish(hashes), (e) => e.integrity === true);
  assert.equal(parts.has(`${meta.id}.part`), false);
  assert.equal(sink.used.has("a.bin"), false);
}));

test("the phone's private storage: an aborted receive is removed", withPrivateFileSystem(async ({ parts }) => {
  const sink = new PhoneSink();
  const meta = metaOf(randomBytes(5));
  const writer = await sink.open(meta);
  assert.ok(parts.has(`${meta.id}.part`));
  await writer.abort();
  assert.equal(parts.has(`${meta.id}.part`), false);
  assert.equal(sink.used.has("a.bin"), false);
}));

test("leftovers from an earlier session are cleared when Vault starts", withPrivateFileSystem(async ({ root }) => {
  await PhoneSink.purge();
  assert.equal(root.get("purged"), "vault-inbox");
}));

test("clearing leftovers does nothing where there is no private storage", async () => {
  await PhoneSink.purge();
});