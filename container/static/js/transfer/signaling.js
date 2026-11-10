// The only part of a transfer that talks to our server: a few small signed messages so two
// devices can find each other. Files never pass through here.
import { api } from "../core/api.js";
import { sendSignedAnswer, sendSignedIce, sendSignedOffer, closeSignedTransfer } from "../device/transfer-proof.js";
import { verifyAnswer, verifyOffer, pinPeer } from "../device/verify.js";

export const signaling = {
  getIceServers: async () => (await api("GET", "/api/transfers/ice-servers")).iceServers,
  sendOffer: sendSignedOffer,
  sendAnswer: sendSignedAnswer,
  sendIce: sendSignedIce,
  close: closeSignedTransfer,
  verifyOffer,
  verifyAnswer,
  pinPeer,
  poll: (deviceId, after, wait) =>
    api("GET", `/api/transfers/events?device=${deviceId}&after=${after}${wait === undefined ? "" : `&wait=${wait}`}`),
};

// Keeps asking the server "anything for me?". Each request waits up to ~25 s, so it feels instant.
export function listen(deviceId, onEvent, deps = signaling, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let stopped = false;

  (async () => {
    let cursor = 0;
    try {
      // skip anything that was left over from before this page opened
      cursor = (await deps.poll(deviceId, 0, 0)).cursor;
    } catch (err) {
      if (err.status === 401) return;
    }

    while (!stopped) {
      try {
        const reply = await deps.poll(deviceId, cursor);
        cursor = reply.cursor;
        for (const evt of reply.events) {
          if (stopped) break;
          try { await onEvent(evt); } catch (err) { /* one bad message must not stop the loop */ }
        }
      } catch (err) {
        if (err.status === 401) return;           // signed out
        await sleep(err.status === 404 ? 5000 : 2000);
      }
    }
  })();

  return () => { stopped = true; };
}