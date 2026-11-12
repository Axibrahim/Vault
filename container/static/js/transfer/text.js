// The shared text box: whatever is typed on one device shows up on the other straight away.
// It travels over the same kind of direct, signed device-to-device connection as files, never through
// the server, and it is only ever put into a text box as plain text (never as HTML).
export const MAX_TEXT_CHARS = 100_000;
export const TEXT_LABEL = "txt";
const SEND_DEBOUNCE_MS = 150;       // typing is sent in small bursts, not one message per key
const FLOOD_LIMIT = 40;             // the most messages one second may bring before the link is cut

export function parseTextMessage(data) {
  if (typeof data !== "string" || data.length > MAX_TEXT_CHARS + 200) throw new Error("Bad message");
  const msg = JSON.parse(data);
  if (!msg || typeof msg !== "object" || msg.t !== "text") throw new Error("Unknown message");
  if (!Number.isSafeInteger(msg.rev) || msg.rev < 0 || msg.rev > 2 ** 31) throw new Error("Bad text version");
  if (typeof msg.body !== "string" || msg.body.length > MAX_TEXT_CHARS) throw new Error("Bad text");
  return { rev: msg.rev, body: msg.body };
}

// Which of two versions wins: the newer revision; on a tie, the one from the device with the larger id.
// Every device applies the same rule, so both always end up with the same text.
export const wins = (a, b) => a.rev > b.rev || (a.rev === b.rev && a.from > b.from);

export class TextSync {
  constructor(deviceId, { onText = () => {}, onStatus = () => {}, now = Date.now } = {}) {
    this.me = deviceId;
    this.onText = onText;
    this.onStatus = onStatus;
    this.now = now;
    this.doc = { rev: 0, from: deviceId, body: "" };
    this.status = "offline";          // "offline" | "connecting" | "live"
    this.peer = null;                 // set while a live channel is attached
    this.send = null;
    this.pending = null;
    this.recent = [];
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  // A live channel to this device is ready.
  attach(peerId, send) {
    this.peer = peerId;
    this.send = send;
    this.recent = [];
    this.setStatus("live");
    this._push();                     // so a device that just joined sees the current text
  }

  // The channel is gone. Nothing more is sent or accepted until a new one is attached.
  detach() {
    clearTimeout(this.pending);
    this.pending = null;
    this.send = null;
    this.peer = null;
  }

  // The person typed.
  edit(body) {
    const clean = String(body).slice(0, MAX_TEXT_CHARS);
    if (clean === this.doc.body) return;
    this.doc = { rev: this.doc.rev + 1, from: this.me, body: clean };
    if (this.send && !this.pending) {
      this.pending = setTimeout(() => {
        this.pending = null;
        this._push();
      }, SEND_DEBOUNCE_MS);
    }
  }

  // The other device sent something. Throws if it is not a valid message (the caller cuts the link).
  receive(raw) {
    if (!this.peer) return;           // late data from a link that already ended is never accepted
    const now = this.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    this.recent.push(now);
    if (this.recent.length > FLOOD_LIMIT) throw new Error("Too many messages");

    const msg = parseTextMessage(raw);
    const incoming = { rev: msg.rev, from: this.peer, body: msg.body };
    if (!wins(incoming, this.doc)) return;
    this.doc = incoming;
    this.onText(incoming.body);
  }

  _push() {
    if (this.send) this.send({ t: "text", rev: this.doc.rev, body: this.doc.body });
  }
}