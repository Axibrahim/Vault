import { api } from "../core/api.js";
import { createDeviceIdentity, forgetDeviceIdentity } from "../device/identity.js";
import { folderSupported, pickFolder } from "../device/folder.js";
import { state } from "../state.js";
import { $, setStatus, show } from "../ui/dom.js";

export function showEnroll() {
  state.setupFolder = null;
  $("device-name").value = "";
  $("folder-label").textContent = "none chosen";
  $("browser-warning").hidden = folderSupported();
  $("folder-btn").disabled = !folderSupported();
  updateEnrollButton();
  show("enroll");
}

function updateEnrollButton() {
  const hasName = $("device-name").value.trim().length > 0;
  $("enroll-btn").disabled = !(hasName && state.setupFolder);
  $("step-name").dataset.done = hasName;
  $("step-folder").dataset.done = !!state.setupFolder;
}

export function initEnroll(refresh) {
  $("device-name").addEventListener("input", updateEnrollButton);

  $("folder-btn").addEventListener("click", async () => {
    try {
      state.setupFolder = await pickFolder(state.uid);
      $("folder-label").textContent = state.setupFolder.name;
      setStatus("");
    } catch (err) {
      if (err.name !== "AbortError") {
        setStatus("Could not use that folder. Try a different one.");
      }
    }
    updateEnrollButton();
  });

  $("enroll-btn").addEventListener("click", async () => {
    const name = $("device-name").value.trim();
    let created = null;

    setStatus("Setting up...");
    try {
      created = await createDeviceIdentity(state.uid, name);
      await api("POST", "/api/devices/enroll-desktop", {
        deviceId: created.identity.deviceId,
        name,
        publicKey: created.publicJwk,
      });
    } catch (err) {
      if (created) await forgetDeviceIdentity(state.uid);
      setStatus(err.status === 409 ? "This account already has a computer set up" : "Setup failed");
      return;
    }

    setStatus("");
    await refresh();
  });
}