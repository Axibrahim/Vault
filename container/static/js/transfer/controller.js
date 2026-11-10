// Connects the transfer code to the screens: the send buttons, the "incoming files" question,
// the progress card and the phone's save buttons.
import { getFolder } from "../device/folder.js";
import { $, setStatus } from "../ui/dom.js";
import { hideTransfer, onTransferCancel, onTransferResume, showTransfer } from "../ui/transfer.js";
import { saveToFiles, saveToGallery, isIos } from "./save.js";
import { formatBytes } from "./safety.js";
import { TransferSession } from "./session.js";
import { FolderSink, PhoneSink } from "./sinks.js";

let session = null;
let running = null;      // { role, deviceId, peerId }
let pendingAnswer = null;
let received = null;     // what the phone holds until the person saves it
let wakeLock = null;

// The receiving folder can change while the page is open, so it is looked up when a transfer arrives.
function lazyFolderSink(uid) {
  let inner = null;
  return {
    async ready() {
      const dir = await getFolder(uid);
      if (!dir) return false;
      inner = new FolderSink(dir);
      return inner.ready();
    },
    open: (meta) => inner.open(meta),
  };
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    wakeLock = null;         // not available, or the page is hidden: the transfer still works
  }
}

function askOnPhone(manifest) {
  const gallery = manifest.files.filter((f) => f.kind === "gallery").length;
  const other = manifest.files.length - gallery;
  const parts = [];
  if (gallery) parts.push(`${gallery} photo${gallery === 1 ? "" : "s"} / video${gallery === 1 ? "" : "s"}`);
  if (other) parts.push(`${other} other file${other === 1 ? "" : "s"}`);

  $("incoming-text").textContent = `Your computer wants to send ${parts.join(" and ")} (${formatBytes(manifest.total)}).`;
  $("incoming").hidden = false;
  return new Promise((resolve) => {
    pendingAnswer = (accepted) => {
      pendingAnswer = null;
      $("incoming").hidden = true;
      resolve(accepted);
    };
  });
}

async function showReceivedOnDesktop(uid, results) {
  const folder = await getFolder(uid);
  const total = results.reduce((n, f) => n + f.size, 0);
  showTransfer("received", `Received ${results.length} file${results.length === 1 ? "" : "s"}`,
    `${formatBytes(total)} saved to ${folder ? folder.name : "your folder"}`);
}

function showReceivedOnPhone(results) {
  const gallery = results.filter((r) => r.kind === "gallery" && r.file);
  const files = results.filter((r) => r.kind !== "gallery" && r.file);
  received = { gallery, files };

  const total = results.reduce((n, f) => n + f.size, 0);
  showTransfer("received", `Received ${results.length} file${results.length === 1 ? "" : "s"}`, `${formatBytes(total)} · tap below to save`);

  $("received-text").textContent = "Tap to save what you received.";
  $("save-gallery-btn").hidden = gallery.length === 0;
  $("save-gallery-btn").textContent = `Save ${gallery.length} photo${gallery.length === 1 ? "" : "s"} / video${gallery.length === 1 ? "" : "s"} to gallery`;
  $("save-files-btn").hidden = files.length === 0;
  $("save-files-btn").textContent = `Save ${files.length} file${files.length === 1 ? "" : "s"}`;
  $("received-hint").textContent = isIos()
    ? "In the share sheet, choose “Save Image” or “Save Video”. Originals are kept."
    : "Saved to your Download folder. Gallery apps show it as the “Download” album.";
  $("received-box").hidden = false;
}

function makeUi(role, uid) {
  return {
    show(kind, title, detail, progress, resumable = true) {
      keepAwake(kind === "loading");
      showTransfer(kind, title, detail, progress, resumable);
    },
    hide() {
      keepAwake(false);
      hideTransfer();
    },
    askAccept: role === "phone" ? askOnPhone : async () => true,
    received(results) {
      keepAwake(false);
      return role === "phone" ? showReceivedOnPhone(results) : showReceivedOnDesktop(uid, results);
    },
    sent(count, total) {
      keepAwake(false);
      showTransfer("received", `Sent ${count} file${count === 1 ? "" : "s"}`, formatBytes(total));
    },
  };
}

