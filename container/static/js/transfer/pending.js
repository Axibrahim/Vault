// Remembers a send that has not finished, so it can be carried on after the page was closed or crashed.
//
// A browser cannot keep access to a file once the page is gone, so what is saved is only the file list (names and
// sizes) and, where the browser allows it (Chrome / Edge on a computer), a handle that lets the page ask for the
// file again. The person picks the same files again, or allows access, and the send carries on: the receiving
// device matches the blocks it already saved by the files' digests.
// The record is deleted when the send finishes or is cancelled, after KEEP_MS, and on sign-out.
const DB_NAME = "vault-pending";
const STORE = "sends";
export const KEEP_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "uid" });
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

async function run(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage was interrupted"));
  });
}

// files: [{ name, size, type, handle }]
export async function savePending({ uid, peerId, files }) {
  const record = { uid, peerId, savedAt: Date.now(), files };
  try {
    await run("readwrite", (store) => store.put(record));
  } catch (err) {
    // some browsers cannot store file handles: keep the list without them
    const plain = { ...record, files: files.map((f) => ({ ...f, handle: null })) };
    await run("readwrite", (store) => store.put(plain));
  }
}

export async function loadPending(uid) {
  const record = await run("readonly", (store) => store.get(uid));
  if (!record) return null;
  if (Date.now() - record.savedAt > KEEP_MS) {
    await clearPending(uid);
    return null;
  }
  return record;
}

export const clearPending = (uid) => run("readwrite", (store) => store.delete(uid));
export const clearAllPending = () => run("readwrite", (store) => store.clear());