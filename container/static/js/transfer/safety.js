// Everything the other device tells us about a file is untrusted until it passes through here.

export const MAX_FILES = 500;          // per batch
export const MAX_NAME_LENGTH = 180;
export const MAX_FILE_SIZE = 2 ** 50;  // 1 PiB: just a sanity ceiling so sizes stay exact integers

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Letters that can hide a fake extension ("photo\u202Egpj.exe" displays as "photoexe.jpg").
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g;

export function safeFileName(name) {
  let clean = String(name ?? "").normalize("NFC");
  clean = clean.split(/[\\/]/).pop();                       // never a folder part
  clean = clean.replace(BIDI_CONTROLS, "");
  clean = clean.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_");
  clean = clean.replace(/^[\s.]+|[\s.]+$/g, "");            // no leading dots (hidden files) or trailing dots/spaces (Windows)
  if (!clean) clean = "file";
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;

  if (clean.length > MAX_NAME_LENGTH) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
    clean = clean.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return clean;
}

// "photo.jpg" -> "photo (1).jpg" until `exists(name)` says the name is free.
export async function uniqueName(name, exists) {
  if (!(await exists(name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 10000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Could not find a free file name");
}

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", avif: "image/avif", bmp: "image/bmp",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", "3gp": "video/3gpp", webm: "video/webm",
};

export function mimeFromName(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return MIME_BY_EXTENSION[ext] || "application/octet-stream";
}

const SAFE_MIME = /^[\w.+-]{1,60}\/[\w.+-]{1,80}$/;

export function cleanMime(type, name) {
  const wanted = typeof type === "string" && SAFE_MIME.test(type) ? type.toLowerCase() : "";
  return wanted && wanted !== "application/octet-stream" ? wanted : mimeFromName(name);
}

// Photos and videos belong in the gallery; everything else (documents, zip files...) in Files.
export function classify(name, type) {
  const mime = cleanMime(type, name);
  return mime.startsWith("image/") || mime.startsWith("video/") ? "gallery" : "files";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}