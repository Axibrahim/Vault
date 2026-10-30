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


class TransferRegistry:
    """Who is talking to whom. Keeps the other side from being spoofed."""

    def __init__(self, idle_ttl=1800):
        self._idle = idle_ttl
        self._lock = threading.Lock()
        self._items = {}      # (uid, transfer_id) -> dict

    def _purge(self, now):
        for key in [k for k, v in self._items.items() if now - v["touched"] > self._idle]:
            del self._items[key]

    def create(self, uid, from_id, to_id, offer_hash):
        transfer_id = str(uuid.uuid4())
        now = time.time()
        with self._lock:
            self._purge(now)
            self._items[(uid, transfer_id)] = {
                "from": from_id, "to": to_id, "offer_hash": offer_hash,
                "status": "offered", "ice": 0, "touched": now,
            }
        return transfer_id

    def get(self, uid, transfer_id):
        with self._lock:
            self._purge(time.time())
            item = self._items.get((uid, transfer_id))
            return dict(item) if item else None

    def active_count(self, uid):
        with self._lock:
            self._purge(time.time())
            return sum(1 for (u, _) in self._items if u == uid)

    def mark_answered(self, uid, transfer_id):
        """Only the first answer wins. Returns False if it was already answered."""
        with self._lock:
            item = self._items.get((uid, transfer_id))
            if not item or item["status"] != "offered":
                return False
            item["status"] = "answered"
            item["touched"] = time.time()
            return True

    def note_ice(self, uid, transfer_id, limit):
        """Counts a network-address message. Returns False once the limit is reached."""
        with self._lock:
            item = self._items.get((uid, transfer_id))
            if not item or item["ice"] >= limit:
                return False
            item["ice"] += 1
            item["touched"] = time.time()
            return True

    def remove(self, uid, transfer_id):
        with self._lock:
            self._items.pop((uid, transfer_id), None)


hub = SignalHub()
registry = TransferRegistry()