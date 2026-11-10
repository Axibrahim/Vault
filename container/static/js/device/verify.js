// Checks that an offer or answer really was signed by the other device's key.
// The server already checks this, but a device never has to take the server's word for it:
// the signed SDP contains the encryption fingerprint of the connection, so a valid signature
// means the encrypted channel ends at the device you paired.
import { fingerprint } from "./identity.js";
import { kvGet, kvSet } from "../core/storage.js";
import { sha256Hex } from "./transfer-proof.js";

const B64URL = /^[A-Za-z0-9_-]{43}$/;

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function isValidPublicJwk(jwk) {
  return Boolean(jwk) && jwk.kty === "EC" && jwk.crv === "P-256" && B64URL.test(jwk.x) && B64URL.test(jwk.y);
}

async function verifyFrom(evt, action, parts) {
  if (!isValidPublicJwk(evt.fromPublicKey)) throw new Error("Bad device key");
  const jwk = { kty: "EC", crv: "P-256", x: evt.fromPublicKey.x, y: evt.fromPublicKey.y };

  // the fingerprint the server reports must really belong to this key
  if ((await fingerprint(jwk)) !== evt.fromFingerprint) throw new Error("Bad device fingerprint");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const message = ["vault-v1", action, ...parts, evt.challenge].join("|");

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(evt.signature),
      new TextEncoder().encode(message)
    );
  } catch (err) {
    ok = false;
  }
  if (!ok) throw new Error("Signature check failed");
  return evt.fromFingerprint;
}

export async function verifyOffer(evt, myDeviceId) {
  return verifyFrom(evt, "offer", [evt.from, myDeviceId, await sha256Hex(evt.sdp)]);
}

export async function verifyAnswer(evt, offerSdp) {
  return verifyFrom(evt, "answer", [evt.transferId, await sha256Hex(offerSdp), await sha256Hex(evt.sdp)]);
}

// Trust on first use: the first time we talk to a device we remember its fingerprint;
// from then on a different key for the same device id is refused.
export async function pinPeer(uid, deviceId, printed) {
  const key = `peer:${uid}:${deviceId}`;
  const known = await kvGet(key);
  if (!known) {
    await kvSet(key, printed);
    return;
  }
  if (known !== printed) throw new Error("This device's key changed");
}