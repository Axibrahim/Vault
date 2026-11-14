// Connects the transfer code to the screens: the send buttons, the device list with its status
// dots, the "incoming files" question, the progress card and the phone's save buttons.
import { api } from "../core/api.js";
import { withReauth } from "../core/auth.js";
import { folderPermission, getFolder } from "../device/folder.js";
import { $, every, setStatus, stopTimer } from "../ui/dom.js";
import { loadHistory } from "../ui/history.js";
import { dropState, issueFor, renderPeers, sessionSummary, stateOf } from "../ui/peers.js";
import { hideTransfer, onTransferCancel, onTransferResume, showTransfer } from "../ui/transfer.js";
import { saveToFiles, saveToGallery, isIos } from "./save.js";
import { formatBytes } from "./safety.js";
import { TransferSession } from "./session.js";
import { FolderSink, PhoneSink, heldMap } from "./sinks.js";
import { clearPending, loadPending, savePending } from "./pending.js";

const BEAT_EVERY_MS = 1_000;

let session = null;
let running = null;        // { role, uid, deviceId }
let pendingAnswer = null;
let received = null;       // what the phone holds until the person saves it
let wakeLock = null;
let wakeAsking = false;
let pending = null;        // an unfinished send remembered from before the page was closed

let peers = [];            // the other kind of device: [{ id, name, ... }]
let knownIds = new Set();  // every active device of the account
let selectedId = null;     // who files go to
let presence = {};         // device id -> "ready" | "busy" | "blocked" (missing = offline)
let presenceLoaded = false;
let ownNow = "ready";
let lastSession = "";
let beatTimer = null;
let refreshApp = async () => {};
let refreshing = false;

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
    held: (peerId, files) => heldMap(peerId, files),
  };
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && !wakeAsking && navigator.wakeLock) {
      wakeAsking = true;
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });   // the browser lets go when the page is hidden: ask again when it is back
      } finally {
        wakeAsking = false;
      }
    }
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    wakeLock = null;         // not available, or the page is hidden: the transfer still works
  }
}

function askOnPhone(manifest, who) {
  const gallery = manifest.files.filter((f) => f.kind === "gallery").length;
  const other = manifest.files.length - gallery;
  const parts = [];
  if (gallery) parts.push(`${gallery} photo${gallery === 1 ? "" : "s"} / video${gallery === 1 ? "" : "s"}`);
  if (other) parts.push(`${other} other file${other === 1 ? "" : "s"}`);

  $("incoming-text").textContent = `${who} wants to send ${parts.join(" and ")} (${formatBytes(manifest.total)}).`;
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
  const refreshHistory = (delay) => setTimeout(() => { if (running) loadHistory(running.deviceId); }, delay);
  return {
    show(kind, title, detail, progress, resumable = true) {
      keepAwake(kind === "loading");
      showTransfer(kind, title, detail, progress, resumable);
    },
    hide() {
      keepAwake(false);
      hideTransfer();
    },
    askAccept: role === "phone"
      ? (manifest) => askOnPhone(manifest, session ? session.peerName : "Your computer")
      : async () => true,
    received(results) {
      keepAwake(false);
      refreshHistory(2000);       // the sender records the transfer a moment after it finishes
      return role === "phone" ? showReceivedOnPhone(results) : showReceivedOnDesktop(uid, results);
    },
    // the shared text box
    textChanged(body) {
      if ($("clip-input").value === body) return;
      $("clip-input").value = body;
      // text arrived while the sheet is closed: the Text button pulses until it is opened
      if (body && document.body.dataset.clip !== "open") $("clip-fab").dataset.unread = "true";
    },
    textStatus(status) {
      const peer = peers.find((p) => p.id === selectedId);
      const name = peer ? peer.name : "the other device";
      $("clip-status").dataset.state = status;
      $("clip-fab").dataset.state = status;
      $("clip-status").textContent = status === "live"
        ? `Live with ${name}`
        : status === "connecting" ? "Connecting…" : `Waiting for ${name} to be online`;
    },
    sendEnded() {
      forgetPending(uid);
    },
    sent(count, total) {
      keepAwake(false);
      forgetPending(uid);
      showTransfer("received", `Sent ${count} file${count === 1 ? "" : "s"}`, formatBytes(total));
      refreshHistory(500);
    },
  };
}

