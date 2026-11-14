// Entry point: decides which screen to show. Each screen lives in views/.
import { prepareAuth, getMe } from "./core/auth.js";
import { api } from "./core/api.js";
import { getDeviceIdentity } from "./device/identity.js";
import { detectDeviceKind } from "./device/kind.js";
import { pickScreen } from "./routing.js";
import { state } from "./state.js";
import { $, setStatus, show } from "./ui/dom.js";
import { initLogin, showLoginOptions } from "./views/login.js";
import { showEnroll, initEnroll } from "./views/enroll.js";
import { showDesktop, initDesktop } from "./views/desktop.js";
import { showPair, initPair } from "./views/pair.js";
import { showPhone, initPhone } from "./views/phone.js";
import { showOther } from "./views/other.js";
import { closeAbout, initAbout, showAboutButton } from "./views/about.js";
import { initPwa } from "./ui/pwa.js";
import { activateTransfers, deactivateTransfers, initTransfers } from "./transfer/controller.js";

async function start() {
  let me;
  try {
    me = await getMe();
  } catch (err) {
    if (err.status === 401) {
      closeSettings();
      closeAbout();
      showSettingsButton(false);
      showAboutButton(false);
      deactivateTransfers();
      setStatus("Please sign in");
      showLoginOptions();
      show("login");
      prepareAuth().catch(() => setStatus("Could not load sign-in"));
    } else {
      setStatus("Server unreachable");
    }
    return;
  }

  state.uid = me.uid;
  $("settings-email").textContent = me.email;
  showSettingsButton(true);
  showAboutButton(true);
  setStatus("");

  try {
    await route();
  } catch (err) {
    setStatus("Could not load your devices");
  }
}

async function route() {
  const { devices } = await api("GET", "/api/devices");
  const identity = await getDeviceIdentity(state.uid);
  const active = devices.filter((d) => d.status === "active");
  const mine = identity ? active.find((d) => d.id === identity.deviceId) : null;
  const counts = {
    desktop: active.filter((d) => d.type === "desktop").length,
    phone: active.filter((d) => d.type === "phone").length,
  };
  const kind = detectDeviceKind();

  const screen = pickScreen({ kind, counts, mine: mine || null });
  if (screen !== "desktop" && screen !== "phone") deactivateTransfers();

  switch (screen) {
    case "desktop":
      await showDesktop(identity, devices);
      activateTransfers({ role: "desktop", uid: state.uid, identity, devices });
      break;
    case "phone":
      showPhone(identity);
      activateTransfers({ role: "phone", uid: state.uid, identity, devices });
      break;
    case "pair":
      showPair();
      break;
    case "enroll":
      showEnroll();
      break;
    case "needComputer":
      showOther(devices, start, "needComputer");
      break;
    default:
      showOther(devices, start, kind);
  }
}

initLogin(start);
initEnroll(start);
initDesktop(start);
initPair(start);
initPhone(start);
initPwa();
initTransfers(start);
initSettings(start);
initAbout();
start();