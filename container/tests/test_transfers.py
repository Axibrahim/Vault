import base64
import hashlib
import hmac
import time
import uuid

import pytest

from core.deviceauth import fingerprint
from core.signaling import hub, registry
from tests.helpers import Device

SDP = "v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\n"
CANDIDATE = "candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host"


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


@pytest.fixture
def pair(desktop, seed, db):
    """An account with a paired phone. Returns (computer, phone)."""
    phone = Device("phone", "My phone")
    seed.device(phone)
    db.collection("users").document("user-1").update({"account_state": "phone_paired"})
    return desktop, phone


def send_offer(api, sender, target, offer_sdp=SDP, **overrides):
    body = api.signed(
        sender, "offer", [sender.device_id, target.device_id, sha(offer_sdp)],
        toDeviceId=target.device_id, sdp=offer_sdp,
    )
    body.update(overrides)
    return api.post("/api/transfers/offer", json=body)


def start_transfer(api, sender, target):
    response = send_offer(api, sender, target)
    assert response.status_code == 201
    return response.get_json()["transferId"]


def send_answer(api, responder, transfer_id, sdp="v=0 answer sdp goes here...", **overrides):
    offer_hash = registry.get("user-1", transfer_id)["offer_hash"]
    body = api.signed(
        responder, "answer", [transfer_id, offer_hash, sha(sdp)], sdp=sdp,
    )
    body.update(overrides)
    return api.post(f"/api/transfers/{transfer_id}/answer", json=body)


def send_ice(api, device, transfer_id, candidate=CANDIDATE, mid="0", index=0, **overrides):
    body = api.signed(
        device, "ice",
        [transfer_id, sha(candidate), mid or "", str(index) if index is not None else ""],
        candidate=candidate, sdpMid=mid, sdpMLineIndex=index,
    )
    body.update(overrides)
    return api.post(f"/api/transfers/{transfer_id}/ice", json=body)


def send_close(api, device, transfer_id, reason="done", **overrides):
    body = api.signed(device, "close", [transfer_id, reason], reason=reason)
    body.update(overrides)
    return api.post(f"/api/transfers/{transfer_id}/close", json=body)


def poll(api, device, after=0, wait=0):
    response = api.get(f"/api/transfers/events?device={device.device_id}&after={after}&wait={wait}")
    assert response.status_code == 200
    return response.get_json()


# ---------- GET /api/transfers/ice-servers ----------

def test_ice_servers_requires_login(api):
    assert api.get("/api/transfers/ice-servers").status_code == 401


def test_ice_servers_returns_stun_only_by_default(api, login):
    login()
    assert api.get("/api/transfers/ice-servers").get_json() == {
        "iceServers": [{"urls": ["stun:stun.example.com:3478"]}]
    }


def test_ice_servers_adds_short_lived_turn_credentials(api, login, flask_app, monkeypatch):
    monkeypatch.setitem(flask_app.config, "TURN_URLS", "turns:a.example.com:5349, turn:b.example.com:3478")
    monkeypatch.setitem(flask_app.config, "TURN_SECRET", "turn-secret")
    login("user-7")

    servers = api.get("/api/transfers/ice-servers").get_json()["iceServers"]
    assert len(servers) == 2
    turn = servers[1]
    assert turn["urls"] == ["turns:a.example.com:5349", "turn:b.example.com:3478"]

    expires, uid = turn["username"].split(":")
    assert uid == "user-7"
    assert 3500 < int(expires) - time.time() <= 3600
    expected = base64.b64encode(hmac.new(b"turn-secret", turn["username"].encode(), hashlib.sha1).digest()).decode()
    assert turn["credential"] == expected


def test_ice_servers_can_be_empty(api, login, flask_app, monkeypatch):
    monkeypatch.setitem(flask_app.config, "STUN_URLS", "")
    login()
    assert api.get("/api/transfers/ice-servers").get_json() == {"iceServers": []}


# ---------- POST /api/transfers/offer ----------

def test_offer_requires_login(api):
    assert api.post("/api/transfers/offer", json={}).status_code == 401


