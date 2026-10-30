import { kvGet, kvSet, kvDelete } from "../core/storage.js";

// One identity per Google account, so two accounts in one browser never mix.
const identityKey = (uid) => `device:${uid}`;

const toBase64Url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// A short code made from the public key. Both screens show it so a person can compare.
export async function fingerprint(publicJwk) {
  const bytes = new TextEncoder().encode(`${publicJwk.x}.${publicJwk.y}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12)].join("-");
}

export async function createDeviceIdentity(uid, name) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,               // the private key can never be exported or read back
    ["sign", "verify"]
  );

  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  const identity = {
    deviceId: crypto.randomUUID(),
    name,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
  await kvSet(identityKey(uid), identity);

  // Only the public half ever leaves this browser.
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return { identity, publicJwk };
}

// Signs a text message with this device's private key. Returns base64url (r||s).
export async function signMessage(identity, message) {
  const data = new TextEncoder().encode(message);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.privateKey,
    data
  );
  return toBase64Url(signature);
}

export const getDeviceIdentity = (uid) => kvGet(identityKey(uid));
export const forgetDeviceIdentity = (uid) => kvDelete(identityKey(uid));