// ---------------------------------------------------------------- status dots

async function ownState() {
  if (session && session.busy) return "busy";
  if (running.role === "desktop" && !(await folderGranted())) return "blocked";
  return "ready";
}

// Asking the browser about the folder on every beat is wasteful, so the answer is kept for a few seconds.
// Choosing or allowing a folder reloads the screen, which starts a fresh check.
const FOLDER_CHECK_MS = 5_000;
let folderCheck = { at: 0, ok: false };

async function folderGranted() {
  if (Date.now() - folderCheck.at < FOLDER_CHECK_MS) return folderCheck.ok;
  const folder = await getFolder(running.uid);
  const ok = Boolean(folder) && (await folderPermission(folder)) === "granted";
  folderCheck = { at: Date.now(), ok };
  return ok;
}

// Shows the session dot and the device list, and tells the person when something changes.
let lastPaint = null;     // the last picture drawn: an unchanged picture is not drawn again

function paint() {
  const paintKey = JSON.stringify([running.role, selectedId, ownNow, presence, peers.map((p) => [p.id, p.name])]);
  if (paintKey === lastPaint) return;
  lastPaint = paintKey;

  const peer = peers.find((p) => p.id === selectedId) || null;
  const peerState = peer ? stateOf(presence, peer.id) : "offline";
  const summary = sessionSummary({ role: running.role, peer, peerState, ownState: ownNow });

  renderPeers($("peer-list"), {
    peers,
    presence,
    selectedId,
    onSelect: (id) => { selectedId = id; paint(); },
    onRemove: running.role === "desktop" ? removePeer : null,
  });
  $("session-dot").dataset.state = summary.state;
  $("session-title").textContent = summary.text;
  // the text box keeps a live link to the chosen device for as long as that device is online
  if (session) session.syncText(peer ? peer.id : null, peerState !== "offline");

  // a short message only when the picture changes, never on every beat
  const key = `${peer ? peer.id : ""}:${summary.state}:${ownNow}`;
  if (key === lastSession) return;
  lastSession = key;
  if (!presenceLoaded || !peer || ownNow === "busy") return;
  setStatus(summary.state === "ready" ? `Connected to ${peer.name}` : summary.text);
}

async function beatOnce() {
  if (!running) return;
  const deviceId = running.deviceId;
  try {
    ownNow = await ownState();
    const reply = await api("POST", "/api/devices/presence", { deviceId, state: ownNow });
    if (!running || running.deviceId !== deviceId) return;      // the screen changed meanwhile
    presence = reply.presence;
    presenceLoaded = true;
  } catch (err) {
    if (err.status === 404 && running) refreshApp();            // this device was removed
    return;                                                     // anything else: keep the last picture
  }

  // a device we have never heard of is online: another device was added, so reload the list
  if (!refreshing && Object.keys(presence).some((id) => !knownIds.has(id))) {
    refreshing = true;
    Promise.resolve(refreshApp()).finally(() => { refreshing = false; });
  }
  paint();
}

let beating = false;      // a slow answer must not pile up more beats behind it

async function beat() {
  if (beating) return;
  beating = true;
  try {
    await beatOnce();
  } finally {
    beating = false;
  }
}

function startPresence() {
  stopPresence();
  beatTimer = every(BEAT_EVERY_MS, beat);
  beat();
}

function stopPresence() {
  lastPaint = null;
  folderCheck = { at: 0, ok: false };
  if (beatTimer) stopTimer(beatTimer);
  beatTimer = null;
  presence = {};
  presenceLoaded = false;
  lastSession = "";
}

