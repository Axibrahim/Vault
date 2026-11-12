import { BLOCK_SIZE, blockCount, isHash } from "./protocol.js";

// A failed integrity check. The session throws away the partly received data when it sees `integrity`.
export const integrityError = (message) => Object.assign(new Error(message), { integrity: true });

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Reads one block of a File and hashes it. Called for block n+1 while block n is still being sent.
export async function readBlock(file, index) {
  const start = index * BLOCK_SIZE;
  const bytes = new Uint8Array(await file.slice(start, Math.min(file.size, start + BLOCK_SIZE)).arrayBuffer());
  return { index, bytes, hash: await sha256Hex(bytes) };
}
// The digest of a whole file: SHA-256 over the SHA-256 of every block, in order.
// (Block hashes come from the real bytes. The browser cannot hash a multi-gigabyte file in one go,
// so this is the standard "hash list" form; it changes if any single byte of any block changes.)
export async function treeDigest(blockHashes) {
  const joined = new Uint8Array(blockHashes.length * 32);
  for (let i = 0; i < blockHashes.length; i += 1) {         // (a plain loop: forEach would skip holes in the list)
    if (!isHash(blockHashes[i])) throw integrityError("A block hash is missing");
    joined.set(hexToBytes(blockHashes[i]), i * 32);
  }
  return sha256Hex(joined);
}

// Reads a whole file once, block by block. Returns every block hash and the digest of the file.
export async function scanFile(file, { signal, onBytes = () => {} } = {}) {
  const hashes = [];
  for (let i = 0; i < blockCount(file.size); i += 1) {
    if (signal && signal.aborted) throw new Error("Cancelled");
    const block = await readBlock(file, i);
    hashes.push(block.hash);
    onBytes(block.bytes.length);
  }
  return { hashes, digest: await treeDigest(hashes) };
}

// Reads a SAVED file back and checks every block against the hashes verified when it arrived.
// This is what proves the bytes on disk are the bytes that were sent.
export async function verifyStoredFile(file, size, expectedHashes, { onBlock = () => {} } = {}) {
  if (file.size !== size) throw integrityError("The saved file has the wrong size");
  if (expectedHashes.length !== blockCount(size)) throw integrityError("The saved file is incomplete");
  for (let i = 0; i < expectedHashes.length; i += 1) {
    const block = await readBlock(file, i);
    if (block.hash !== expectedHashes[i]) throw integrityError("The saved file does not match what was sent");
    onBlock(i);
  }
}
export { blockCount };