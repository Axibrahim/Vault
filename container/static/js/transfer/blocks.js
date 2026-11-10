import { BLOCK_SIZE, blockCount } from "./protocol.js";

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

export { blockCount };