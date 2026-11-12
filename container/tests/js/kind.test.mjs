// The kind of a connection ("files" or the live text box) is signed with the offer, so it cannot be swapped.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { sendSignedOffer, sha256Hex } from "../../static/js/device/transfer-proof.js";
import { verifyOffer, isValidPublicJwk } from "../../static/js/device/verify.js";
import { fingerprint } from "../../static/js/device/identity.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const challenge = "1700000000.abcdefghijklmnop.mac";
const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const FROM = "d0000000-0000-4000-8000-000000000001";
const TO = "f0000000-0000-4000-8000-000000000002";

async function signedOffer(kind) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/devices/challenge") return { ok: true, status: 200, json: async () => ({ challenge }) };
    body = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ transferId: "t" }) };
  };
  try {
    await (kind === undefined
      ? sendSignedOffer({ deviceId: FROM, privateKey: pair.privateKey }, TO, SDP)
      : sendSignedOffer({ deviceId: FROM, privateKey: pair.privateKey }, TO, SDP, kind));
  } finally {
    globalThis.fetch = original;
  }
  const event = {
    from: FROM, sdp: SDP, challenge, signature: body.signature,
    fromPublicKey: publicKey, fromFingerprint: await fingerprint(publicKey),
  };
  return { body, event };
}

test("a normal file offer does not mention a kind and verifies as before", async () => {
  const { body, event } = await signedOffer();
  assert.equal("kind" in body, false);
  assert.equal(await verifyOffer(event, TO), event.fromFingerprint);
  assert.equal(await verifyOffer({ ...event, kind: "files" }, TO), event.fromFingerprint);
});

test("a text-box offer carries its kind and verifies as a text-box offer", async () => {
  const { body, event } = await signedOffer("clip");
  assert.equal(body.kind, "clip");
  assert.equal(await verifyOffer({ ...event, kind: "clip" }, TO), event.fromFingerprint);
});

test("the kind cannot be added to, or removed from, a signed offer", async () => {
  const files = await signedOffer();
  await assert.rejects(() => verifyOffer({ ...files.event, kind: "clip" }, TO), /Signature check failed/);
  const clip = await signedOffer("clip");
  await assert.rejects(() => verifyOffer(clip.event, TO), /Signature check failed/);               // kind stripped
  await assert.rejects(() => verifyOffer({ ...clip.event, kind: "files" }, TO), /Signature check failed/);
});

test("an offer for another device, or with another SDP, does not verify", async () => {
  const { event } = await signedOffer("clip");
  await assert.rejects(() => verifyOffer({ ...event, kind: "clip" }, "someone-else"), /Signature check failed/);
  await assert.rejects(() => verifyOffer({ ...event, kind: "clip", sdp: SDP + "x" }, TO), /Signature check failed/);
  assert.equal(await sha256Hex(SDP) === await sha256Hex(SDP), true);
  assert.equal(isValidPublicJwk(event.fromPublicKey), true);
});