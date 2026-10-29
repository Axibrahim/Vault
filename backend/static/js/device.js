import { kvGet, kvSet, kvDelete } from "./storage.js";

// One identity per Google account, so two accounts in one browser never mix.
const identityKey = (uid) => `device:${uid}`;

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

export const getDeviceIdentity = (uid) => kvGet(identityKey(uid));
export const forgetDeviceIdentity = (uid) => kvDelete(identityKey(uid));