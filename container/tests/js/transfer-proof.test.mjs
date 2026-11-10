
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  sha256Hex,
  sendSignedOffer,
  sendSignedAnswer,
  sendSignedIce,
  closeSignedTransfer,
  recordSignedTransfer,
} from "../../static/js/device/transfer-proof.js";

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const originalFetch = globalThis.fetch;

let identity;
let keyPair;
let requests;

const challenge = "test-challenge-123";

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    Buffer.from(base64, "base64")
  );
}

async function hash(value) {
  return sha256Hex(value);
}

async function verifySignature(body, action, parts) {
  const message = [
    "vault-v1",
    action,
    ...parts,
    challenge,
  ].join("|");

  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    decodeBase64Url(body.signature),
    new TextEncoder().encode(message)
  );
}

function mockFetch() {
  requests = [];

  globalThis.fetch = async (url, options = {}) => {
    requests.push({
      url,
      options,
      body: options.body ? JSON.parse(options.body) : null,
    });

    const isChallenge = url === "/api/devices/challenge";

    return {
      ok: true,
      status: 200,
      json: async () =>
        isChallenge
          ? { challenge }
          : { success: true },
    };
  };
}

async function setupIdentity() {
  keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );

  identity = {
    deviceId: "test-device-001",
    privateKey: keyPair.privateKey,
  };
}

beforeEach(async () => {
  mockFetch();
  await setupIdentity();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("sha256Hex returns the correct SHA-256 hash", async () => {
  assert.equal(
    await hash("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
});

test("sha256Hex returns different hashes for different content", async () => {
  assert.notEqual(
    await hash("file-one"),
    await hash("file-two")
  );
});

test("sendSignedOffer creates and signs a valid offer", async () => {
  const sdp = "test-offer-sdp";
  const toDeviceId = "receiver-001";

  const result = await sendSignedOffer(
    identity,
    toDeviceId,
    sdp
  );

  assert.deepEqual(result, { success: true });
  assert.equal(requests.length, 2);

  assert.equal(
    requests[1].url,
    "/api/transfers/offer"
  );

  const body = requests[1].body;

  assert.equal(body.deviceId, identity.deviceId);
  assert.equal(body.toDeviceId, toDeviceId);
  assert.equal(body.sdp, sdp);
  assert.equal(body.challenge, challenge);

  assert.equal(
    await verifySignature(body, "offer", [
      identity.deviceId,
      toDeviceId,
      await hash(sdp),
    ]),
    true
  );
});

test("sendSignedAnswer signs the offer and answer hashes", async () => {
  const transferId = "transfer-001";
  const offerSdp = "original-offer";
  const answerSdp = "receiver-answer";

  await sendSignedAnswer(
    identity,
    transferId,
    offerSdp,
    answerSdp
  );

  const body = requests[1].body;

  assert.equal(
    requests[1].url,
    `/api/transfers/${transferId}/answer`
  );

  assert.equal(body.sdp, answerSdp);

  assert.equal(
    await verifySignature(body, "answer", [
      transferId,
      await hash(offerSdp),
      await hash(answerSdp),
    ]),
    true
  );
});

test("sendSignedIce signs the ICE candidate correctly", async () => {
  const transferId = "transfer-002";

  const candidate = {
    candidate: "candidate:123 1 UDP 12345",
    sdpMid: "0",
    sdpMLineIndex: 0,
  };

  await sendSignedIce(identity, transferId, candidate);

  const body = requests[1].body;

  assert.equal(
    requests[1].url,
    `/api/transfers/${transferId}/ice`
  );

  assert.equal(body.candidate, candidate.candidate);
  assert.equal(body.sdpMid, "0");
  assert.equal(body.sdpMLineIndex, 0);

  assert.equal(
    await verifySignature(body, "ice", [
      transferId,
      await hash(candidate.candidate),
      "0",
      "0",
    ]),
    true
  );
});

test("sendSignedIce supports missing optional candidate fields", async () => {
  const transferId = "transfer-003";

  await sendSignedIce(identity, transferId, {
    candidate: "candidate:test",
  });

  const body = requests[1].body;

  assert.equal(body.candidate, "candidate:test");

  assert.equal(
    await verifySignature(body, "ice", [
      transferId,
      await hash("candidate:test"),
      "",
      "",
    ]),
    true
  );
});

test("closeSignedTransfer signs the default close reason", async () => {
  const transferId = "transfer-004";

  await closeSignedTransfer(identity, transferId);

  const body = requests[1].body;

  assert.equal(
    requests[1].url,
    `/api/transfers/${transferId}/close`
  );

  assert.equal(body.reason, "done");

  assert.equal(
    await verifySignature(body, "close", [
      transferId,
      "done",
    ]),
    true
  );
});

test("closeSignedTransfer supports a custom reason", async () => {
  const transferId = "transfer-005";

  await closeSignedTransfer(
    identity,
    transferId,
    "cancelled"
  );

  const body = requests[1].body;

  assert.equal(body.reason, "cancelled");

  assert.equal(
    await verifySignature(body, "close", [
      transferId,
      "cancelled",
    ]),
    true
  );
});

test("recordSignedTransfer signs transfer history details", async () => {
  const transferId = "transfer-006";
  const toDeviceId = "receiver-002";
  const files = 3;
  const bytes = 2048;

  await recordSignedTransfer(
    identity,
    transferId,
    toDeviceId,
    files,
    bytes
  );

  const body = requests[1].body;

  assert.equal(
    requests[1].url,
    "/api/transfers/record"
  );

  assert.equal(body.transferId, transferId);
  assert.equal(body.toDeviceId, toDeviceId);
  assert.equal(body.files, files);
  assert.equal(body.bytes, bytes);

  assert.equal(
    await verifySignature(body, "record", [
      transferId,
      toDeviceId,
      String(files),
      String(bytes),
    ]),
    true
  );
});

test("all signed requests obtain a fresh challenge", async () => {
  await sendSignedOffer(identity, "receiver", "offer");

  assert.equal(requests[0].url, "/api/devices/challenge");
  assert.equal(requests[1].url, "/api/transfers/offer");
});

test("signed requests include the device identity", async () => {
  await closeSignedTransfer(identity, "transfer-007");

  assert.equal(
    requests[1].body.deviceId,
    identity.deviceId
  );

  assert.ok(requests[1].body.signature);
  assert.ok(requests[1].body.challenge);
});

test("server errors are propagated to the caller", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      error: "Invalid device signature",
      code: "invalid_signature",
    }),
  });

  await assert.rejects(
    sendSignedOffer(identity, "receiver", "offer"),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "invalid_signature");
      return true;
    }
  );
});
