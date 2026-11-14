// Durable storage for files that are only partly received.
//
// Every block that passes its integrity check is saved here, in the browser's IndexedDB, before it is
// acknowledged. IndexedDB survives a closed tab, a crashed browser and a phone that put the page to sleep,
// so the transfer can carry on from the last saved block instead of starting again.
//
// A partly received file is identified by WHO sent it and WHAT it is (the digest in the file list), not by
// the batch number. That is what lets a sender that restarted pick the same files again and carry on.
// Data that is not finished is deleted after KEEP_MS, and it is cleared when the person signs out.
import { BLOCK_SIZE } from "./protocol.js";
import { clearAllPending } from "./pending.js";

const DB_NAME = "vault-partials";
export const KEEP_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("files", { keyPath: "key" });                    // one record per partly received file
        db.createObjectStore("blocks", { keyPath: ["key", "index"] });        // the block bytes
        db.createObjectStore("marks", { keyPath: ["key", "index"] });         // the verified hash of each saved block
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => { dbPromise = null; reject(request.error); };
    });
  }
  return dbPromise;
}

// Runs `work(stores)` in one transaction. If `work` returns a request, its result is what comes back,
// once everything is committed.
async function transact(names, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
    let req;
    try {
      req = work(stores);
    } catch (err) {
      try { tx.abort(); } catch (e) { /* already finished */ }
      return reject(err);
    }
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage was interrupted"));
  });
}

export const partialKey = (peerId, digest) => `${peerId}:${digest}`;

let askedToKeep = false;
function askToKeep() {
  if (askedToKeep) return;
  askedToKeep = true;
  try { navigator.storage.persist().catch(() => {}); } catch (err) { /* not available: the data is simply best-effort */ }
}

// Saves one verified block, its hash and the file's record in ONE step, so a crash can never leave a
// block without its hash or a hash without its block.
export async function putBlock(file, index, bytes, hash) {
  askToKeep();
  try {
    await transact(["files", "blocks", "marks"], "readwrite", ({ files, blocks, marks }) => {
      files.put({
        key: file.key, peerId: file.peerId, digest: file.digest, size: file.size, name: file.name, type: file.type,
        bs: BLOCK_SIZE, updated: Date.now(), done: false,
      });
      blocks.put({ key: file.key, index, data: new Blob([bytes]) });
      marks.put({ key: file.key, index, hash });
    });
  } catch (err) {
    if (err && err.name === "QuotaExceededError") throw new Error("There is not enough free space on this device");
    throw err;
  }
}

// The verified hashes of a partly received file, from block 0 up to the first gap.
// Empty when nothing usable is held (different size, different block size, or nothing saved).
export async function heldHashes(key, size) {
  const hashes = [];
  await transact(["files", "marks"], "readonly", ({ files, marks }) => {
    const rec = files.get(key);
    rec.onsuccess = () => {
      if (!rec.result || rec.result.size !== size || rec.result.bs !== BLOCK_SIZE || rec.result.done) return;
      const all = marks.getAll(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]));
      all.onsuccess = () => {
        for (const mark of all.result) {
          if (mark.index !== hashes.length) break;
          hashes.push(mark.hash);
        }
      };
    };
  });
  return hashes;
}

export async function getBlock(key, index) {
  const record = await transact(["blocks"], "readonly", ({ blocks }) => blocks.get([key, index]));
  if (!record) throw new Error("A saved block is missing");
  return record.data;
}

// Marks a file as completely received. It is kept until the person has saved it, then removed.
export async function markDone(key) {
  await transact(["files"], "readwrite", ({ files }) => {
    const rec = files.get(key);
    rec.onsuccess = () => { if (rec.result) files.put({ ...rec.result, done: true, updated: Date.now() }); };
  });
}

async function removeWhere(match) {
  await transact(["files", "blocks", "marks"], "readwrite", ({ files, blocks, marks }) => {
    const cursor = files.openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at) return;
      if (match(at.value)) {
        const range = IDBKeyRange.bound([at.value.key, 0], [at.value.key, Number.MAX_SAFE_INTEGER]);
        blocks.delete(range);
        marks.delete(range);
        at.delete();
      }
      at.continue();
    };
  });
}

export const removeFile = (key) => removeWhere((rec) => rec.key === key);

// At start-up: forget finished files that were never saved, and anything older than KEEP_MS.
export const sweep = (now = Date.now()) => removeWhere((rec) => rec.done || now - rec.updated > KEEP_MS);

// On sign-out: nothing of this account stays in the browser.
export const clearAll = async () => {
  await removeWhere(() => true);
  await clearAllPending().catch(() => {});      // and the memory of an unfinished send
};