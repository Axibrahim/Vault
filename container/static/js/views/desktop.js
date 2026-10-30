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
import { state } from "../state.js";
import { $, setStatus, show, every, stopTimer } from "../ui/dom.js";

let pairTimer = null;

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

  // phone
  const phone = devices.find((d) => d.type === "phone" && d.status === "active");
  state.phoneId = phone ? phone.id : null;
  $("phone-status").textContent = phone ? phone.name : "No phone paired yet";
  $("pair-btn").hidden = Boolean(phone);
  $("remove-phone-btn").hidden = !phone;
  $("pair-box").hidden = true;

  show("desktop");
}

// ---------- pairing a phone ----------

function endPairing(message) {
  if (pairTimer) stopTimer(pairTimer);
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

  const seconds = Math.max(0, Math.round((new Date(current.expiresAt) - Date.now()) / 1000));
  $("pair-timer").textContent = `The code expires in ${seconds} seconds.`;

  if (current.status === "claimed" && current.phone) {
    state.pairing = { pairingId: current.pairingId, fingerprint: current.phone.fingerprint };
    $("pair-phone-name").textContent = current.phone.name;
    $("pair-fingerprint").textContent = current.phone.fingerprint;
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
    if (!confirm("Remove this computer from your Vault account? Paired phones are removed too.")) return;

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

    $("pair-code").textContent = `${result.code.slice(0, 4)}-${result.code.slice(4)}`;
    $("pair-confirm").hidden = true;
    $("pair-box").hidden = false;
    $("pair-btn").hidden = true;
    startPairPolling();
  });

  $("approve-btn").addEventListener("click", async () => {
    const identity = await getDeviceIdentity(state.uid);
    if (pairTimer) stopTimer(pairTimer);

    try {
      await withReauth(() => approvePairing(identity, state.pairing.pairingId, state.pairing.fingerprint));
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

  $("remove-phone-btn").addEventListener("click", async () => {
    if (!state.phoneId || !confirm("Remove the paired phone?")) return;
    try {
      await withReauth(() => api("POST", `/api/devices/${state.phoneId}/revoke`));
    } catch (err) {
      setStatus("Could not remove the phone");
      return;
    }
    await refresh();
  });
}