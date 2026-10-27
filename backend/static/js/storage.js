// A tiny key-value store on top of IndexedDB.
// IndexedDB can hold objects that localStorage cannot: CryptoKeys and folder handles.
const DB_NAME = "vault-device";
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const kvGet = (key) => run("readonly", (store) => store.get(key));
export const kvSet = (key, value) => run("readwrite", (store) => store.put(value, key));
export const kvDelete = (key) => run("readwrite", (store) => store.delete(key));