"""Requirements 7 and 10: reconnection needs fresh proof, and every transfer follows a strict lifecycle.

These tests attack the server the way a malicious or buggy client would: replayed signatures, stale
transfer IDs, late messages after a transfer ended, removed devices, illegal state changes and races.
"""
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from core.deviceauth import device_has_expired
from core.signaling import LEGAL_MOVES, TERMINAL, SignalHub, TransferRegistry, end_device_transfers, hub, registry
from tests.helpers import Device
from tests.test_transfers import (
    SDP, poll, send_answer, send_close, send_ice, send_offer, sha, start_transfer,
)


class Clock:
    """A clock the test winds forward by hand, so nothing here depends on how fast the machine is."""

    def __init__(self):
        self.now = time.time()

    def time(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr("core.signaling.time", fake)
    return fake


def running(api, desktop, phone):
    """A transfer that was offered by the phone and answered by the computer."""
    transfer_id = start_transfer(api, phone, desktop)
    assert send_answer(api, desktop, transfer_id).status_code == 200
    return transfer_id


def state_of(transfer_id):
    return registry.lookup("user-1", transfer_id)["status"]


# ======================= 7. unauthorized reconnection =======================

def test_a_signed_offer_cannot_be_replayed(api, pair):
    desktop, phone = pair
    body = api.signed(phone, "offer", [phone.device_id, desktop.device_id, sha(SDP)],
                      toDeviceId=desktop.device_id, sdp=SDP)
    assert api.post("/api/transfers/offer", json=body).status_code == 201
    assert api.post("/api/transfers/offer", json=body).status_code == 403          # same challenge, same signature


def test_a_signed_answer_cannot_be_replayed_on_a_new_transfer(api, pair):
    desktop, phone = pair
    first = start_transfer(api, phone, desktop)
    answer = api.signed(desktop, "answer", [first, sha(SDP), sha("v=0 answer sdp goes here...")],
                        sdp="v=0 answer sdp goes here...")
    assert api.post(f"/api/transfers/{first}/answer", json=answer).status_code == 200
    second = start_transfer(api, phone, desktop)
    assert api.post(f"/api/transfers/{second}/answer", json=answer).status_code == 403


def test_a_signature_for_one_transfer_is_useless_on_another(api, pair):
    desktop, phone = pair
    first = start_transfer(api, phone, desktop)
    body = api.signed(phone, "close", [first, "cancelled"], reason="cancelled")
    second = start_transfer(api, phone, desktop)                                   # supersedes the first
    assert api.post(f"/api/transfers/{second}/close", json=body).status_code == 403


def test_a_removed_device_cannot_start_a_transfer(api, pair, seed):
    desktop, phone = pair
    seed.device(phone, status="revoked")
    assert send_offer(api, phone, desktop).status_code == 403


def test_a_removed_device_cannot_answer(api, pair, seed):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    seed.device(desktop, status="revoked")
    assert send_answer(api, desktop, transfer_id).status_code == 403


def test_an_unknown_device_cannot_start_a_transfer(api, pair):
    desktop, _ = pair
    assert send_offer(api, Device("phone"), desktop).status_code == 403


def test_an_expired_device_is_rejected_everywhere(api, pair, db):
    desktop, phone = pair
    devices = db.collection("users").document("user-1").collection("devices")
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    devices.document(phone.device_id).update({"expires_at": past})
    assert send_offer(api, phone, desktop).status_code == 403                      # cannot sign in as the sender
    assert api.get(f"/api/transfers/events?device={phone.device_id}&wait=0").status_code == 404
    assert api.post("/api/devices/presence", json={"deviceId": phone.device_id, "state": "ready"}).status_code == 404
    assert send_offer(api, desktop, phone).status_code == 404                      # and cannot be the receiver


def test_a_device_that_has_not_expired_yet_still_works(api, pair, db):
    desktop, phone = pair
    future = datetime.now(timezone.utc) + timedelta(days=1)
    db.collection("users").document("user-1").collection("devices").document(phone.device_id).update(
        {"expires_at": future})
    assert send_offer(api, phone, desktop).status_code == 201


@pytest.mark.parametrize("value,expired", [
    (None, False),
    (datetime.now(timezone.utc) + timedelta(hours=1), False),
    (datetime.now(timezone.utc) - timedelta(hours=1), True),
    (datetime.now() + timedelta(days=2), False),                  # a naive date is read as UTC
    (datetime(2001, 1, 1), True),
    ("tomorrow", True),                                           # unreadable: fail closed
    (12345, True),
])
def test_device_expiry_rules(value, expired):
    assert device_has_expired({"expires_at": value}) is expired
    assert device_has_expired({}) is False


def test_a_new_offer_replaces_the_old_transfer_between_the_same_devices(api, pair):
    desktop, phone = pair
    old = running(api, desktop, phone)
    new = start_transfer(api, phone, desktop)
    assert old != new
    assert state_of(old) == "failed"
    assert registry.get("user-1", old) is None

    events = poll(api, desktop)["events"]
    closed = [e for e in events if e["type"] == "closed"]
    assert closed == [{"seq": closed[0]["seq"], "type": "closed", "transferId": old, "reason": "error"}]
    assert events.index(closed[0]) < [e["type"] for e in events].index("offer", 1)     # told BEFORE the new offer


def test_an_interrupted_transfer_cannot_use_its_old_authorisation(api, pair):
    desktop, phone = pair
    old = running(api, desktop, phone)
    start_transfer(api, phone, desktop)                                           # the resume: a brand new offer
    assert send_ice(api, phone, old).status_code == 404                           # old ID: no more network messages
    assert send_answer(api, desktop, old).status_code == 404
    assert send_close(api, phone, old, "done").status_code == 200                 # harmless, ignored
    assert state_of(old) == "failed"                                              # still failed, never "completed"


def test_replacing_a_transfer_does_not_touch_other_pairs(api, pair, seed):
    desktop, phone = pair
    other_phone = Device("phone", "Other phone")
    seed.device(other_phone)
    mine = start_transfer(api, phone, desktop)
    other = start_transfer(api, other_phone, desktop)
    assert registry.get("user-1", mine) and registry.get("user-1", other)


def test_the_opposite_direction_is_a_different_pair(api, pair):
    desktop, phone = pair
    first = start_transfer(api, phone, desktop)
    second = start_transfer(api, desktop, phone)
    assert registry.get("user-1", first) and registry.get("user-1", second)


def test_an_unanswered_offer_expires(api, pair, clock):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    clock.advance(registry._offer_ttl + 1)
    assert send_answer(api, desktop, transfer_id).status_code == 404
    assert state_of(transfer_id) == "expired"


def test_an_answer_just_inside_the_offer_window_is_accepted(api, pair, clock):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    clock.advance(registry._offer_ttl - 1)
    assert send_answer(api, desktop, transfer_id).status_code == 200


def test_the_limit_is_checked_atomically_under_parallel_requests():
    reg = TransferRegistry()
    results = []

    def start(n):
        results.append(reg.create("u", f"from-{n}", f"to-{n}", "h", limit=3)[0])

    threads = [threading.Thread(target=start, args=(n,)) for n in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(1 for transfer_id in results if transfer_id) == 3
    assert reg.active_count("u") == 3


def test_only_one_of_two_parallel_answers_wins():
    reg = TransferRegistry()
    transfer_id, _ = reg.create("u", "a", "b", "h")
    wins = []
    threads = [threading.Thread(target=lambda: wins.append(reg.mark_answered("u", transfer_id))) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert wins.count(True) == 1


# ======================= 10. the transfer lifecycle =======================

def test_the_lifecycle_has_no_way_out_of_a_final_state():
    assert set(LEGAL_MOVES) == {"offered", "answered"}
    for final in TERMINAL:
        assert final not in LEGAL_MOVES


@pytest.mark.parametrize("first", sorted(TERMINAL))
@pytest.mark.parametrize("second", ["answered", "completed", "cancelled", "declined", "failed", "expired"])
def test_a_finished_transfer_never_moves_again(first, second):
    reg = TransferRegistry()
    transfer_id, _ = reg.create("u", "a", "b", "h")
    reg.mark_answered("u", transfer_id)
    assert reg.advance("u", transfer_id, first) == "moved"
    assert reg.advance("u", transfer_id, second) == "already"
    assert reg.lookup("u", transfer_id)["status"] == first


def test_an_unanswered_transfer_cannot_be_completed():
    reg = TransferRegistry()
    transfer_id, _ = reg.create("u", "a", "b", "h")
    assert reg.advance("u", transfer_id, "completed") == "illegal"
    assert reg.advance("u", transfer_id, "offered") == "illegal"
    assert reg.advance("u", "missing", "failed") == "unknown"
    assert reg.lookup("u", transfer_id)["status"] == "offered"


def test_close_before_the_answer_cannot_say_done(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = send_close(api, phone, transfer_id, "done")
    assert response.status_code == 409
    assert state_of(transfer_id) == "offered"
    assert [e["type"] for e in poll(api, desktop)["events"]] == ["offer"]          # nothing was announced


def test_the_receiving_device_cannot_declare_a_transfer_complete(api, pair):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    response = send_close(api, desktop, transfer_id, "done")                      # the computer only receives
    assert response.status_code == 403
    assert state_of(transfer_id) == "answered"


@pytest.mark.parametrize("reason", ["done", "declined", "cancelled", "error"])
def test_closing_twice_is_harmless_and_announces_once(api, pair, reason):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    assert send_close(api, phone, transfer_id, reason).status_code == 200
    first_state = state_of(transfer_id)
    announced = len(poll(api, desktop)["events"])

    assert send_close(api, phone, transfer_id, reason).status_code == 200        # the retry
    assert send_close(api, phone, transfer_id, "error").status_code == 200       # even with another reason
    assert state_of(transfer_id) == first_state
    assert len(poll(api, desktop)["events"]) == announced


def test_nothing_is_forwarded_after_a_transfer_ended(api, pair):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    assert send_close(api, phone, transfer_id, "cancelled").status_code == 200
    before = poll(api, desktop)["cursor"]

    assert send_ice(api, phone, transfer_id).status_code == 404
    assert send_ice(api, desktop, transfer_id).status_code == 404
    assert send_answer(api, desktop, transfer_id).status_code == 404
    assert poll(api, desktop, after=before)["events"] == []
    assert poll(api, phone, after=poll(api, phone)["cursor"])["events"] == []


def test_a_stranger_cannot_close_a_finished_transfer_either(api, pair, seed):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    send_close(api, phone, transfer_id, "cancelled")
    stranger = Device("phone")
    seed.device(stranger)
    assert send_close(api, stranger, transfer_id, "error").status_code == 403


def test_closing_a_transfer_that_vanished_in_between_is_a_404(api, pair, monkeypatch):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    monkeypatch.setattr("routes.transfers.registry.advance", lambda uid, tid, state: "unknown")
    assert send_close(api, phone, transfer_id, "cancelled").status_code == 404


def test_ended_transfers_are_remembered_for_a_while_and_then_forgotten(clock):
    reg = TransferRegistry(keep_ended=100)
    transfer_id, _ = reg.create("u", "a", "b", "h")
    reg.advance("u", transfer_id, "cancelled")
    clock.advance(99)
    assert reg.lookup("u", transfer_id)["status"] == "cancelled"
    clock.advance(2)
    assert reg.lookup("u", transfer_id) is None


def test_no_transfer_lives_forever_even_if_it_stays_busy(clock):
    reg = TransferRegistry(idle_ttl=1000, max_age=100)
    transfer_id, _ = reg.create("u", "a", "b", "h")
    reg.mark_answered("u", transfer_id)
    for _ in range(5):
        clock.advance(30)
        reg.touch_device("u", "a")                          # always active, never idle
    assert reg.get("u", transfer_id) is None
    assert reg.lookup("u", transfer_id)["status"] == "expired"


def test_note_ice_refuses_a_transfer_that_is_over():
    reg = TransferRegistry()
    transfer_id, _ = reg.create("u", "a", "b", "h")
    reg.advance("u", transfer_id, "failed")
    assert reg.note_ice("u", transfer_id, 10) is False


def test_the_clip_kind_is_signed_and_limited_separately(api, pair, flask_app, monkeypatch):
    desktop, phone = pair
    monkeypatch.setitem(flask_app.config, "MAX_ACTIVE_TRANSFERS", 1)

    def clip_offer(sender, target, **overrides):
        body = api.signed(sender, "offer", [sender.device_id, target.device_id, sha(SDP), "clip"],
                          toDeviceId=target.device_id, sdp=SDP, kind="clip")
        body.update(overrides)
        return api.post("/api/transfers/offer", json=body)

    assert clip_offer(desktop, phone).status_code == 201
    assert send_offer(api, desktop, phone).status_code == 201                      # files have their own allowance
    assert poll(api, phone)["events"][0]["kind"] == "clip"
    assert poll(api, phone)["events"][1]["kind"] == "files"

    # the kind cannot be changed after signing, and cannot be dropped to dodge the clip rules
    forged = clip_offer(phone, desktop, kind="files")
    assert forged.status_code == 403
    assert clip_offer(phone, desktop, kind="other").status_code == 400
    assert clip_offer(phone, desktop, kind=["clip"]).status_code == 400
    assert clip_offer(phone, desktop, kind=None).status_code == 400


# ======================= removing a device ends its transfers =======================

def test_removing_a_device_ends_its_transfers_and_tells_the_peer(api, pair, login):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    other = start_transfer(api, desktop, phone)                                    # a second, offered transfer
    login(age=10)
    body_events = poll(api, desktop)["cursor"]

    assert api.post(f"/api/devices/{phone.device_id}/revoke", json={}).status_code == 200
    assert state_of(transfer_id) in {"failed"} and state_of(other) == "failed"

    events = poll(api, desktop, after=body_events)["events"]
    assert {(e["transferId"], e["reason"]) for e in events if e["type"] == "closed"} == {
        (transfer_id, "revoked"), (other, "revoked")}


def test_a_removed_device_loses_its_mailbox(api, pair, login):
    desktop, phone = pair
    start_transfer(api, desktop, phone)
    assert poll(api, phone)["events"]
    login(age=10)
    assert api.post(f"/api/devices/{phone.device_id}/revoke", json={}).status_code == 200
    assert hub.wait("user-1", phone.device_id, 0, 0) == []


def test_removing_the_last_computer_also_ends_the_phones_transfers(api, pair, login):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    login(age=10)
    assert api.post(f"/api/devices/{desktop.device_id}/revoke", json={}).status_code == 200
    assert state_of(transfer_id) == "failed"
    api_presence = api.post("/api/devices/presence", json={"deviceId": phone.device_id, "state": "ready"})
    assert api_presence.status_code == 404                  # the phone it vouched for is gone, and not "online"


def test_a_removed_phone_cannot_stay_online_through_the_presence_cache(api, pair, login):
    desktop, phone = pair
    assert api.post("/api/devices/presence", json={"deviceId": phone.device_id, "state": "ready"}).status_code == 200
    login(age=10)
    assert api.post(f"/api/devices/{desktop.device_id}/revoke", json={}).status_code == 200
    assert api.post("/api/devices/presence", json={"deviceId": phone.device_id, "state": "ready"}).status_code == 404


def test_hub_forget_is_harmless_for_unknown_devices():
    box = SignalHub()
    box.forget("u", "never-existed")
    box.publish("u", "d", {"n": 1})
    box.forget("u", "d")
    assert box.wait("u", "d", 0, 0) == []


def test_end_device_transfers_leaves_other_accounts_alone():
    one, _ = registry.create("alice", "a", "b", "h")
    two, _ = registry.create("bob", "a", "b", "h")
    end_device_transfers("alice", "a")
    assert registry.lookup("alice", one)["status"] == "failed"
    assert registry.lookup("bob", two)["status"] == "offered"


# ======================= long transfers stay alive while a device is online =======================

def test_presence_beats_keep_a_long_transfer_alive(api, pair, clock):
    desktop, phone = pair
    transfer_id = running(api, desktop, phone)
    for _ in range(10):                                         # far longer than the idle limit, beat by beat
        clock.advance(registry._idle / 2)
        assert api.post("/api/devices/presence", json={"deviceId": phone.device_id, "state": "busy"}).status_code == 200
    assert registry.get("user-1", transfer_id) is not None

    clock.advance(registry._idle + 1)                           # both devices went silent
    assert registry.get("user-1", transfer_id) is None
    assert state_of(transfer_id) == "expired"


def test_a_beat_does_not_revive_an_unanswered_offer(api, pair, clock):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    clock.advance(registry._offer_ttl - 1)
    api.post("/api/devices/presence", json={"deviceId": phone.device_id, "state": "ready"})
    clock.advance(2)
    assert registry.get("user-1", transfer_id) is None


def test_a_beat_from_another_device_does_not_keep_a_transfer_alive(api, pair, seed, clock):
    desktop, phone = pair
    stranger = Device("phone", "Not part of it")
    seed.device(stranger)
    transfer_id = running(api, desktop, phone)
    before = registry.lookup("user-1", transfer_id)["touched"]
    clock.advance(10)
    api.post("/api/devices/presence", json={"deviceId": stranger.device_id, "state": "ready"})
    assert registry.lookup("user-1", transfer_id)["touched"] == before


def test_transfer_ids_are_unguessable_uuid4s():
    ids = {registry.create("u", "a", "b", "h")[0] for _ in range(50)}
    assert len(ids) == 50
    assert all(uuid.UUID(i).version == 4 for i in ids)