import { api } from "../core/api.js";
import { withReauth } from "../core/auth.js";
import { getDeviceIdentity, forgetDeviceIdentity } from "../device/identity.js";
import {
  pickFolder,
  getFolder,
  forgetFolder,
  folderPermission,
  requestFolderAccess,
} from "../device/folder.js";
import {
  createPairing,
  approvePairing,
  cancelPairing,
  currentPairing,
} from "../device/pairing.js";
import { MAX_PER_TYPE } from "../routing.js";
import { state } from "../state.js";
import { $, setStatus, show, every, stopTimer } from "../ui/dom.js";
import { clearQr, drawQr } from "../ui/qr.js";

let pairTimer = null;
let clockTimer = null;
let pairExpiresAt = 0;

// The enrolled computer: its name, receiving folder, folder access and phone.
export async function showDesktop(identity, devices) {
  $("desktop-name").textContent = identity.name;

  // receiving folder
  const folder = await getFolder(state.uid);
  $("regrant-btn").hidden = true;

  if (!folder) {
    $("desktop-folder").textContent = "none chosen";
    $("folder-access").textContent = "Choose a folder to receive files.";
  } else {
    $("desktop-folder").textContent = folder.name;
    const permission = await folderPermission(folder);
    if (permission === "granted") {
      $("folder-access").textContent = "Access granted.";
    } else {
      $("folder-access").textContent = "The browser needs your permission again.";
      $("regrant-btn").hidden = false;
    }
  }

  // phones (each one is listed, with its status dot, in the devices box below)
  const phones = devices.filter((d) => d.type === "phone" && d.status === "active");
  $("phone-status").textContent = `${phones.length} of ${MAX_PER_TYPE} paired`;
  $("pair-btn").hidden = phones.length >= MAX_PER_TYPE;
  $("pair-box").hidden = true;

  show("desktop");
}

// ---------- pairing a phone ----------

// The code, its QR code and its link are shown only while they work, and are wiped from the page afterwards.
function clearPairingSecrets() {
  if (clockTimer) stopTimer(clockTimer);
  clearQr($("pair-qr"));
  $("pair-code").textContent = "";
  $("pair-link").value = "";
}

function tickClock() {
  const left = Math.max(0, Math.ceil((pairExpiresAt - Date.now()) / 1000));
  $("pair-timer").textContent = `Works once. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`;
}

function endPairing(message) {
  if (pairTimer) stopTimer(pairTimer);
  clearPairingSecrets();
  $("pair-box").hidden = true;
  $("pair-btn").hidden = false;
  setStatus(message);
}

async function refreshPairing() {
  let current;
  try {
    ({ pairing: current } = await currentPairing());
  } catch (err) {
    return;   // try again on the next tick
  }

  if (!current) {
    endPairing("The code expired. Start again if you still want to pair.");
    return;
  }

  pairExpiresAt = new Date(current.expiresAt).getTime();

  if (current.status === "claimed" && current.phone) {
    state.pairing = { pairingId: current.pairingId, fingerprint: current.phone.fingerprint, nearby: current.nearby !== false };
    $("pair-phone-name").textContent = current.phone.name;
    $("pair-fingerprint").textContent = current.phone.fingerprint;
    $("pair-nearby").textContent = state.pairing.nearby
      ? "This phone is on the same network as this computer."
      : "This phone is on a different network than this computer. Approve it only if you are sure it is yours.";
    $("pair-nearby").classList.toggle("far", !state.pairing.nearby);
    $("approve-btn").textContent = state.pairing.nearby ? "Approve" : "Approve anyway";
    $("pair-share").hidden = true;          // the code has been used: it is of no use to anyone now
    clearPairingSecrets();
    $("pair-confirm").hidden = false;
  }
}

function startPairPolling() {
  if (pairTimer) stopTimer(pairTimer);
  pairTimer = every(2000, refreshPairing);
  refreshPairing();
}

export function initDesktop(refresh) {
  $("regrant-btn").addEventListener("click", async () => {
    const folder = await getFolder(state.uid);
    if (folder) await requestFolderAccess(folder);
    await refresh();
  });

  $("change-folder-btn").addEventListener("click", async () => {
    try {
      await pickFolder(state.uid);
    } catch (err) {
      if (err.name !== "AbortError") setStatus("Could not use that folder.");
    }
    await refresh();
  });

  $("remove-btn").addEventListener("click", async () => {
    if (!confirm("Remove this computer from your Vault account? If it is your last computer, paired phones are removed too.")) return;

    const identity = await getDeviceIdentity(state.uid);
    try {
      await withReauth(() => api("POST", `/api/devices/${identity.deviceId}/revoke`));
    } catch (err) {
      setStatus("Could not remove this computer");
      return;
    }
    await forgetDeviceIdentity(state.uid);
    await forgetFolder(state.uid);
    await refresh();
  });

  $("pair-btn").addEventListener("click", async () => {
    const identity = await getDeviceIdentity(state.uid);
    setStatus("");

    let result;
    try {
      result = await withReauth(() => createPairing(identity));
    } catch (err) {
      setStatus("Could not start pairing");
      return;
    }

    // The code rides in the part of the link after "#", which browsers never send to any server.
    const link = `${location.origin}/#pair=${result.code}`;
    drawQr($("pair-qr"), link);
    $("pair-link").value = link;
    $("pair-code").textContent = `${result.code.slice(0, 4)}-${result.code.slice(4)}`;
    pairExpiresAt = new Date(result.expiresAt).getTime();
    tickClock();
    if (clockTimer) stopTimer(clockTimer);
    clockTimer = every(1000, tickClock);

    $("pair-share").hidden = false;
    $("pair-confirm").hidden = true;
    $("pair-box").hidden = false;
    $("pair-btn").hidden = true;
    startPairPolling();
  });

  $("copy-link-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("pair-link").value);
      setStatus("Link copied. It works once, for 2 minutes.");
    } catch (err) {
      $("pair-link").select();               // no clipboard access: let the person copy it by hand
    }
  });

  $("approve-btn").addEventListener("click", async () => {
    const identity = await getDeviceIdentity(state.uid);
    if (pairTimer) stopTimer(pairTimer);

    try {
      await withReauth(() => approvePairing(identity, state.pairing.pairingId, state.pairing.fingerprint, { confirmFar: !state.pairing.nearby }));
    } catch (err) {
      setStatus("Could not approve. Please try again.");
      startPairPolling();
      return;
    }
    setStatus("");
    await refresh();
  });

  $("reject-btn").addEventListener("click", async () => {
    try {
      await cancelPairing(state.pairing.pairingId);
    } catch (err) {
      // the code will expire on its own
    }
    endPairing("Pairing cancelled.");
  });
}