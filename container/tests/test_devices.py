import uuid

import pytest

from routes.devices import clean_public_jwk
from tests.helpers import Device


def user_doc(db, uid="user-1"):
    return db.collection("users").document(uid).get().to_dict()


def device_doc(db, device, uid="user-1"):
    return db.collection("users").document(uid).collection("devices").document(device.device_id).get().to_dict()


def enroll_body(device, **overrides):
    body = {"deviceId": device.device_id, "name": device.name, "publicKey": device.jwk}
    body.update(overrides)
    return body


# ---------- clean_public_jwk ----------

def test_clean_public_jwk_accepts_a_real_key():
    device = Device()
    assert clean_public_jwk({**device.jwk, "d": "private-part-must-be-dropped"}) == device.jwk


@pytest.mark.parametrize("jwk", [
    None,
    "not a dict",
    {"kty": "RSA", "crv": "P-256"},
    {"kty": "EC", "crv": "P-384"},
    {"kty": "EC", "crv": "P-256", "x": 1, "y": 2},
    {"kty": "EC", "crv": "P-256", "x": "short", "y": "short"},
    {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "A" * 43},       # not a point on the curve
])
def test_clean_public_jwk_rejects_bad_keys(jwk):
    assert clean_public_jwk(jwk) is None


# ---------- GET /api/devices ----------

def test_list_devices_requires_login(api):
    assert api.get("/api/devices").status_code == 401


def test_list_devices_for_a_brand_new_user(api, login):
    login()
    assert api.get("/api/devices").get_json() == {"accountState": "no_devices", "devices": []}


def test_list_devices_shows_the_account_state_and_devices(api, desktop):
    body = api.get("/api/devices").get_json()
    assert body["accountState"] == "desktop_enrolled"
    assert len(body["devices"]) == 1
    listed = body["devices"][0]
    assert listed["id"] == desktop.device_id
    assert listed["type"] == "desktop"
    assert listed["name"] == "Home PC"
    assert listed["status"] == "active"
    assert listed["createdAt"] and listed["lastSeen"]
    assert "public_key" not in listed and "publicKey" not in listed


def test_list_devices_handles_devices_without_timestamps(api, login, db):
    login()
    db.collection("users").document("user-1").set({"account_state": "no_devices"})
    db.collection("users").document("user-1").collection("devices").document("d1").set({"type": "phone"})
    listed = api.get("/api/devices").get_json()["devices"][0]
    assert listed["createdAt"] is None and listed["lastSeen"] is None


# ---------- POST /api/devices/challenge ----------

def test_challenge_requires_login(api):
    assert api.post("/api/devices/challenge").status_code == 401


def test_challenge_is_fresh_every_time(api, login):
    login()
    first, second = api.challenge(), api.challenge()
    assert first != second
    assert first.count(".") == 2


# ---------- POST /api/devices/enroll-desktop ----------

def test_enroll_requires_a_recent_sign_in(api, login):
    login(age=3600)
    response = api.post("/api/devices/enroll-desktop", json={})
    assert response.status_code == 401
    assert response.get_json()["code"] == "reauth_required"


@pytest.mark.parametrize("name", [None, 5, "", "   ", "x" * 41, "bad/name", "semi;colon"])
def test_enroll_rejects_invalid_names(api, login, name):
    login()
    response = api.post("/api/devices/enroll-desktop", json=enroll_body(Device(), name=name))
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid computer name"}


@pytest.mark.parametrize("device_id", [None, "not-a-uuid", 123])
def test_enroll_rejects_invalid_device_ids(api, login, device_id):
    login()
    response = api.post("/api/devices/enroll-desktop", json=enroll_body(Device(), deviceId=device_id))
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_enroll_rejects_invalid_public_keys(api, login):
    login()
    response = api.post("/api/devices/enroll-desktop", json=enroll_body(Device(), publicKey={"kty": "EC"}))
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid public key"}


