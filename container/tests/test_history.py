import uuid
from datetime import datetime, timedelta, timezone

import pytest

from core.signaling import registry

from tests.helpers import Device


def history_docs(db):
    return {
        ref.id: ref.raw()
        for ref in db.collection("users").document("user-1").collection("history").refs()
    }


def running_transfer(sender, receiver, answered=True):
    """A transfer between two devices that is really running (only those can be written to the history)."""
    transfer_id, _ = registry.create("user-1", sender.device_id, receiver.device_id, "offer-hash")
    if answered:
        registry.mark_answered("user-1", transfer_id)
    return transfer_id


def record_body(api, sender, receiver, files=3, size=4096, transfer_id=None):
    transfer_id = transfer_id or running_transfer(sender, receiver)
    body = api.signed(
        sender, "record", [transfer_id, receiver.device_id, str(files), str(size)],
        transferId=transfer_id, toDeviceId=receiver.device_id, files=files, bytes=size,
    )
    return transfer_id, body


def history_entry(db, entry_id, created_at):
    db.collection("users").document("user-1").collection("history").document(entry_id).set({
        "from_id": "a", "from_name": "Home PC", "to_id": "b", "to_name": "My phone",
        "files": 2, "bytes": 2048, "created_at": created_at, "expires_at": created_at + timedelta(days=30),
    })


@pytest.fixture
def phone(seed):
    device = Device("phone", "My phone")
    seed.device(device)
    return device


# ---------- POST /api/transfers/record ----------

def test_record_requires_login(api):
    assert api.post("/api/transfers/record", json={}).status_code == 401


def test_record_stores_one_entry_with_counts_only(api, desktop, phone, db):
    transfer_id, body = record_body(api, desktop, phone, files=3, size=4096)
    response = api.post("/api/transfers/record", json=body)
    assert response.status_code == 200

    stored = history_docs(db)[transfer_id]
    assert stored["from_id"] == desktop.device_id and stored["from_name"] == "Home PC"
    assert stored["to_id"] == phone.device_id and stored["to_name"] == "My phone"
    assert stored["files"] == 3 and stored["bytes"] == 4096
    assert stored["expires_at"] > stored["created_at"]
    assert "name" not in str(sorted(stored)).replace("_name", "")        # no file names are kept


def test_recording_the_same_transfer_twice_keeps_one_entry(api, desktop, phone, db):
    transfer_id, first = record_body(api, desktop, phone)
    _, second = record_body(api, desktop, phone, transfer_id=transfer_id)
    assert api.post("/api/transfers/record", json=first).status_code == 200
    assert api.post("/api/transfers/record", json=second).status_code == 200
    assert len(history_docs(db)) == 1


@pytest.mark.parametrize("overrides", [
    {"files": 0},
    {"files": "3"},
    {"files": True},
    {"files": 100_001},
    {"bytes": -1},
    {"bytes": 2**50},
    {"bytes": 1.5},
    {"transferId": "nope"},
    {"toDeviceId": "nope"},
])
def test_record_rejects_bad_input(api, desktop, phone, overrides):
    _, body = record_body(api, desktop, phone)
    body.update(overrides)
    response = api.post("/api/transfers/record", json=body)
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_record_rejects_a_transfer_to_itself(api, desktop):
    _, body = record_body(api, desktop, desktop)
    assert api.post("/api/transfers/record", json=body).status_code == 400


def test_record_needs_the_senders_signature(api, desktop, phone):
    impostor = Device("desktop")
    impostor.device_id = desktop.device_id
    _, body = record_body(api, impostor, phone)
    assert api.post("/api/transfers/record", json=body).status_code == 403


def test_record_needs_an_active_receiver(api, desktop, phone, seed):
    _, body = record_body(api, desktop, phone)
    seed.device(phone, status="revoked")
    response = api.post("/api/transfers/record", json=body)
    assert response.status_code == 404
    assert response.get_json() == {"error": "Device not found"}


def test_record_needs_a_running_transfer(api, desktop, phone, db):
    unknown = str(uuid.uuid4())                                   # a transfer that never existed
    _, body = record_body(api, desktop, phone, transfer_id=unknown)
    response = api.post("/api/transfers/record", json=body)
    assert response.status_code == 404
    assert response.get_json() == {"error": "Not found"}
    assert history_docs(db) == {}


def test_record_refuses_a_transfer_that_was_never_answered(api, desktop, phone, db):
    offered = running_transfer(desktop, phone, answered=False)
    _, body = record_body(api, desktop, phone, transfer_id=offered)
    assert api.post("/api/transfers/record", json=body).status_code == 404
    assert history_docs(db) == {}


def test_record_refuses_a_transfer_that_is_over(api, desktop, phone, db):
    finished = running_transfer(desktop, phone)
    registry.advance("user-1", finished, "cancelled")
    _, body = record_body(api, desktop, phone, transfer_id=finished)
    assert api.post("/api/transfers/record", json=body).status_code == 404
    assert history_docs(db) == {}


def test_record_must_name_the_real_devices_of_the_transfer(api, desktop, phone, seed, db):
    other = Device("phone", "Other phone")
    seed.device(other)
    transfer_id = running_transfer(desktop, phone)
    _, body = record_body(api, desktop, other, transfer_id=transfer_id)      # same transfer, different receiver
    assert api.post("/api/transfers/record", json=body).status_code == 404
    assert history_docs(db) == {}


def test_record_cannot_be_written_by_the_receiving_side(api, desktop, phone, db):
    transfer_id = running_transfer(desktop, phone)
    _, body = record_body(api, phone, desktop, transfer_id=transfer_id)      # roles swapped
    assert api.post("/api/transfers/record", json=body).status_code == 404
    assert history_docs(db) == {}


def test_a_clip_link_cannot_be_recorded_as_a_file_transfer(api, desktop, phone, db):
    transfer_id, _ = registry.create("user-1", desktop.device_id, phone.device_id, "h", kind="clip")
    registry.mark_answered("user-1", transfer_id)
    _, body = record_body(api, desktop, phone, transfer_id=transfer_id)
    assert api.post("/api/transfers/record", json=body).status_code == 404
    assert history_docs(db) == {}


# ---------- GET /api/transfers/history ----------

def test_history_requires_login(api):
    assert api.get("/api/transfers/history").status_code == 401


def test_history_is_empty_for_a_new_account(api, login):
    login()
    assert api.get("/api/transfers/history").get_json() == {"history": []}


def test_history_shows_the_last_30_days_newest_first(api, desktop, db):
    now = datetime.now(timezone.utc)
    history_entry(db, "old", now - timedelta(days=31))
    history_entry(db, "middle", now - timedelta(days=5))
    history_entry(db, "new", now - timedelta(hours=1))

    items = api.get("/api/transfers/history").get_json()["history"]
    assert [item["id"] for item in items] == ["new", "middle"]
    assert items[0] == {
        "id": "new", "fromId": "a", "fromName": "Home PC", "toId": "b", "toName": "My phone",
        "files": 2, "bytes": 2048, "at": items[0]["at"],
    }
    assert items[0]["at"]


def test_history_is_limited_to_50_entries(api, desktop, db):
    now = datetime.now(timezone.utc)
    for number in range(55):
        history_entry(db, f"t{number}", now - timedelta(minutes=number))
    assert len(api.get("/api/transfers/history").get_json()["history"]) == 50