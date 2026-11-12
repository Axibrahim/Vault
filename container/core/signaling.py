"""In-memory message passing between a user's own devices.

Two devices that want to talk directly (WebRTC) first need to exchange a few
small messages (an "offer", an "answer" and some network addresses). This server
only carries those messages. They live in memory for a few minutes and are never
written to the database. The files themselves never come through here.

This works for ONE server process. With several processes you would move it to
Redis, but one process is enough for a personal app.
"""
import threading
import time
import uuid


class SignalHub:
    """A mailbox per (account, device) that a device can wait on."""

    def __init__(self, ttl=300, max_per_box=200):
        self._ttl = ttl
        self._max = max_per_box
        self._cond = threading.Condition()
        self._boxes = {}      # (uid, device_id) -> [(seq, time, event), ...]
        self._seq = 0

    def publish(self, uid, device_id, event):
        with self._cond:
            self._seq += 1
            box = self._boxes.setdefault((uid, device_id), [])
            now = time.time()
            box.append((self._seq, now, event))

            # keep the mailbox small: drop old and surplus messages
            box[:] = [item for item in box if now - item[1] <= self._ttl][-self._max:]
            self._cond.notify_all()
            return self._seq

    def wait(self, uid, device_id, after, timeout):
        """Messages newer than `after`, waiting up to `timeout` seconds for the first one."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                now = time.time()
                box = self._boxes.get((uid, device_id), [])
                fresh = [(seq, event) for seq, stamp, event in box
                         if seq > after and now - stamp <= self._ttl]
                if fresh:
                    return fresh

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return []
                self._cond.wait(remaining)

    def forget(self, uid, device_id):
        """Throw away a device's mailbox (used when the device is removed)."""
        with self._cond:
            self._boxes.pop((uid, device_id), None)


# ---------- transfer lifecycle ----------
# A transfer is in exactly one state. It only ever moves along the arrows below, and a
# transfer that reached a final state never moves again.
#
#   offered  --> answered --> completed
#      |            |
#      +------------+--> cancelled | declined | failed | expired
OFFERED, ANSWERED = "offered", "answered"
COMPLETED, CANCELLED, DECLINED, FAILED, EXPIRED = "completed", "cancelled", "declined", "failed", "expired"
LIVE = frozenset({OFFERED, ANSWERED})
TERMINAL = frozenset({COMPLETED, CANCELLED, DECLINED, FAILED, EXPIRED})
LEGAL_MOVES = {
    OFFERED: frozenset({ANSWERED, CANCELLED, DECLINED, FAILED, EXPIRED}),
    ANSWERED: frozenset({COMPLETED, CANCELLED, DECLINED, FAILED, EXPIRED}),
}

