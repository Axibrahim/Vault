// Settings: swaps the main panel for the account's devices, activity and security.
// Everything shown comes from /api/settings, which the server builds from the verified Google session.
import { api } from "../core/api.js";
import { withReauth } from "../core/auth.js";
import { forgetFolder } from "../device/folder.js";
import { forgetDeviceIdentity, getDeviceIdentity } from "../device/identity.js";
import { state } from "../state.js";
import { deviceState } from "../transfer/controller.js";
import { $, setStatus } from "../ui/dom.js";
import { loadHistory } from "../ui/history.js";
import { STATE_LABEL } from "../ui/peers.js";
import { describeDevice, fullTime, initialOf, removalWarning } from "../ui/settings-format.js";

const TABS = ["devices", "activity", "security"];
const DEVICES_HINT = "Each device has a short code. The same code is shown on that device when it is paired.";
const ARM_MS = 5000;
const LIVE_MS = 5000;

let isOpen = false;
let tab = "devices";
let account = null;       // the last answer of /api/settings
let myId = null;          // this browser's device id, if it is set up
let refreshApp = async () => {};
let armed = null;         // the Remove button waiting for its second tap: { id, button, timer }
let liveTimer = null;
let rows = new Map();     // device id -> { dot, label }, so status can change without redrawing the list

export const showSettingsButton = (visible) => { $("settings-btn").hidden = !visible; };

// ---------------------------------------------------------------- tabs

function moveInk() {
  const button = $(`tab-${tab}`);
  const ink = $("tab-ink");
  ink.style.setProperty("--ink-x", `${button.offsetLeft}px`);
  ink.style.setProperty("--ink-w", `${button.offsetWidth}px`);
}

function selectTab(name, { focus = false } = {}) {
  tab = name;
  for (const id of TABS) {
    const on = id === name;
    $(`tab-${id}`).setAttribute("aria-selected", String(on));
    $(`tab-${id}`).tabIndex = on ? 0 : -1;
    $(`tabpanel-${id}`).hidden = !on;
  }
  moveInk();
  if (name === "activity") loadHistory(myId);
  if (focus) $(`tab-${name}`).focus();
}

function onTabKey(event) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  selectTab(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length], { focus: true });
}

// ---------------------------------------------------------------- devices

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.button.dataset.armed = "false";
  armed.button.textContent = "Remove";
  armed = null;
  $("settings-devices-hint").textContent = DEVICES_HINT;
}

async function performRemove(device) {
  const mine = device.id === myId;
  try {
    await withReauth(() => api("POST", `/api/devices/${device.id}/revoke`));
  } catch (err) {
    setStatus("Could not remove that device");
    return;
  }
  if (mine) {
    await forgetDeviceIdentity(state.uid);
    if (device.type === "desktop") await forgetFolder(state.uid);
  }
  setStatus("");
  await refreshApp();                    // redraw the main screen behind Settings
  if (mine) closeSettings();             // this browser is no longer a device, so show what comes next
  else await reload();
}

// First tap asks, second tap removes. No pop-up window, and a pause cancels it.
function onRemoveTap(device, button, lastComputer) {
  if (armed && armed.id === device.id) {
    disarm();
    performRemove(device);
    return;
  }
  disarm();
  button.dataset.armed = "true";
  button.textContent = "Tap again to remove";
  armed = { id: device.id, button, timer: setTimeout(disarm, ARM_MS) };
  $("settings-devices-hint").textContent = removalWarning(device, device.id === myId, lastComputer);
}

function paintLive() {
  for (const [id, { dot, label }] of rows) {
    const status = deviceState(id);
    dot.dataset.state = status;
    label.textContent = STATE_LABEL[status];
  }
}

function paintDevices() {
  const list = $("settings-devices");
  list.replaceChildren();
  rows = new Map();
  const lastComputer = account.devices.filter((d) => d.type === "desktop").length === 1;

  account.devices.forEach((device, index) => {
    const info = describeDevice(device, myId);
    const row = document.createElement("li");
    row.className = "sdevice";
    row.dataset.mine = String(info.mine);
    row.style.setProperty("--i", String(index));

    const main = document.createElement("div");
    main.className = "sdevice-main";
    const name = document.createElement("span");
    name.className = "sdevice-name";
    name.textContent = info.name;
    if (info.mine) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "This device";
      name.append(badge);
    }
    const kind = document.createElement("small");
    kind.textContent = `${info.kind}. ${info.added}.`;
    const code = document.createElement("code");
    code.className = "fp";
    code.textContent = info.fingerprint;
    main.append(name, kind, code);

    const status = document.createElement("span");
    status.className = "sdevice-state";
    const dot = document.createElement("i");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    status.append(dot, label);
    rows.set(device.id, { dot, label });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger small";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => onRemoveTap(device, remove, lastComputer));

    const side = document.createElement("div");
    side.className = "sdevice-side";
    side.append(status, remove);

    row.append(main, side);
    list.append(row);
  });

  $("settings-devices-hint").textContent = account.devices.length ? DEVICES_HINT : "No devices are set up on this account yet.";
  paintLive();
}

// ---------------------------------------------------------------- account and security

function paintAccount() {
  $("settings-email").textContent = account.account.email;
  $("settings-avatar").textContent = initialOf(account.account.email);
  $("sec-signed-in").textContent = fullTime(account.account.signedInAt);
  $("sec-expires").textContent = fullTime(account.account.sessionExpiresAt);
}

async function reload() {
  const identity = state.uid ? await getDeviceIdentity(state.uid) : null;
  myId = identity ? identity.deviceId : null;
  try {
    account = await api("GET", "/api/settings");
  } catch (err) {
    if (err.status === 401) {
      closeSettings();
      await refreshApp();                // signed out meanwhile: show the sign-in screen
    } else {
      setStatus("Could not load settings");
    }
    return;
  }
  paintAccount();
  paintDevices();
  moveInk();
  loadHistory(myId);
}

// ---------------------------------------------------------------- open and close

export async function openSettings() {
  if (isOpen) return;
  isOpen = true;
  document.body.dataset.panel = "settings";
  $("settings-view").hidden = false;
  $("settings-btn").setAttribute("aria-expanded", "true");
  selectTab(tab);
  liveTimer = setInterval(paintLive, LIVE_MS);
  await reload();
}

export function closeSettings({ restoreFocus = false } = {}) {
  disarm();
  clearInterval(liveTimer);
  liveTimer = null;
  isOpen = false;
  delete document.body.dataset.panel;
  $("settings-view").hidden = true;
  $("settings-btn").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("settings-btn").focus();
}

// `refresh` re-reads the account and redraws the main screen.
export function initSettings(refresh) {
  refreshApp = refresh;

  $("settings-btn").addEventListener("click", () => (isOpen ? closeSettings({ restoreFocus: true }) : openSettings()));
  $("settings-done").addEventListener("click", () => closeSettings({ restoreFocus: true }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen) closeSettings({ restoreFocus: true });
  });
  window.addEventListener("resize", () => { if (isOpen) moveInk(); });

  for (const id of TABS) $(`tab-${id}`).addEventListener("click", () => selectTab(id));
  $("tab-devices").parentElement.addEventListener("keydown", onTabKey);
}