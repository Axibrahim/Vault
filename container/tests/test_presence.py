import time
import uuid

import pytest

from core.signaling import PresenceBoard
from tests.helpers import Device


def beat(api, device, state="ready"):
    return api.post("/api/devices/presence", json={"deviceId": device.device_id, "state": state})


# ---------- the in-memory board ----------

def test_board_shows_fresh_devices_of_one_account_only():
    board = PresenceBoard(fresh=10, keep=100)
    board.beat("u1", "d1", "ready")
    board.beat("u2", "d2", "busy")
    assert board.snapshot("u1") == {"d1": "ready"}
    assert board.snapshot("u2") == {"d2": "busy"}


def test_board_hides_silent_devices_and_forgets_them_later():
    board = PresenceBoard(fresh=10, keep=100)
    board._items[("u1", "quiet")] = (time.time() - 50, "ready")
    board._items[("u1", "gone")] = (time.time() - 500, "ready")
    assert board.snapshot("u1") == {}
    assert board.known("u1", "quiet") is True
    assert board.known("u1", "gone") is False
    board.beat("u1", "d1", "ready")             # a beat also sweeps out the forgotten ones
    assert ("u1", "gone") not in board._items
    assert ("u1", "quiet") in board._items


def test_board_does_not_know_a_device_that_never_beat():
    assert PresenceBoard().known("u1", "d1") is False


def test_board_forget():
    board = PresenceBoard()
    board.beat("u1", "d1", "ready")
    board.forget("u1", "d1")
    board.forget("u1", "d1")                     # forgetting twice is fine
    assert board.snapshot("u1") == {}


# ---------- POST /api/devices/presence ----------

def test_presence_requires_login(api):
    assert api.post("/api/devices/presence", json={}).status_code == 401


@pytest.mark.parametrize("body", [
    {},
    {"deviceId": "nope", "state": "ready"},
    {"deviceId": None, "state": "ready"},
])
def test_presence_rejects_bad_requests(api, login, body):
    login()
    response = api.post("/api/devices/presence", json=body)
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_presence_rejects_an_unknown_state(api, desktop):
    response = api.post("/api/devices/presence", json={"deviceId": desktop.device_id, "state": "dancing"})
    assert response.status_code == 400


def test_presence_for_an_unknown_device(api, login):
    login()
    response = api.post("/api/devices/presence", json={"deviceId": str(uuid.uuid4()), "state": "ready"})
    assert response.status_code == 404


def test_presence_for_a_revoked_device(api, desktop, seed):
    old = Device("phone", "Old phone")
    seed.device(old, status="revoked")
    assert beat(api, old).status_code == 404


def test_presence_lists_the_devices_that_are_open(api, desktop, seed):
    phone = Device("phone", "My phone")
    seed.device(phone)

    assert beat(api, desktop).get_json() == {"presence": {desktop.device_id: "ready"}}
    assert beat(api, desktop, "blocked").status_code == 200          # second beat from a known device
    body = beat(api, phone, "busy").get_json()
    assert body["presence"] == {desktop.device_id: "blocked", phone.device_id: "busy"}


def test_presence_is_private_to_the_account(api, desktop, login, seed):
    beat(api, desktop)
    seed.user("user-2", "no_devices")
    other = Device()
    seed.device(other, "user-2")
    login("user-2")
    assert beat(api, other).get_json() == {"presence": {other.device_id: "ready"}}


def test_removing_a_device_clears_its_presence(api, desktop, seed):
    phone = Device("phone", "My phone")
    seed.device(phone)
    assert beat(api, phone).status_code == 200
    assert api.post(f"/api/devices/{phone.device_id}/revoke").status_code == 200
    assert beat(api, phone).status_code == 404