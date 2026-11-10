import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.helpers import Device


def history_docs(db):
    return {
        ref.id: ref.raw()
        for ref in db.collection("users").document("user-1").collection("history").refs()
    }


def record_body(api, sender, receiver, files=3, size=4096, transfer_id=None):
    transfer_id = transfer_id or str(uuid.uuid4())
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


def test_record_needs_an_active_receiver(api, desktop):
    stranger = Device("phone")
    _, body = record_body(api, desktop, stranger)
    response = api.post("/api/transfers/record", json=body)
    assert response.status_code == 404
    assert response.get_json() == {"error": "Device not found"}


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