export function deactivateTransfers() {
  if (session) session.stop();
  session = null;
  running = null;
  if (pendingAnswer) pendingAnswer(false);
  $("send-box").hidden = true;
  $("phone-send").hidden = true;
}

// Called by the desktop and phone screens each time they are shown.
export function activateTransfers({ role, uid, identity, devices }) {
  const peerType = role === "desktop" ? "phone" : "desktop";
  const peer = devices.find((d) => d.type === peerType && d.status === "active" && d.id !== identity.deviceId);
  const peerId = peer ? peer.id : null;

  if (session && running.role === role && running.deviceId === identity.deviceId && running.peerId === peerId) return;
  deactivateTransfers();

  const hasPeer = Boolean(peerId);
  $("send-box").hidden = role !== "desktop" || !hasPeer;
  $("phone-send").hidden = role !== "phone";
  if (!hasPeer) return;

  session = new TransferSession({
    identity,
    uid,
    peerId,
    peerName: role === "desktop" ? peer.name : "your computer",
    sink: role === "desktop" ? lazyFolderSink(uid) : new PhoneSink(),
    ui: makeUi(role, uid),
  });
  running = { role, deviceId: identity.deviceId, peerId };
  session.start();
}

function startSending(files) {
  if (!session || files.length === 0) return;
  if (session.busy) {
    setStatus("Wait for the current transfer to finish.");
    return;
  }
  setStatus("");
  $("received-box").hidden = true;
  session.send(files).catch((err) => showTransfer("interrupted", "Could not send", err.message, null, false));
}

function dropped(event) {
  event.preventDefault();
  $("send-box").classList.remove("over");
  const files = [];
  let skippedFolder = false;
  for (const item of event.dataTransfer.items || []) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry && entry.isDirectory) skippedFolder = true;
    else if (item.kind === "file" && item.getAsFile()) files.push(item.getAsFile());
  }
  if (skippedFolder) setStatus("Folders can't be sent directly. Zip the folder first, then send the zip file.");
  startSending(files);
}

// Called once when the page starts.
export function initTransfers() {
  PhoneSink.purge();

  const wire = (buttonId, inputId) => {
    $(buttonId).addEventListener("click", () => $(inputId).click());
    $(inputId).addEventListener("change", (event) => {
      startSending([...event.target.files]);
      event.target.value = "";          // lets the same file be picked again
    });
  };
  wire("send-btn", "send-input");
  wire("send-photos-btn", "send-photos-input");
  wire("send-files-btn", "send-files-input");

  const zone = $("send-box");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", dropped);

  $("incoming-accept").addEventListener("click", () => pendingAnswer && pendingAnswer(true));
  $("incoming-decline").addEventListener("click", () => pendingAnswer && pendingAnswer(false));

  onTransferResume(() => session && session.resume());
  onTransferCancel(() => {
    if (pendingAnswer) pendingAnswer(false);
    if (session) session.cancel();
  });

  const finish = async (list, save) => {
    await save(list.map((r) => r.file));
    for (const r of list) if (r.discard) r.discard();
  };
  $("save-gallery-btn").addEventListener("click", async () => {
    if (!received) return;
    const outcome = await saveToGallery(received.gallery.map((r) => r.file));
    if (outcome === "cancelled") return;
    for (const r of received.gallery) if (r.discard) r.discard();
    received.gallery = [];
    $("save-gallery-btn").hidden = true;
    if (!received.files.length) $("received-box").hidden = true;
  });
  $("save-files-btn").addEventListener("click", async () => {
    if (!received) return;
    await finish(received.files, saveToFiles);
    received.files = [];
    $("save-files-btn").hidden = true;
    if (!received.gallery.length) $("received-box").hidden = true;
  });
}