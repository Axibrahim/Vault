import { kvGet, kvSet, kvDelete } from "../core/storage.js";

const folderKey = (uid) => `folder:${uid}`;

export const folderSupported = () => "showDirectoryPicker" in window;

// Proves we can really write there, then cleans up after itself.
async function testWrite(dirHandle) {
  const name = "vault-write-test.tmp";
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write("ok");
  await writable.close();
  await dirHandle.removeEntry(name);
}

// Must be called from a click handler (browsers require a user gesture).
export async function pickFolder(uid) {
  const dirHandle = await window.showDirectoryPicker({ id: "vault-inbox", mode: "readwrite" });
  await testWrite(dirHandle);
  await kvSet(folderKey(uid), dirHandle);
  return dirHandle;
}

export const getFolder = (uid) => kvGet(folderKey(uid));
export const forgetFolder = (uid) => kvDelete(folderKey(uid));

// "granted", "prompt" or "denied"
export const folderPermission = (dirHandle) => dirHandle.queryPermission({ mode: "readwrite" });

// Must be called from a click handler.
export async function requestFolderAccess(dirHandle) {
  return (await dirHandle.requestPermission({ mode: "readwrite" })) === "granted";
}