async function removePeer(device) {
  if (!confirm(`Remove "${device.name}" from your Vault account?`)) return;
  try {
    await withReauth(() => api("POST", `/api/devices/${device.id}/revoke`));
  } catch (err) {
    setStatus("Could not remove that device");
    return;
  }
  await refreshApp();
}

// How another device (or this one) is doing right now: "ready", "busy", "blocked" or "offline".
export function deviceState(id) {
  if (running && id === running.deviceId) return ownNow;
  return stateOf(presence, id);
}

function syncSendBoxes() {
  const hasPeer = peers.length > 0;
  $("send-box").hidden = running.role !== "desktop" || !hasPeer;
  $("phone-send").hidden = running.role !== "phone" || !hasPeer;
  $("clip-box").hidden = !hasPeer;
  $("clip-fab").hidden = !hasPeer;
  if (!hasPeer) closeClip();
}

// On phones the shared text box is a sheet that slides up when the Text button is tapped.
function openClip() {
  document.body.dataset.clip = "open";
  $("clip-fab").setAttribute("aria-expanded", "true");
  delete $("clip-fab").dataset.unread;
  setTimeout(() => $("clip-input").focus({ preventScroll: true }), 360);     // after the slide-up
}

function closeClip() {
  delete document.body.dataset.clip;
  $("clip-fab").setAttribute("aria-expanded", "false");
  $("clip-input").blur();
}

// ---------------------------------------------------------------- start / stop

export function deactivateTransfers() {
  if (session) session.stop();
  $("clip-box").hidden = true;
  $("clip-fab").hidden = true;
  closeClip();
  $("clip-input").value = "";               // shared text is never kept after leaving the screen
  session = null;
  pending = null;
  running = null;
  stopPresence();
  if (pendingAnswer) pendingAnswer(false);
  $("send-box").hidden = true;
  $("phone-send").hidden = true;
  $("peers-box").hidden = true;
}

// Called by the desktop and phone screens each time they are shown.
export function activateTransfers({ role, uid, identity, devices }) {
  const active = devices.filter((d) => d.status === "active");
  knownIds = new Set(active.map((d) => d.id));

  // A computer sends to phones. A phone can send to the computer and to the account's other phones.
  const peerTypes = role === "desktop" ? ["phone"] : ["desktop", "phone"];
  peers = active
    .filter((d) => peerTypes.includes(d.type) && d.id !== identity.deviceId)
    .sort((a, b) => peerTypes.indexOf(a.type) - peerTypes.indexOf(b.type));   // computers first, so they stay the default
  if (!peers.some((p) => p.id === selectedId)) selectedId = peers.length ? peers[0].id : null;

  // same screen again (for example after a pairing): keep the running transfer, just update the list
  if (session && running.role === role && running.deviceId === identity.deviceId) {
    session.setPeers(peers);
    syncSendBoxes();
    paint();
    loadHistory(identity.deviceId);
    return;
  }
  deactivateTransfers();

  running = { role, uid, deviceId: identity.deviceId };
  session = new TransferSession({
    dialsText: role === "desktop",
    autoResume: true,
    identity,
    uid,
    peers,
    sink: role === "desktop" ? lazyFolderSink(uid) : new PhoneSink(),
    ui: makeUi(role, uid),
  });
  session.start();
  offerPending();

  $("peers-box").hidden = false;
  syncSendBoxes();
  paint();
  startPresence();
  loadHistory(identity.deviceId);
}

function startSending(files, { handles = null, peerId = null } = {}) {
  if (!session || files.length === 0) return;
  if (session.busy) {
    setStatus("Wait for the current transfer to finish.");
    return;
  }

  const target = peers.find((p) => p.id === (peerId || selectedId));
  if (!target) {
    setStatus("Pair a device to send to first.");
    return;
  }
  const state = stateOf(presence, target.id);
  if (presenceLoaded && state !== "ready") {
    setStatus(issueFor(target, state));
    return;
  }

  setStatus("");
  $("received-box").hidden = true;
  savePending({
    uid: running.uid,
    peerId: target.id,
    files: files.map((file, i) => ({ name: file.name, size: file.size, type: file.type, handle: handles && handles[i] ? handles[i] : null })),
  }).catch(() => {});                      // remembered, so a closed page can carry on later
  session.send(files, target.id).catch((err) => {
    forgetPending();
    showTransfer("interrupted", "Could not send", err.message, null, false);
  });
}

