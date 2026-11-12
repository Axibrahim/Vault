// Where received files end up.
//   FolderSink  the computer: straight into the folder the person chose (streams to disk, any size)
//   PhoneSink   the phone: a private scratch area, then the person saves to the gallery / Files
import { BLOCK_SIZE } from "./protocol.js";
import { verifyStoredFile } from "./blocks.js";
import { safeFileName, uniqueName, cleanMime } from "./safety.js";

// ---------- computer ----------

export class FolderSink {
  constructor(dirHandle) {
    this.dir = dirHandle;
    this.reserved = new Set();
    this.lock = Promise.resolve();   // names are handed out one at a time
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

  open(meta) {
    const job = this.lock.then(async () => {
      const name = await uniqueName(safeFileName(meta.name), (n) => this._exists(n));
      this.reserved.add(name);
      const handle = await this.dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      return { name, writable, handle };
    });
    this.lock = job.catch(() => {});

    return job.then(({ name, writable, handle }) => ({
      name,
      writeBlock: (index, bytes) => writable.write({ type: "write", position: index * BLOCK_SIZE, data: bytes }),
      // Closes the file, then reads it back from disk and checks it against the verified block hashes.
      // A file that does not match is deleted: a damaged file is never left in the folder.
      finish: async (hashes) => {
        await writable.close();
                try {
          await verifyStoredFile(await handle.getFile(), meta.size, hashes);
        } catch (err) {
          try { await this.dir.removeEntry(name); } catch (e) { /* already gone */ }
          this.reserved.delete(name);
          throw err;
        }
        return { name };
      },
      abort: async () => {
        try { await writable.abort(); } catch (err) { /* already closed */ }
        try { await this.dir.removeEntry(name); } catch (err) { /* nothing to remove */ }
        this.reserved.delete(name);
      },
    }));
  }
}

// ---------- phone ----------

const SCRATCH = "vault-inbox";
const opfsWritable = () =>
  typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function" &&
  typeof globalThis.FileSystemFileHandle === "function" &&
  typeof FileSystemFileHandle.prototype.createWritable === "function";

async function scratchDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SCRATCH, { create: true });
}

export class PhoneSink {
  constructor() {
    this.used = new Set();
  }

  // Received data should not linger: clear the scratch area when Vault starts.
  static async purge() {
    if (!opfsWritable()) return;
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(SCRATCH, { recursive: true });
    } catch (err) { /* nothing to clear */ }
  }

  async ready() {
    return true;
  }

  async open(meta) {
    const name = await uniqueName(safeFileName(meta.name), async (n) => this.used.has(n));
    this.used.add(name);
    const type = cleanMime(meta.type, name);

    if (opfsWritable()) {
      const dir = await scratchDir();
      const partName = `${meta.id}.part`;
      const handle = await dir.getFileHandle(partName, { create: true });
      const writable = await handle.createWritable();
      return {
        name,
        writeBlock: (index, bytes) => writable.write({ type: "write", position: index * BLOCK_SIZE, data: bytes }),
        finish: async (hashes) => {
          await writable.close();
          const stored = await handle.getFile();
                    try {
            await verifyStoredFile(stored, meta.size, hashes);
          } catch (err) {
            await dir.removeEntry(partName).catch(() => {});
            this.used.delete(name);
            throw err;
          }
          return {
            name,
            file: new File([stored], name, { type }),
            discard: () => dir.removeEntry(partName).catch(() => {}),
          };
        },
        abort: async () => {
          try { await writable.abort(); } catch (err) { /* already closed */ }
          await dir.removeEntry(partName).catch(() => {});
          this.used.delete(name);
        },
      };
    }

    // Browsers without a private file system (Safari today): keep verified blocks as Blobs.
    const parts = [];
    return {
      name,
      writeBlock: async (index, bytes) => { parts[index] = new Blob([bytes]); },
      finish: async (hashes) => {
        const file = new File(parts, name, { type });
        try {
          await verifyStoredFile(file, meta.size, hashes);
        } catch (err) {
          parts.length = 0;
          this.used.delete(name);
          throw err;
        }
        return { name, file, discard: () => {} };
      },
      abort: async () => { parts.length = 0; this.used.delete(name); },
    };
  }
}