@pytest.mark.parametrize("overrides", [
    {"deviceId": None},
    {"toDeviceId": "nope"},
    {"sdp": None},
    {"sdp": "short"},
    {"sdp": "x" * 16001},
])
def test_offer_rejects_bad_input(api, pair, overrides):
    desktop, phone = pair
    response = send_offer(api, desktop, phone, **overrides)
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_offer_to_yourself_is_rejected(api, pair):
    desktop, _ = pair
    response = api.post("/api/transfers/offer", json=api.signed(
        desktop, "offer", [desktop.device_id, desktop.device_id, sha(SDP)],
        toDeviceId=desktop.device_id, sdp=SDP,
    ))
    assert response.status_code == 400


def test_offer_needs_a_valid_signature(api, pair):
    desktop, phone = pair
    forged = Device("phone")
    forged.device_id = phone.device_id
    response = send_offer(api, forged, desktop)
    assert response.status_code == 403
    assert response.get_json() == {"error": "Device check failed"}


def test_offer_signature_covers_the_sdp(api, pair):
    desktop, phone = pair
    body = api.signed(desktop, "offer", [desktop.device_id, phone.device_id, sha(SDP)],
                      toDeviceId=phone.device_id, sdp=SDP + "tampered")
    assert api.post("/api/transfers/offer", json=body).status_code == 403


def test_offer_to_an_unknown_device(api, pair):
    desktop, _ = pair
    ghost = Device("phone")
    assert send_offer(api, desktop, ghost).status_code == 404


def test_offer_to_a_revoked_device(api, pair, seed):
    desktop, phone = pair
    seed.device(phone, status="revoked")
    assert send_offer(api, desktop, phone).status_code == 404


def test_offer_creates_a_transfer_and_notifies_the_other_device(api, pair):
    desktop, phone = pair
    response = send_offer(api, phone, desktop)
    assert response.status_code == 201
    transfer_id = response.get_json()["transferId"]

    transfer = registry.get("user-1", transfer_id)
    assert transfer["from"] == phone.device_id and transfer["to"] == desktop.device_id
    assert transfer["offer_hash"] == sha(SDP)

    event = poll(api, desktop)["events"][0]
    assert event["type"] == "offer"
    assert event["transferId"] == transfer_id
    assert event["from"] == phone.device_id
    assert event["fromName"] == "My phone"
    assert event["fromFingerprint"] == fingerprint(phone.jwk)
    assert event["fromPublicKey"] == phone.jwk
    assert event["sdp"] == SDP


def test_offer_limits_active_transfers(api, pair, flask_app, monkeypatch):
    desktop, phone = pair
    monkeypatch.setitem(flask_app.config, "MAX_ACTIVE_TRANSFERS", 1)
    assert send_offer(api, phone, desktop).status_code == 201
    response = send_offer(api, phone, desktop)
    assert response.status_code == 429
    assert response.get_json() == {"error": "Too many transfers at once"}


# ---------- POST /api/transfers/<id>/answer ----------

def test_answer_requires_login(api):
    assert api.post(f"/api/transfers/{uuid.uuid4()}/answer", json={}).status_code == 401


def test_answer_for_a_malformed_transfer_id(api, pair):
    assert api.post("/api/transfers/nope/answer", json={"deviceId": str(uuid.uuid4()), "sdp": SDP}).status_code == 404


def test_answer_without_a_device_id(api, pair):
    assert api.post(f"/api/transfers/{uuid.uuid4()}/answer", json={"sdp": SDP}).status_code == 404


