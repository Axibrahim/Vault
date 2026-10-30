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

// A device that is not set up yet, on an account whose computer already is:
// it joins with the code the computer shows.
export function showPair() {
  $("pair-code-input").value = "";
  $("phone-name").value = "";
  $("claim-wait").hidden = true;
  $("claim-btn").disabled = true;
  show("pair");
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
      setStatus(err.status === 400 ? "That code is invalid or has expired" : "Pairing failed");
      return;
    }

    setStatus("");
    $("claim-fingerprint").textContent = await fingerprint(created.publicJwk);
    $("claim-wait").hidden = false;
    $("claim-btn").disabled = true;
    waitForApproval(created.identity.deviceId, refresh);
  });
}