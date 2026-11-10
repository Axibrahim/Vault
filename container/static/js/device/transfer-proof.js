import { api } from "../core/api.js";
import { signMessage } from "./identity.js";

export async function sha256Hex(value) {
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

export async function sendSignedOffer(identity, toDeviceId, sdp) {
  const body = await createSignedBody(
    identity,
    "offer",
    [identity.deviceId, toDeviceId, await sha256Hex(sdp)],
    { toDeviceId, sdp }
  );

  return api("POST", "/api/transfers/offer", body);
}

export async function sendSignedAnswer(identity, transferId, offerSdp, sdp) {
  const body = await createSignedBody(
    identity,
    "answer",
    [transferId, await sha256Hex(offerSdp), await sha256Hex(sdp)],
    { sdp }
  );

  return api("POST", `/api/transfers/${transferId}/answer`, body);
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


export async function recordSignedTransfer(identity, transferId, toDeviceId, files, bytes) {
  const body = await createSignedBody(
    identity,
    "record",
    [transferId, toDeviceId, String(files), String(bytes)],
    { transferId, toDeviceId, files, bytes }
  );

  return api("POST", "/api/transfers/record", body);
}