def test_answer_rejects_a_bad_sdp(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = api.post(f"/api/transfers/{transfer_id}/answer", json={"deviceId": desktop.device_id, "sdp": "x"})
    assert response.status_code == 400


def test_answer_for_an_unknown_transfer(api, pair):
    desktop, _ = pair
    response = api.post(f"/api/transfers/{uuid.uuid4()}/answer", json={"deviceId": desktop.device_id, "sdp": SDP})
    assert response.status_code == 404


def test_only_the_target_device_can_answer(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = api.post(f"/api/transfers/{transfer_id}/answer", json={"deviceId": phone.device_id, "sdp": SDP})
    assert response.status_code == 403
    assert response.get_json() == {"error": "Device check failed"}


def test_answer_needs_a_valid_signature(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = api.post(f"/api/transfers/{transfer_id}/answer", json={"deviceId": desktop.device_id, "sdp": SDP})
    assert response.status_code == 403


def test_answer_reaches_the_sender(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = send_answer(api, desktop, transfer_id)
    assert response.status_code == 200

    event = poll(api, phone)["events"][0]
    assert event["type"] == "answer"
    assert event["transferId"] == transfer_id
    assert event["from"] == desktop.device_id
    assert event["fromFingerprint"] == fingerprint(desktop.jwk)
    assert registry.get("user-1", transfer_id)["status"] == "answered"


def test_a_transfer_can_only_be_answered_once(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    assert send_answer(api, desktop, transfer_id).status_code == 200
    assert send_answer(api, desktop, transfer_id).status_code == 404


def test_answer_loses_a_race_with_another_answer(api, pair, monkeypatch):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    monkeypatch.setattr("routes.transfers.registry.mark_answered", lambda uid, tid: False)
    assert send_answer(api, desktop, transfer_id).status_code == 404


# ---------- POST /api/transfers/<id>/ice ----------

def test_ice_requires_login(api):
    assert api.post(f"/api/transfers/{uuid.uuid4()}/ice", json={}).status_code == 401


def test_ice_with_a_malformed_transfer_id(api, pair):
    assert api.post("/api/transfers/nope/ice", json={}).status_code == 404


def test_ice_for_an_unknown_transfer_is_a_404_not_a_crash(api, pair):
    desktop, _ = pair
    response = send_ice(api, desktop, str(uuid.uuid4()))
    assert response.status_code == 404
    assert response.get_json() == {"error": "Not found"}


def test_ice_from_a_device_outside_the_transfer(api, pair, seed):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    stranger = Device("phone", "Stranger")
    seed.device(stranger)
    assert send_ice(api, stranger, transfer_id).status_code == 403


@pytest.mark.parametrize("overrides", [
    {"candidate": None},
    {"candidate": "x" * 2001},
    {"sdpMid": 5},
    {"sdpMid": "m" * 65},
    {"sdpMLineIndex": "0"},
    {"sdpMLineIndex": True},
    {"sdpMLineIndex": -1},
    {"sdpMLineIndex": 17},
])
def test_ice_rejects_bad_candidates(api, pair, overrides):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    body = {"deviceId": desktop.device_id, "candidate": CANDIDATE, "sdpMid": "0", "sdpMLineIndex": 0}
    body.update(overrides)
    response = api.post(f"/api/transfers/{transfer_id}/ice", json=body)
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_ice_needs_a_valid_signature(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    body = {"deviceId": desktop.device_id, "candidate": CANDIDATE, "sdpMid": "0", "sdpMLineIndex": 0}
    assert api.post(f"/api/transfers/{transfer_id}/ice", json=body).status_code == 403


def test_ice_is_delivered_to_the_other_device(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)

    assert send_ice(api, phone, transfer_id).status_code == 200
    assert send_ice(api, desktop, transfer_id, mid="1", index=1).status_code == 200

    to_desktop = [e for e in poll(api, desktop)["events"] if e["type"] == "ice"]
    assert to_desktop[0]["candidate"] == CANDIDATE
    assert to_desktop[0]["sdpMid"] == "0" and to_desktop[0]["sdpMLineIndex"] == 0

    to_phone = [e for e in poll(api, phone)["events"] if e["type"] == "ice"]
    assert to_phone[0]["sdpMid"] == "1" and to_phone[0]["sdpMLineIndex"] == 1


def test_ice_without_mid_and_index_is_accepted(api, pair):
    """Browsers can send a candidate with no sdpMid / sdpMLineIndex (signed as empty strings)."""
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    assert send_ice(api, phone, transfer_id, mid=None, index=None).status_code == 200


def test_ice_messages_per_transfer_are_capped(api, pair, monkeypatch):
    desktop, phone = pair
    monkeypatch.setattr("routes.transfers.MAX_ICE_PER_TRANSFER", 1)
    transfer_id = start_transfer(api, phone, desktop)
    assert send_ice(api, phone, transfer_id).status_code == 200
    response = send_ice(api, phone, transfer_id)
    assert response.status_code == 429
    assert response.get_json() == {"error": "Too many messages"}


# ---------- POST /api/transfers/<id>/close ----------

def test_close_requires_login(api):
    assert api.post(f"/api/transfers/{uuid.uuid4()}/close", json={}).status_code == 401


def test_close_unknown_transfer(api, pair):
    desktop, _ = pair
    assert send_close(api, desktop, str(uuid.uuid4())).status_code == 404


def test_close_malformed_transfer_id(api, pair):
    assert api.post("/api/transfers/nope/close", json={}).status_code == 404


def test_close_from_a_device_outside_the_transfer(api, pair, seed):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    stranger = Device("phone")
    seed.device(stranger)
    assert send_close(api, stranger, transfer_id).status_code == 403


def test_close_rejects_unknown_reasons(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = send_close(api, desktop, transfer_id, reason="because")
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid close reason"}


def test_close_needs_a_valid_signature(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    response = api.post(f"/api/transfers/{transfer_id}/close", json={"deviceId": desktop.device_id})
    assert response.status_code == 403


def test_close_signature_covers_the_reason(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    body = api.signed(desktop, "close", [transfer_id, "done"], reason="error")
    assert api.post(f"/api/transfers/{transfer_id}/close", json=body).status_code == 403


@pytest.mark.parametrize("reason", ["done", "declined", "cancelled", "error"])
def test_close_removes_the_transfer_and_tells_the_peer(api, pair, reason):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    assert send_close(api, desktop, transfer_id, reason=reason).status_code == 200
    assert registry.get("user-1", transfer_id) is None

    event = poll(api, phone)["events"][-1]
    assert event == {"seq": event["seq"], "type": "closed", "transferId": transfer_id, "reason": reason}


def test_close_defaults_to_done(api, pair):
    desktop, phone = pair
    transfer_id = start_transfer(api, phone, desktop)
    body = api.signed(desktop, "close", [transfer_id, "done"])
    assert api.post(f"/api/transfers/{transfer_id}/close", json=body).status_code == 200
    assert poll(api, phone)["events"][-1]["reason"] == "done"


# ---------- GET /api/transfers/events ----------

def test_events_requires_login(api):
    assert api.get("/api/transfers/events").status_code == 401


def test_events_needs_an_active_device(api, pair):
    assert api.get("/api/transfers/events").status_code == 404
    assert api.get("/api/transfers/events?device=nope").status_code == 404
    assert api.get(f"/api/transfers/events?device={uuid.uuid4()}").status_code == 404


def test_events_for_a_revoked_device(api, pair, seed):
    _, phone = pair
    seed.device(phone, status="revoked")
    assert api.get(f"/api/transfers/events?device={phone.device_id}&wait=0").status_code == 404


def test_events_is_empty_when_nothing_happened(api, pair):
    _, phone = pair
    assert poll(api, phone, after=5) == {"events": [], "cursor": 5}


def test_events_cursor_skips_what_was_already_seen(api, pair):
    desktop, phone = pair
    start_transfer(api, phone, desktop)
    first = poll(api, desktop)
    assert len(first["events"]) == 1

    again = poll(api, desktop, after=first["cursor"])
    assert again["events"] == [] and again["cursor"] == first["cursor"]


def test_events_wait_is_capped_by_the_server(api, pair, flask_app, monkeypatch):
    _, phone = pair
    monkeypatch.setitem(flask_app.config, "SIGNAL_MAX_WAIT_SECONDS", 0)
    started = time.monotonic()
    assert poll(api, phone, wait=999)["events"] == []
    assert time.monotonic() - started < 1


def test_events_are_private_to_the_account(api, pair, login, seed):
    desktop, phone = pair
    start_transfer(api, phone, desktop)
    seed.user("user-2", "desktop_enrolled")
    other = Device("desktop")
    seed.device(other, uid="user-2")
    login("user-2")
    assert poll(api, other)["events"] == []
    assert hub._boxes.get(("user-2", desktop.device_id)) is None