// ---------------------------------------------------------------- unfinished sends

// A send that was cut off when the page closed is remembered (names and sizes, plus a file handle where the
// browser allows it). The files are matched again, and the receiver carries on from the blocks it already saved.
function forgetPending(uid = running && running.uid) {
  pending = null;
  if (uid) clearPending(uid).catch(() => {});
}

function describePending(record) {
  const names = record.files.slice(0, 3).map((f) => `${f.name} (${formatBytes(f.size)})`).join(", ");
  return record.files.length > 3 ? `${names} and ${record.files.length - 3} more` : names;
}

function showPending() {
  const peer = peers.find((p) => p.id === pending.peerId);
  const many = pending.files.length > 1;
  const how = pending.handlesOk ? "Tap Resume to continue." : `Tap Resume, then choose the same file${many ? "s" : ""} again.`;
  showTransfer("interrupted", `Unfinished send to ${peer ? peer.name : "your device"}`, `${describePending(pending)}. ${how}`, null, true);
}

// Called when a screen starts: was a send cut off by a closed page?
async function offerPending() {
  const uid = running.uid;
  const record = await loadPending(uid).catch(() => null);
  if (!record || !running || running.uid !== uid || !session || session.busy) return;
  if (!peers.some((p) => p.id === record.peerId)) return forgetPending(uid);
  pending = { ...record, handlesOk: record.files.every((f) => f.handle) };
  showPending();
}

// Chrome and Edge on a computer can hand back file handles, so a send can carry on without choosing the file again.
async function pickFiles(inputId) {
  if (window.showOpenFilePicker && inputId === "send-input") {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      startSending(await Promise.all(handles.map((h) => h.getFile())), { handles });
    } catch (err) {
      if (err.name !== "AbortError") $(inputId).click();       // anything else: use the normal chooser
    }
    return;
  }
  $(inputId).click();
}

function chooseFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
    const finish = (list) => { input.remove(); resolve(list); };
    input.addEventListener("change", () => finish([...input.files]));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

// Files the browser still has a handle for: no need to choose them again.
async function filesFromHandles(list) {
  try {
    const files = [];
    for (const item of list) {
      const ok = (await item.handle.queryPermission({ mode: "read" })) === "granted"
        || (await item.handle.requestPermission({ mode: "read" })) === "granted";
      if (!ok) return null;
      files.push(await item.handle.getFile());
    }
    return files;
  } catch (err) {
    return null;                        // the file moved or was deleted, or access was refused
  }
}

function continuePending() {
  const record = pending;
  if (!record || !session || session.busy) return;

  const go = (files) => {
    const wanted = new Set(record.files.map((f) => `${f.name}|${f.size}`));
    const same = files.filter((file) => wanted.has(`${file.name}|${file.size}`));
    if (!same.length) {
      setStatus(`Those are not the same files. Choose: ${describePending(record)}`);
      return;
    }
    if (same.length < record.files.length) setStatus(`Continuing with ${same.length} of ${record.files.length} files`);
    const handles = same.map((file) => (record.files.find((f) => f.name === file.name && f.size === file.size) || {}).handle || null);
    startSending(same, { handles, peerId: record.peerId });
    if (session && session.busy) pending = null;          // it started; if not, the card stays so the person can try again
  };

  if (record.handlesOk) {
    filesFromHandles(record.files).then((files) => {
      if (files) return go(files);
      record.handlesOk = false;           // refused or gone: fall back to choosing the files again
      showPending();
    });
    return;
  }
  chooseFiles().then((files) => { if (files.length) go(files); });
}

// ---------------------------------------------------------------- dropping files

