// Where received files end up.
//   FolderSink  the computer: the finished file goes into the folder the person chose
//   PhoneSink   the phone: a finished File the person then saves to the gallery / Files
//
// Both sinks first keep every verified block in the durable store (see partials.js). That is what lets a
// transfer carry on after the connection drops, a tab closes, or a browser crashes. The finished file is
// put together from those blocks and checked once more before it counts as received.
import { blockCount } from "./protocol.js";
import { verifyStoredFile } from "./blocks.js";
import { safeFileName, uniqueName, cleanMime } from "./safety.js";
import { getBlock, heldHashes, markDone, partialKey, putBlock, removeFile, sweep } from "./partials.js";

// Which files of an incoming list are already partly held for this sender? -> Map(file id -> verified hashes)
export async function heldMap(peerId, files) {
  const held = new Map();
  for (const file of files) {
    const hashes = await heldHashes(partialKey(peerId, file.digest), file.size);
    if (hashes.length) held.set(file.id, hashes);
  }
  return held;
}

// meta: { name, size, type, digest, peerId }
function storage(meta) {
  const key = partialKey(meta.peerId, meta.digest);
  const file = { key, peerId: meta.peerId, digest: meta.digest, size: meta.size, name: meta.name, type: meta.type };
  return {
    key,
    writeBlock: (index, bytes, hash) => putBlock(file, index, bytes, hash),
    abort: () => removeFile(key),
    async blobs() {
      const parts = [];
      for (let i = 0; i < blockCount(meta.size); i += 1) parts.push(await getBlock(key, i));
      return parts;
    },
  };
}

// ---------- computer ----------

export class FolderSink {
  constructor(dirHandle) {
    this.dir = dirHandle;
    this.reserved = new Set();
    this.lock = Promise.resolve();   // names are handed out one at a time
  }

  held(peerId, files) {
    return heldMap(peerId, files);
  }

  async ready() {
    return (await this.dir.queryPermission({ mode: "readwrite" })) === "granted";
  }

  async _exists(name) {
    if (this.reserved.has(name)) return true;
    try {
      await this.dir.getFileHandle(name);
      return true;
    } catch (err) {
      if (err.name === "NotFoundError") return false;
      throw err;
    }
  }

  // Names are decided when the file is finished, so a transfer that carried on after an interruption
  // gets the plain name, not "name (1)".
  _claimName(meta) {
    const job = this.lock.then(async () => {
      const name = await uniqueName(safeFileName(meta.name), (n) => this._exists(n));
      this.reserved.add(name);
      return name;
    });
    this.lock = job.catch(() => {});
    return job;
  }

  async open(meta) {
    const saved = storage(meta);
    return {
      writeBlock: saved.writeBlock,
      // Puts the file together in the folder, then reads it back from disk and checks it against the verified
      // block hashes. A file that does not match is deleted: a damaged file is never left in the folder.
      finish: async (hashes) => {
        const name = await this._claimName(meta);
        let writable = null;
        try {
          const handle = await this.dir.getFileHandle(name, { create: true });
          writable = await handle.createWritable();
          for (const blob of await saved.blobs()) await writable.write(blob);
          await writable.close();
          await verifyStoredFile(await handle.getFile(), meta.size, hashes);
        } catch (err) {
          if (writable) { try { await writable.abort(); } catch (e) { /* already closed */ } }
          try { await this.dir.removeEntry(name); } catch (e) { /* already gone */ }
          this.reserved.delete(name);
          throw err;
        }
        await saved.abort();               // the folder has the file now: the saved blocks are not needed
        return { name };
      },
      abort: saved.abort,
    };
  }
}

// ---------- phone ----------

export class PhoneSink {
  constructor() {
    this.used = new Set();
  }

  // At start-up: forget finished files that were never saved, and unfinished ones that are too old.
  // (Unfinished files younger than that are kept, so an interrupted transfer can carry on.)
  static async purge() {
    try { await sweep(); } catch (err) { /* nothing to clear */ }
    try {                                       // older versions kept received data in a private folder: remove it
      if (navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry("vault-inbox", { recursive: true });
      }
    } catch (err) { /* nothing to clear */ }
  }

  held(peerId, files) {
    return heldMap(peerId, files);
  }

  async ready() {
    return true;
  }

  async open(meta) {
    const saved = storage(meta);
    return {
      writeBlock: saved.writeBlock,
      finish: async (hashes) => {
        const name = await uniqueName(safeFileName(meta.name), async (n) => this.used.has(n));
        this.used.add(name);
        const file = new File(await saved.blobs(), name, { type: cleanMime(meta.type, name) });
        try {
          await verifyStoredFile(file, meta.size, hashes);
        } catch (err) {
          await saved.abort();
          this.used.delete(name);
          throw err;
        }
        await markDone(saved.key);
        // The blocks stay until the person has saved the file: the File is made from them.
        return { name, file, discard: () => saved.abort() };
      },
      abort: saved.abort,
    };
  }
}