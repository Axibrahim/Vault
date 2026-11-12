// Every connection between two devices is in exactly one state and may only move along these arrows.
// Both devices run their own copy of this, so neither has to trust the other to stop in time.
//
//   connecting --> waiting --> transferring --> completed
//        |            |             |
//        +------------+-------------+--> failed | cancelled | declined | expired
//
// A connection that reached a final state never moves again, so late messages, late data and
// repeated clean-ups find nothing to act on.
export const S = Object.freeze({
  CONNECTING: "connecting",        // dialling, or answering an offer
  WAITING: "waiting",              // the file list is out; waiting for the other side to accept
  TRANSFERRING: "transferring",    // accepted: data may flow
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  DECLINED: "declined",
  EXPIRED: "expired",
});

const NEXT = {
  [S.CONNECTING]: S.WAITING,
  [S.WAITING]: S.TRANSFERRING,
  [S.TRANSFERRING]: S.COMPLETED,
};
const ENDINGS = new Set([S.FAILED, S.CANCELLED, S.DECLINED, S.EXPIRED]);

export const isFinal = (state) => state === S.COMPLETED || ENDINGS.has(state);

export class Lifecycle {
  constructor(onChange = () => {}) {
    this.state = S.CONNECTING;
    this._onChange = onChange;
  }

  get final() {
    return isFinal(this.state);
  }

  can(next) {
    if (this.final) return false;
    return NEXT[this.state] === next || ENDINGS.has(next);
  }

  // Returns true if the move happened. An illegal move changes nothing (and is not an error:
  // clean-up code can call this as often as it likes).
  move(next) {
    if (!this.can(next)) return false;
    this.state = next;
    this._onChange(next);
    return true;
  }

  // Throws unless the connection is in one of the given states.
  require(...allowed) {
    if (!allowed.includes(this.state)) throw new Error(`Not allowed while the transfer is ${this.state}`);
  }
}