def test_enroll_creates_the_computer(api, login, seed, db):
    login()
    seed.user("user-1", "no_devices")
    device = Device(name="  Home PC  ")
    response = api.post("/api/devices/enroll-desktop", json=enroll_body(device, name="  Home PC  "))
    assert response.status_code == 201
    assert response.get_json() == {"status": "ok", "deviceId": device.device_id, "name": "Home PC"}

    stored = device_doc(db, device)
    assert stored["type"] == "desktop" and stored["status"] == "active"
    assert stored["public_key"] == device.jwk
    assert user_doc(db)["account_state"] == "desktop_enrolled"


def test_enroll_a_second_computer_is_refused(api, desktop):
    response = api.post("/api/devices/enroll-desktop", json=enroll_body(Device()))
    assert response.status_code == 409
    assert response.get_json() == {"error": "This account already has a computer set up"}


def test_enroll_refuses_a_device_id_that_already_exists(api, login, seed):
    login()
    seed.user("user-1", "no_devices")
    existing = Device()
    seed.device(existing)
    response = api.post("/api/devices/enroll-desktop", json=enroll_body(existing))
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_enroll_needs_the_csrf_headers(api, login):
    login()
    assert api.post("/api/devices/enroll-desktop", json=enroll_body(Device()), csrf=False).status_code == 403


def test_enroll_rejects_a_foreign_origin(api, login):
    login()
    response = api.post(
        "/api/devices/enroll-desktop", json=enroll_body(Device()), headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403


def test_enroll_rejects_a_missing_vault_header(api, login):
    login()
    response = api.post(
        "/api/devices/enroll-desktop",
        json=enroll_body(Device()),
        csrf=False,
        headers={"Origin": "http://localhost"},
    )
    assert response.status_code == 403


# ---------- POST /api/devices/<id>/revoke ----------

def test_revoke_requires_a_recent_sign_in(api, login):
    login(age=3600)
    assert api.post(f"/api/devices/{uuid.uuid4()}/revoke").status_code == 401


def test_revoke_with_a_malformed_id(api, login):
    login()
    assert api.post("/api/devices/not-a-uuid/revoke").status_code == 404


def test_revoke_unknown_device(api, login):
    login()
    assert api.post(f"/api/devices/{uuid.uuid4()}/revoke").status_code == 404


def test_revoking_the_computer_also_removes_its_phones(api, desktop, seed, db):
    phone = Device("phone", "My phone")
    seed.device(phone)
    old_phone = Device("phone", "Old phone")
    seed.device(old_phone, status="revoked")

    response = api.post(f"/api/devices/{desktop.device_id}/revoke")
    assert response.status_code == 200
    assert device_doc(db, desktop)["status"] == "revoked"
    assert device_doc(db, phone)["status"] == "revoked"
    assert device_doc(db, old_phone)["status"] == "revoked"
    assert user_doc(db)["account_state"] == "no_devices"


def test_revoking_a_phone_keeps_the_computer(api, desktop, seed, db):
    phone = Device("phone", "My phone")
    seed.device(phone)
    db.collection("users").document("user-1").update({"account_state": "phone_paired"})

    assert api.post(f"/api/devices/{phone.device_id}/revoke").status_code == 200
    assert device_doc(db, phone)["status"] == "revoked"
    assert device_doc(db, desktop)["status"] == "active"
    assert user_doc(db)["account_state"] == "desktop_enrolled"


def test_revoking_twice_returns_not_found(api, desktop):
    assert api.post(f"/api/devices/{desktop.device_id}/revoke").status_code == 200
    assert api.post(f"/api/devices/{desktop.device_id}/revoke").status_code == 404


def test_revoking_another_users_device_is_not_possible(api, desktop, login, seed):
    seed.user("user-2", "desktop_enrolled")
    login("user-2")
    assert api.post(f"/api/devices/{desktop.device_id}/revoke").status_code == 404


def test_revoking_an_unknown_device_type_leaves_the_account_state_alone(api, login, seed, db):
    login()
    seed.user("user-1", "desktop_enrolled")
    odd = Device("tablet", "Odd one")
    seed.device(odd)
    assert api.post(f"/api/devices/{odd.device_id}/revoke").status_code == 200
    assert device_doc(db, odd)["status"] == "revoked"
    assert user_doc(db)["account_state"] == "desktop_enrolled"