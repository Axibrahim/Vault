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
import { initPwa } from "./ui/pwa.js";

async function start() {
  let me;
  try {
    me = await getMe();
  } catch (err) {
    if (err.status === 401) {
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
  const mine = identity ? devices.find((d) => d.id === identity.deviceId && d.status === "active") : null;
  const kind = detectDeviceKind();

  switch (pickScreen({ kind, accountState, mine: mine || null })) {
    case "desktop":
      await showDesktop(identity, devices);
      break;
    case "phone":
      showPhone(identity);
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
start();