class TransferRegistry:
    """Who is talking to whom, and which step of the lifecycle each transfer is in.

    Every change of state goes through advance(), under one lock, so two requests that race
    (two answers, a cancel and a finish) can never both win.
    """

    def __init__(self, idle_ttl=1800, offer_ttl=60, max_age=86400, keep_ended=600):
        self._idle = idle_ttl            # seconds without any sign of life before a transfer expires
        self._offer_ttl = offer_ttl      # an offer nobody answered within this time expires
        self._max_age = max_age          # no transfer lives longer than this, however active
        self._keep_ended = keep_ended    # how long a finished transfer is remembered (so late messages are refused)
        self._lock = threading.Lock()
        self._items = {}      # (uid, transfer_id) -> dict

    def _sweep(self, now):
        """Expire what ran out of time and forget what ended long ago. Call with the lock held."""
        for key, item in list(self._items.items()):
            if item["status"] in TERMINAL:
                if now - item["ended"] > self._keep_ended:
                    del self._items[key]
            elif (
                now - item["touched"] > self._idle
                or now - item["created"] > self._max_age
                or (item["status"] == OFFERED and now - item["created"] > self._offer_ttl)
            ):
                item["status"], item["ended"] = EXPIRED, now

    def create(self, uid, from_id, to_id, offer_hash, kind="files", limit=None):
        """Start a transfer. Returns (transfer_id, superseded_ids).

        A fresh signed offer replaces any older live transfer between the same two devices, so an
        interrupted transfer can never be continued with its old authorisation. transfer_id is None
        when `limit` live transfers of this kind already exist (the check and the creation are one
        atomic step, so parallel requests cannot slip past the limit).
        """
        transfer_id = str(uuid.uuid4())
        now = time.time()
        with self._lock:
            self._sweep(now)
            superseded = []
            for (owner, old_id), item in self._items.items():
                if (owner == uid and item["status"] in LIVE and item["from"] == from_id
                        and item["to"] == to_id and item["kind"] == kind):
                    item["status"], item["ended"] = FAILED, now
                    superseded.append(old_id)

            live = sum(1 for (owner, _), item in self._items.items()
                       if owner == uid and item["status"] in LIVE and item["kind"] == kind)
            if limit is not None and live >= limit:
                return None, superseded
            self._items[(uid, transfer_id)] = {
                "from": from_id, "to": to_id, "offer_hash": offer_hash, "kind": kind,
                "status": OFFERED, "ice": 0, "touched": now, "created": now, "ended": None,
            }
        return transfer_id, superseded

    def get(self, uid, transfer_id):
        """A copy of a LIVE transfer, or None (unknown, expired and finished transfers all look the same)."""
        item = self.lookup(uid, transfer_id)
        return item if item and item["status"] in LIVE else None

    def lookup(self, uid, transfer_id):
        """Like get(), but also finds transfers that have already ended (they are kept for a while)."""
        with self._lock:
            self._sweep(time.time())
            item = self._items.get((uid, transfer_id))
            return dict(item) if item else None

    def active_count(self, uid):
        with self._lock:
            self._sweep(time.time())
            return sum(1 for (owner, _), item in self._items.items() if owner == uid and item["status"] in LIVE)

    def advance(self, uid, transfer_id, new_state):
        """Move a transfer to `new_state`.

        Returns "moved", "already" (it had already ended: ending twice is harmless), "illegal"
        (the lifecycle does not allow that move) or "unknown".
        """
        now = time.time()
        with self._lock:
            self._sweep(now)
            item = self._items.get((uid, transfer_id))
            if item is None:
                return "unknown"
            if item["status"] in TERMINAL:
                return "already"
            if new_state not in LEGAL_MOVES[item["status"]]:
                return "illegal"
            item["status"] = new_state
            item["touched"] = now
            if new_state in TERMINAL:
                item["ended"] = now
            return "moved"

    def mark_answered(self, uid, transfer_id):
        """Only the first answer wins. Returns False if it was already answered (or is over)."""
        return self.advance(uid, transfer_id, ANSWERED) == "moved"

    def note_ice(self, uid, transfer_id, limit):
        """Counts a network-address message. Returns False once the limit is reached or the transfer is over."""
        with self._lock:
            item = self._items.get((uid, transfer_id))
            if not item or item["status"] not in LIVE or item["ice"] >= limit:
                return False
            item["ice"] += 1
            item["touched"] = time.time()
            return True

    def touch_device(self, uid, device_id):
        """A device is still online: keep its running transfers from expiring as idle."""
        now = time.time()
        with self._lock:
            for (owner, _), item in self._items.items():
                if owner == uid and item["status"] == ANSWERED and device_id in (item["from"], item["to"]):
                    item["touched"] = now

    def end_device(self, uid, device_id, new_state=FAILED):
        """End every live transfer that involves this device. Returns [(transfer_id, other_device_id)]."""
        now = time.time()
        ended = []
        with self._lock:
            for (owner, transfer_id), item in self._items.items():
                if owner == uid and item["status"] in LIVE and device_id in (item["from"], item["to"]):
                    item["status"], item["ended"] = new_state, now
                    ended.append((transfer_id, item["to"] if device_id == item["from"] else item["from"]))
        return ended


hub = SignalHub()
registry = TransferRegistry()

def end_device_transfers(uid, device_id):
    """A device was removed: stop its transfers, tell the other side, and drop its mailbox."""
    for transfer_id, peer in registry.end_device(uid, device_id):
        hub.publish(uid, peer, {"type": "closed", "transferId": transfer_id, "reason": "revoked"})
    hub.forget(uid, device_id)

class PresenceBoard:
    """Which devices have Vault open right now. In memory only, like the mailboxes above."""

    def __init__(self, fresh=10, keep=600):
        self._fresh = fresh      # seconds a heartbeat counts as "online"
        self._keep = keep        # seconds before a silent device is forgotten completely
        self._lock = threading.Lock()
        self._items = {}         # (uid, device_id) -> (time, state)

    def beat(self, uid, device_id, state):
        now = time.time()
        with self._lock:
            for key in [k for k, (stamp, _) in self._items.items() if now - stamp > self._keep]:
                del self._items[key]
            self._items[(uid, device_id)] = (now, state)

    def known(self, uid, device_id):
        """True if this device sent a beat recently (so the database does not need to be asked again)."""
        with self._lock:
            item = self._items.get((uid, device_id))
            return item is not None and time.time() - item[0] <= self._keep

    def snapshot(self, uid):
        """{device_id: state} for this account's devices that sent a beat in the last `fresh` seconds."""
        now = time.time()
        with self._lock:
            return {
                device: state
                for (owner, device), (stamp, state) in self._items.items()
                if owner == uid and now - stamp <= self._fresh
            }

    def forget(self, uid, device_id):
        with self._lock:
            self._items.pop((uid, device_id), None)


board = PresenceBoard()