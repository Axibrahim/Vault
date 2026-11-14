import { api } from "../core/api.js";
import {
  createDeviceIdentity,
  forgetDeviceIdentity,
  fingerprint,
} from "../device/identity.js";
import { claimPairing } from "../device/pairing.js";
import { state } from "../state.js";
import { $, setStatus, show, every, stopTimer } from "../ui/dom.js";

let waitTimer = null;

// The QR code on the computer holds a link like  https://vault.example/#pair=ABCD2345  (no 0, O, 1, I, L or U).
// The part after "#" is never sent to a server. We read it once, keep it in memory only, and wipe it from the
// address bar and history. It is good for as long as the code is: 2 minutes.
const CODE_IN_LINK = /^#pair=([2-9A-HJKMNP-TV-Z]{8})$/i;
const LINK_CODE_LIFETIME_MS = 2 * 60 * 1000;
let fromLink = null;

function takeCodeFromLink() {
  const match = CODE_IN_LINK.exec(location.hash);
  if (!match) return;
  fromLink = { code: match[1].toUpperCase(), at: Date.now() };
  history.replaceState(null, "", location.pathname + location.search);
}

takeCodeFromLink();

// A friendly default, so pairing is one tap. It is only a name for the list of devices.
function guessDeviceName() {
  const ua = navigator.userAgent || "";
  if (/iPad/i.test(ua)) return "iPad";
  if (/iPhone|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android phone";
  return "My phone";
}

// A device that is not set up yet, on an account whose computer already is:
// it joins with the code the computer shows (typed, or arriving by QR code / link).
export function showPair() {
  const link = fromLink && Date.now() - fromLink.at < LINK_CODE_LIFETIME_MS ? fromLink : null;
  fromLink = null;                                  // used once

  $("pair-code-input").value = link ? `${link.code.slice(0, 4)}-${link.code.slice(4)}` : "";
  $("phone-name").value = guessDeviceName();
  $("claim-wait").hidden = true;
  updateClaimButton();
  show("pair");

  if (link) {
    setStatus("Code filled in from the QR code. Check the name, then tap Pair.");
    $("claim-btn").focus();
  }
}

function updateClaimButton() {
  const codeLength = $("pair-code-input").value.replace(/[\s-]/g, "").length;
  const hasName = $("phone-name").value.trim().length > 0;
  $("claim-btn").disabled = !(codeLength === 8 && hasName);
}

function waitForApproval(deviceId, refresh) {
  if (waitTimer) stopTimer(waitTimer);
  let ticks = 0;

  waitTimer = every(2000, async () => {
    ticks += 1;
    try {
      const { devices } = await api("GET", "/api/devices");
      if (devices.some((d) => d.id === deviceId && d.status === "active")) {
        await refresh();
        return;
      }
    } catch (err) {
      // keep trying
    }

    if (ticks > 100) {
      await forgetDeviceIdentity(state.uid);
      setStatus("Pairing timed out. Please try again.");
      showPair();
    }
  });
}

export function initPair(refresh) {
  $("pair-code-input").addEventListener("input", updateClaimButton);
  $("phone-name").addEventListener("input", updateClaimButton);

  $("claim-btn").addEventListener("click", async () => {
    const name = $("phone-name").value.trim();
    const code = $("pair-code-input").value;
    let created = null;

    setStatus("Pairing...");
    try {
      created = await createDeviceIdentity(state.uid, name);
      await claimPairing({
        code,
        deviceId: created.identity.deviceId,
        name,
        publicKey: created.publicJwk,
      });
    } catch (err) {
      if (created) await forgetDeviceIdentity(state.uid);
      setStatus(err.status === 400 || err.status === 403 ? err.message : "Pairing failed");
      return;
    }

    setStatus("");
    $("claim-fingerprint").textContent = await fingerprint(created.publicJwk);
    $("claim-wait").hidden = false;
    $("claim-btn").disabled = true;
    waitForApproval(created.identity.deviceId, refresh);
  });
}