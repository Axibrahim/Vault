import { api } from "../core/api.js";
import { signMessage } from "./identity.js";

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createSignedBody(identity, action, parts, extra = {}) {
  const { challenge } = await api("POST", "/api/devices/challenge");

  const message = [
    "vault-v1",
    action,
    ...parts,
    challenge,
  ].join("|");

  const signature = await signMessage(identity, message);

  return {
    ...extra,
    deviceId: identity.deviceId,
    challenge,
    signature,
  };
}

export async function sendSignedIce(identity, transferId, candidate) {
  const candidateText = candidate.candidate;
  const mid = candidate.sdpMid ?? "";
  const index =
    candidate.sdpMLineIndex == null
      ? ""
      : String(candidate.sdpMLineIndex);

  const candidateHash = await sha256Hex(candidateText);

  const body = await createSignedBody(
    identity,
    "ice",
    [transferId, candidateHash, mid, index],
    {
      candidate: candidateText,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    }
  );

  return api(
    "POST",
    `/api/transfers/${transferId}/ice`,
    body
  );
}

export async function closeSignedTransfer(identity, transferId, reason = "done") {
  const body = await createSignedBody(
    identity,
    "close",
    [transferId, reason],
    { reason }
  );

  return api(
    "POST",
    `/api/transfers/${transferId}/close`,
    body
  );
}