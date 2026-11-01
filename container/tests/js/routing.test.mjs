// Run with:  node --test "tests/js/*.test.mjs"     (Node 22 or newer; run it from the container/ folder)
import test from "node:test";
import assert from "node:assert/strict";

import { detectDeviceKind } from "../../static/js/device/kind.js";
import { pickScreen } from "../../static/js/routing.js";

const desktopRecord = { id: "d1", type: "desktop", status: "active" };
const phoneRecord = { id: "p1", type: "phone", status: "active" };

// ---------- which screen ----------

test("an enrolled computer always sees its own screen", () => {
  for (const kind of ["computer", "phone"]) {
    for (const accountState of ["desktop_enrolled", "phone_paired"]) {
      assert.equal(pickScreen({ kind, accountState, mine: desktopRecord }), "desktop");
    }
  }
});

test("a paired phone always sees its own screen", () => {
  assert.equal(pickScreen({ kind: "phone", accountState: "phone_paired", mine: phoneRecord }), "phone");
});

test("a new computer is asked to set itself up", () => {
  assert.equal(pickScreen({ kind: "computer", accountState: "no_devices", mine: null }), "enroll");
});

test("a new phone is NEVER asked to set up as the computer", () => {
  assert.equal(pickScreen({ kind: "phone", accountState: "no_devices", mine: null }), "needComputer");
});

test("a new phone joins with the code once the computer is ready", () => {
  assert.equal(pickScreen({ kind: "phone", accountState: "desktop_enrolled", mine: null }), "pair");
});

test("a computer that is not the enrolled one is NEVER asked to pair like a phone", () => {
  assert.equal(pickScreen({ kind: "computer", accountState: "desktop_enrolled", mine: null }), "other");
  assert.equal(pickScreen({ kind: "computer", accountState: "phone_paired", mine: null }), "other");
});

test("a second phone is told one is already paired", () => {
  assert.equal(pickScreen({ kind: "phone", accountState: "phone_paired", mine: null }), "other");
});

// ---------- phone or computer ----------

const env = (userAgent, extra = {}) => ({
  navigator: { userAgent, maxTouchPoints: 0, ...(extra.navigator || {}) },
  matchMedia: extra.matchMedia,
});

const UA = {
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  ipadAsMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
};

test("computers are detected as computers", () => {
  assert.equal(detectDeviceKind(env(UA.windowsChrome)), "computer");
  assert.equal(detectDeviceKind(env(UA.macSafari)), "computer");
  assert.equal(detectDeviceKind(env(UA.linuxFirefox)), "computer");
});

test("phones are detected as phones", () => {
  assert.equal(detectDeviceKind(env(UA.androidChrome)), "phone");
  assert.equal(detectDeviceKind(env(UA.iphone)), "phone");
});

test("Chromium's mobile flag wins", () => {
  const e = env(UA.windowsChrome, { navigator: { userAgentData: { mobile: true } } });
  assert.equal(detectDeviceKind(e), "phone");
});

test("an iPad that calls itself a Mac is a phone, a real Mac is not", () => {
  assert.equal(detectDeviceKind(env(UA.ipadAsMac, { navigator: { maxTouchPoints: 5 } })), "phone");
  assert.equal(detectDeviceKind(env(UA.macSafari)), "computer");
});

test("'Request desktop site' on a phone is still a phone", () => {
  const e = env(UA.linuxFirefox, { matchMedia: (q) => ({ matches: q.includes("pointer: coarse") }) });
  assert.equal(detectDeviceKind(e), "phone");
});

test("a touch laptop with a trackpad is still a computer", () => {
  const e = env(UA.windowsChrome, { navigator: { maxTouchPoints: 10 }, matchMedia: () => ({ matches: false }) });
  assert.equal(detectDeviceKind(e), "computer");
});

test("a missing navigator does not crash", () => {
  assert.equal(detectDeviceKind({}), "computer");
});