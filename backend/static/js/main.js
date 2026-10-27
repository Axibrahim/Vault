import { prepareAuth, signInWithGoogle, getMe, logout } from "./auth.js";
import { api } from "./api.js";
import { createDeviceIdentity, getDeviceIdentity, forgetDeviceIdentity } from "./device.js";
import {
  folderSupported,
  pickFolder,
  getFolder,
  forgetFolder,
  folderPermission,
  requestFolderAccess,
} from "./folder.js";

const $ = (id) => document.getElementById(id);

let currentUid = null;
let setupFolder = null;   // folder picked during setup, before enrolling

function show(view) {
  $("login-view").hidden = view !== "login";
  $("app-view").hidden = view === "login";
  $("enroll-view").hidden = view !== "enroll";
  $("desktop-view").hidden = view !== "desktop";
  $("other-view").hidden = view !== "other";
}

function setStatus(message) {
  $("status").textContent = message;
}

// ---------- deciding what to show ----------

async function start() {
  let me;
  try {
    me = await getMe();
  } catch (err) {
    if (err.status === 401) {
      setStatus("Please sign in");
      show("login");
      prepareAuth().catch(() => setStatus("Could not load sign-in"));
    } else {
      setStatus("Server unreachable");
    }
    return;
  }

  currentUid = me.uid;
  $("user-email").textContent = me.email;
  setStatus("");

  try {
    await route();
  } catch (err) {
    setStatus("Could not load your devices");
  }
}

async function route() {
  const { accountState, devices } = await api("GET", "/api/devices");
  const identity = await getDeviceIdentity(currentUid);
  const mine = identity && devices.some((d) => d.id === identity.deviceId && d.status === "active");

  if (mine) {
    await showDesktop(identity);
  } else if (accountState === "no_devices") {
    showEnroll();
  } else {
    showOther(devices);
  }
}

// ---------- enrolling this computer ----------

function showEnroll() {
  setupFolder = null;
  $("device-name").value = "";
  $("folder-label").textContent = "none chosen";
  $("browser-warning").hidden = folderSupported();
  $("folder-btn").disabled = !folderSupported();
  updateEnrollButton();
  show("enroll");
}

function updateEnrollButton() {
  const hasName = $("device-name").value.trim().length > 0;
  $("enroll-btn").disabled = !(hasName && setupFolder);
}

$("device-name").addEventListener("input", updateEnrollButton);

$("folder-btn").addEventListener("click", async () => {
  try {
    setupFolder = await pickFolder(currentUid);
    $("folder-label").textContent = setupFolder.name;
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
    created = await createDeviceIdentity(currentUid, name);
    await api("POST", "/api/devices/enroll-desktop", {
      deviceId: created.identity.deviceId,
      name,
      publicKey: created.publicJwk,
    });
  } catch (err) {
    if (created) await forgetDeviceIdentity(currentUid);
    setStatus(err.status === 409 ? "This account already has a computer set up" : "Setup failed");
    return;
  }

  setStatus("");
  await start();
});

// ---------- the enrolled computer ----------

async function showDesktop(identity) {
  $("desktop-name").textContent = identity.name;

  const folder = await getFolder(currentUid);
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

$("regrant-btn").addEventListener("click", async () => {
  const folder = await getFolder(currentUid);
  if (folder) await requestFolderAccess(folder);
  await start();
});

$("change-folder-btn").addEventListener("click", async () => {
  try {
    await pickFolder(currentUid);
  } catch (err) {
    if (err.name !== "AbortError") setStatus("Could not use that folder.");
  }
  await start();
});

$("remove-btn").addEventListener("click", async () => {
  if (!confirm("Remove this computer from your Vault account?")) return;

  const identity = await getDeviceIdentity(currentUid);
  try {
    await api("POST", `/api/devices/${identity.deviceId}/revoke`);
  } catch (err) {
    setStatus("Could not remove this computer");
    return;
  }
  await forgetDeviceIdentity(currentUid);
  await forgetFolder(currentUid);
  await start();
});

// ---------- an account set up somewhere else ----------

function showOther(devices) {
  const list = $("device-list");
  list.replaceChildren();

  for (const device of devices.filter((d) => d.status === "active")) {
    const item = document.createElement("li");
    item.textContent = device.name + " ";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger";
    button.textContent = "Remove";
    button.addEventListener("click", async () => {
      if (!confirm(`Remove "${device.name}" from your Vault account?`)) return;
      try {
        await api("POST", `/api/devices/${device.id}/revoke`);
      } catch (err) {
        setStatus("Could not remove that computer");
        return;
      }
      await start();
    });

    item.appendChild(button);
    list.appendChild(item);
  }
  show("other");
}

// ---------- sign in / out ----------

$("login-btn").addEventListener("click", async () => {
  setStatus("Signing in...");
  try {
    await signInWithGoogle();
    await start();
  } catch (err) {
    setStatus("Sign-in failed");
  }
});

$("logout-btn").addEventListener("click", async () => {
  try {
    await logout();
  } finally {
    await start();
  }
});

start();