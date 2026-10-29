import { api } from "../core/api.js";
import { getDeviceIdentity, forgetDeviceIdentity } from "../device/identity.js";
import {
  pickFolder,
  getFolder,
  forgetFolder,
  folderPermission,
  requestFolderAccess,
} from "../device/folder.js";
import { state } from "../state.js";
import { $, setStatus, show } from "../ui/dom.js";

// The enrolled computer: shows its name, receiving folder and folder access.
export async function showDesktop(identity) {
  $("desktop-name").textContent = identity.name;

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
  show("desktop");
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
    if (!confirm("Remove this computer from your Vault account?")) return;

    const identity = await getDeviceIdentity(state.uid);
    try {
      await api("POST", `/api/devices/${identity.deviceId}/revoke`);
    } catch (err) {
      setStatus("Could not remove this computer");
      return;
    }
    await forgetDeviceIdentity(state.uid);
    await forgetFolder(state.uid);
    await refresh();
  });
}