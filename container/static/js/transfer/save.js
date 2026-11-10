// Phone only: getting a received file out of Vault and into the phone's gallery or Files app.
// A web page cannot write to the gallery silently. It has to hand the file to the system,
// and the system needs a tap from the person, so these run from a button.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isIos(nav = globalThis.navigator) {
  const ua = (nav && nav.userAgent) || "";
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// Photos and videos. Returns "shared", "downloaded" or "cancelled".
export async function saveToGallery(files) {
  // iPhone / iPad: the share sheet offers "Save Image" / "Save Video", which keeps the original in Photos.
  if (isIos() && navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      // too big for the share sheet: fall back to a normal download below
    }
  }
  // Android: a download lands in the Download folder, which gallery apps show as an album.
  for (const file of files) {
    downloadFile(file);
    await sleep(300);
  }
  return "downloaded";
}

// Documents, zip files and everything else: a normal download (the Files app).
export async function saveToFiles(files) {
  for (const file of files) {
    downloadFile(file);
    await sleep(300);
  }
}