// What a drop would do right now (and what to tell the person if it cannot happen).
function currentDrop() {
  const peer = peers.find((p) => p.id === selectedId) || null;
  return dropState({
    role: running ? running.role : null,
    peer,
    peerState: peer && presenceLoaded ? stateOf(presence, peer.id) : "offline",
    ownState: ownNow,
    busy: Boolean(session && session.busy),
  });
}

const hasFiles = (event) => Boolean(event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files"));

function dropped(event) {
  event.preventDefault();
  $("send-box").classList.remove("over");
  const files = [];
  const handles = [];                    // file handles, where the browser gives them (it must be asked right now)
  let skippedFolder = false;
  for (const item of event.dataTransfer.items || []) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry && entry.isDirectory) skippedFolder = true;
    else if (item.kind === "file" && item.getAsFile()) {
      files.push(item.getAsFile());
      handles.push(item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null));
    }
  }
  if (skippedFolder) setStatus("Folders can't be sent directly. Zip the folder first, then send the zip file.");
  Promise.all(handles).then((list) => startSending(files, { handles: list.map((h) => (h && h.kind === "file" ? h : null)) }));
}

// The whole page is the drop target. Dropping a file ANYWHERE must never make the browser open it
// (that would leave Vault and end the session), and a file is only sent when the session is ready.
function wireDropTarget() {
  const overlay = $("drop-overlay");
  let depth = 0;
  const hide = () => { depth = 0; overlay.hidden = true; };

  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    const drop = currentDrop();
    overlay.dataset.ok = String(drop.ok);
    $("drop-text").textContent = drop.message;
    overlay.hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = currentDrop().ok ? "copy" : "none";
  });
  document.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    hide();
    const drop = currentDrop();
    if (!drop.ok) {
      setStatus(drop.message);
      return;
    }
    dropped(event);
  });
  window.addEventListener("dragend", hide);
}

// ---------------------------------------------------------------- one-time wiring

// Called once when the page starts. `refresh` re-reads the account and redraws the screen.
export function initTransfers(refresh) {
  refreshApp = refresh;
  PhoneSink.purge();

  const wire = (buttonId, inputId) => {
    $(buttonId).addEventListener("click", () => pickFiles(inputId));
    $(inputId).addEventListener("change", (event) => {
      startSending([...event.target.files]);
      event.target.value = "";          // lets the same file be picked again
    });
  };
  wire("send-btn", "send-input");
  wire("send-photos-btn", "send-photos-input");
  wire("send-files-btn", "send-files-input");
  wireDropTarget();

  // shared text box
  $("clip-input").addEventListener("input", () => { if (session) session.setText($("clip-input").value); });
  $("clip-fab").addEventListener("click", openClip);
  $("clip-close").addEventListener("click", closeClip);
  $("clip-backdrop").addEventListener("click", closeClip);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeClip(); });
  $("clip-clear").addEventListener("click", () => {
    $("clip-input").value = "";
    if (session) session.setText("");
  });
  $("clip-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("clip-input").value);
      setStatus("Copied");
    } catch (err) {
      $("clip-input").select();                    // the browser refused: the text is selected, press Ctrl+C / Copy
      setStatus("Select and copy the text");
    }
  });

  $("incoming-accept").addEventListener("click", () => pendingAnswer && pendingAnswer(true));
  $("incoming-decline").addEventListener("click", () => pendingAnswer && pendingAnswer(false));

  onTransferResume(() => {
    if (session && session.outgoing) return session.resume();     // the page stayed open: carry on from memory
    if (pending) return continuePending();                         // the page was closed: get the files again
  });
  onTransferCancel(() => {
    if (pendingAnswer) pendingAnswer(false);
    forgetPending();
    if (session) session.cancel();
  });

  // coming back to the page: show a fresh status straight away
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    beat();
    if (session) session.networkBack();     // back on screen: retry an interrupted send now
  });

  // The browser says the internet is back: retry an interrupted send now instead of waiting for the timer.
  window.addEventListener("online", () => { if (session) session.networkBack(); });

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