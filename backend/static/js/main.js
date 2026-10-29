// Entry point: decides which screen to show. Each screen lives in views/.
import { prepareAuth, getMe } from "./core/auth.js";
import { api } from "./core/api.js";
import { getDeviceIdentity } from "./device/identity.js";
import { state } from "./state.js";
import { $, setStatus, show } from "./ui/dom.js";
import { initLogin } from "./views/login.js";
import { showEnroll, initEnroll } from "./views/enroll.js";
import { showDesktop, initDesktop } from "./views/desktop.js";
import { showOther } from "./views/other.js";

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

  state.uid = me.uid;
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
  const identity = await getDeviceIdentity(state.uid);
  const mine = identity && devices.some((d) => d.id === identity.deviceId && d.status === "active");

  if (mine) {
    await showDesktop(identity);
  } else if (accountState === "no_devices") {
    showEnroll();
  } else {
    showOther(devices, start);
  }
}

initLogin(start);
initEnroll(start);
initDesktop(start);
start();