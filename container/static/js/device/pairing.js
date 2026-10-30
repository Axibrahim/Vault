import { api } from "../core/api.js";
import { signMessage } from "./identity.js";

async function getChallenge() {
  const { challenge } = await api("POST", "/api/devices/challenge");
  return challenge;
}

// The message layout must match the server exactly (see routes/pairing.py):
//   vault-v1|<action>|<details...>|<challenge>

// Computer: prove we are the enrolled computer, then ask for a pairing code.
export async function createPairing(identity) {
  const challenge = await getChallenge();
  const signature = await signMessage(identity, `vault-v1|pairing-create|${challenge}`);
  return api("POST", "/api/pairing/create", {
    deviceId: identity.deviceId,
    challenge,
    signature,
  });
}

// Computer: approve exactly this phone (its fingerprint is part of what we sign).
export async function approvePairing(identity, pairingId, phoneFingerprint) {
  const challenge = await getChallenge();
  const signature = await signMessage(
    identity,
    `vault-v1|pairing-approve|${pairingId}|${phoneFingerprint}|${challenge}`
  );
  return api("POST", `/api/pairing/${pairingId}/approve`, {
    deviceId: identity.deviceId,
    challenge,
    signature,
  });
}

export const cancelPairing = (pairingId) => api("POST", `/api/pairing/${pairingId}/cancel`);
export const currentPairing = () => api("GET", "/api/pairing/current");

// Phone: send the code, a name and the PUBLIC key.
export const claimPairing = (body) => api("POST", "/api/pairing/claim", body);