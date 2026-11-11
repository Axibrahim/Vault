// The rules both devices follow. One small control channel ("ctl") carries JSON messages;
// every file gets its own data channel ("f:<id>") so several files can move at once.
import { MAX_FILES, MAX_FILE_SIZE, safeFileName, cleanMime, classify } from "./safety.js";

export const BLOCK_SIZE = 8 * 1024 * 1024;   // a file is cut into blocks; each block is verified with SHA-256
export const CHUNK_SIZE = 64 * 1024;         // size of one message on the wire (works in every browser)
export const MAX_CHUNK_SIZE = 256 * 1024;    // the most we accept from the other side
export const LANES = 3;                      // files in flight at the same time
export const WINDOW_BLOCKS = 4;              // a sender never runs more than 4 blocks (32 MB) ahead of the receiver
export const HIGH_WATER = 8 * 1024 * 1024;   // pause sending above this much queued data
export const LOW_WATER = 2 * 1024 * 1024;    // resume below this
export const CONTROL_LABEL = "ctl";
export const FILE_PREFIX = "f:";

export const blockCount = (size) => Math.ceil(size / BLOCK_SIZE);
export const blockLength = (size, index) => Math.min(BLOCK_SIZE, size - index * BLOCK_SIZE);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isUint = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;

export const isUuid = (v) => typeof v === "string" && UUID.test(v);
export const isHash = (v) => typeof v === "string" && HEX64.test(v);

function parseJson(text) {
  if (typeof text !== "string" || text.length > 200_000) throw new Error("Bad message");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bad message");
  return value;
}

// ---------- control channel ----------

// Checks and cleans the list of files the other device wants to send.
export function validateManifest(raw) {
  if (!isUuid(raw.batch)) throw new Error("Bad batch id");
  if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > MAX_FILES) {
    throw new Error("Bad file list");
  }

  const seen = new Set();
  let total = 0;
  const files = raw.files.map((f) => {
    if (!f || !isUuid(f.id) || seen.has(f.id)) throw new Error("Bad file id");
    seen.add(f.id);
    if (!isUint(f.size, MAX_FILE_SIZE)) throw new Error("Bad file size");
    if (typeof f.name !== "string") throw new Error("Bad file name");

    total += f.size;
    const name = safeFileName(f.name);
    const type = cleanMime(f.type, name);
    return { id: f.id, name, size: f.size, type, kind: classify(name, type) };
  });

  if (!isUint(total, MAX_FILE_SIZE)) throw new Error("Bad total size");
  return { batch: raw.batch, files, total };
}

const CONTROL_TYPES = new Set(["manifest", "accept", "decline", "cancel", "all-done"]);

export function parseControl(text) {
  const msg = parseJson(text);
  if (!CONTROL_TYPES.has(msg.t)) throw new Error("Unknown message");

  if (msg.t === "manifest") return { t: "manifest", ...validateManifest(msg) };

  if (msg.t === "accept") {
    if (!isUuid(msg.batch) || !Array.isArray(msg.files) || msg.files.length > MAX_FILES) {
      throw new Error("Bad accept");
    }
    const files = msg.files.map((f) => {
      if (!f || !isUuid(f.id) || !isUint(f.have, MAX_FILE_SIZE)) throw new Error("Bad accept");
      return { id: f.id, have: f.have, done: f.done === true };
    });
    return { t: "accept", batch: msg.batch, files };
  }

  if (msg.t === "decline") {
    return { t: "decline", reason: ["folder", "busy", "user"].includes(msg.reason) ? msg.reason : "user" };
  }
  return { t: msg.t };
}

// How much of a file the receiver already holds, as a number of whole blocks.
// Anything that is not a clean block boundary is thrown away and sent again.
export function resumeBlock(size, have) {
  if (have >= size) return blockCount(size);
  return Math.floor(have / BLOCK_SIZE);
}

// ---------- file channels ----------

// Messages on a file channel that are not raw data (data is binary, these are text).
export function parseFileMessage(text) {
  const msg = parseJson(text);
  if (msg.t === "block") {
    if (!isUint(msg.i, 2 ** 31) || !isHash(msg.h)) throw new Error("Bad block message");
    return { t: "block", i: msg.i, h: msg.h };
  }
  if (msg.t === "end") {
    if (!isUint(msg.blocks, 2 ** 31)) throw new Error("Bad end message");
    return { t: "end", blocks: msg.blocks };
  }
  if (msg.t === "ack") {
    if (!isUint(msg.i, 2 ** 31)) throw new Error("Bad ack");
    return { t: "ack", i: msg.i };
  }
  if (msg.t === "done") return { t: "done" };
  if (msg.t === "error") return { t: "error", reason: String(msg.reason ?? "").slice(0, 80) };
  throw new Error("Unknown message");
}

// True when the list of helper servers includes a relay (TURN). Without one, two devices on
// different networks (for example Wi-Fi and mobile data) often cannot reach each other.
export function hasRelay(iceServers) {
  return iceServers.some((server) => [].concat(server.urls).some((url) => /^turns?:/i.test(url)));
}

// What to tell the person when the connection could not be opened.
export function connectionAdvice(relay) {
  return relay
    ? "Check that Vault is open on both devices, then try again."
    : "These two networks cannot reach each other directly and no relay server is set up yet.";
}