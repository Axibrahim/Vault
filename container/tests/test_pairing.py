import uuid
from datetime import datetime, timedelta, timezone

import pytest

from core.deviceauth import fingerprint
from routes.pairing import CODE_ALPHABET, _normalize_code
from tests.helpers import Device


def user_doc(db):
    return db.collection("users").document("user-1").get().to_dict()


def pairing_docs(db):
    return {
        ref.id: ref.raw()
        for ref in db.collection("users").document("user-1").collection("pairings").refs()
    }


def create_code(api, desktop):
    response = api.post("/api/pairing/create", json=api.signed(desktop, "pairing-create"))
    assert response.status_code == 201
    return response.get_json()


def claim_body(phone, code, **overrides):
    body = {"code": code, "name": phone.name, "deviceId": phone.device_id, "publicKey": phone.jwk}
    body.update(overrides)
    return body


@pytest.fixture
def phone():
    return Device("phone", "My phone")


# ---------- code helpers ----------

@pytest.mark.parametrize("raw,expected", [
    ("ABCD-EFGH", "ABCDEFGH"),
    ("abcd-efgh", "ABCDEFGH"),          # lower case is fine
    (" abcd efgh ", "ABCDEFGH"),        # spaces and dashes are ignored
    ("2345 6789", "23456789"),
    ("ABCD-EFG", None),                 # too short
    ("ABCD-EFGH1", None),               # too long
    ("ABCDEFG0", None),                 # 0 is not in the alphabet
    (None, None),
    (12345678, None),
])
def test_normalize_code(raw, expected):
    assert _normalize_code(raw) == expected


def test_code_alphabet_has_no_confusing_characters():
    assert not set("01OILU") & set(CODE_ALPHABET)


# ---------- POST /api/pairing/create ----------

def test_create_requires_a_recent_sign_in(api, login):
    login(age=3600)
    assert api.post("/api/pairing/create", json={}).status_code == 401


def test_create_needs_an_enrolled_computer(api, login, seed):
    login()
    seed.user("user-1", "no_devices")
    response = api.post("/api/pairing/create", json={})
    assert response.status_code == 409
    assert response.get_json() == {"error": "Pairing is not available right now"}


def test_create_needs_a_device_signature(api, desktop):
    response = api.post("/api/pairing/create", json={})
    assert response.status_code == 403
    assert response.get_json() == {"error": "Device check failed"}


def test_create_rejects_a_signature_from_another_key(api, desktop):
    impostor = Device("desktop")
    impostor.device_id = desktop.device_id
    response = api.post("/api/pairing/create", json=api.signed(impostor, "pairing-create"))
    assert response.status_code == 403


def test_create_returns_a_code_and_never_stores_it(api, desktop, db):
    body = create_code(api, desktop)
    assert len(body["code"]) == 8 and set(body["code"]) <= set(CODE_ALPHABET)
    assert body["pairingId"] in pairing_docs(db)

    stored = pairing_docs(db)[body["pairingId"]]
    assert stored["status"] == "open"
    assert body["code"] not in str(stored)
    assert len(stored["code_hash"]) == 64


def test_create_cancels_the_previous_live_code(api, desktop, db):
    first = create_code(api, desktop)
    second = create_code(api, desktop)
    docs = pairing_docs(db)
    assert docs[first["pairingId"]]["status"] == "cancelled"
    assert docs[second["pairingId"]]["status"] == "open"


def test_a_challenge_cannot_be_used_twice(api, desktop):
    body = api.signed(desktop, "pairing-create")
    assert api.post("/api/pairing/create", json=body).status_code == 201
    assert api.post("/api/pairing/create", json=body).status_code == 403


# ---------- POST /api/pairing/claim ----------

def test_claim_requires_login(api, phone):
    assert api.post("/api/pairing/claim", json=claim_body(phone, "ABCDEFGH")).status_code == 401


@pytest.mark.parametrize("overrides", [
    {"code": "bad"},
    {"code": None},
    {"name": ""},
    {"name": "bad/name"},
    {"name": None},
    {"deviceId": "nope"},
    {"deviceId": None},
    {"publicKey": {"kty": "EC"}},
])
def test_claim_rejects_bad_input(api, login, phone, overrides):
    login()
    body = claim_body(phone, "ABCDEFGH")
    body.update(overrides)
    response = api.post("/api/pairing/claim", json=body)
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid or expired code"}


def test_claim_with_an_unknown_code(api, login, phone):
    login()
    response = api.post("/api/pairing/claim", json=claim_body(phone, "ABCDEFGH"))
    assert response.status_code == 400


def test_claim_succeeds_and_returns_the_fingerprint(api, desktop, phone, db):
    code = create_code(api, desktop)
    response = api.post("/api/pairing/claim", json=claim_body(phone, f"{code['code'][:4]}-{code['code'][4:].lower()}"))
    assert response.status_code == 200
    body = response.get_json()
    assert body["pairingId"] == code["pairingId"]
    assert body["fingerprint"] == fingerprint(phone.jwk)
    assert pairing_docs(db)[code["pairingId"]]["status"] == "claimed"


def test_a_code_can_only_be_claimed_once(api, desktop, phone):
    code = create_code(api, desktop)["code"]
    assert api.post("/api/pairing/claim", json=claim_body(phone, code)).status_code == 200
    other = Device("phone", "Other")
    assert api.post("/api/pairing/claim", json=claim_body(other, code)).status_code == 400


def test_claim_rejects_an_expired_code(api, desktop, phone, db):
    created = create_code(api, desktop)
    ref = db.collection("users").document("user-1").collection("pairings").document(created["pairingId"])
    ref.update({"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
    assert api.post("/api/pairing/claim", json=claim_body(phone, created["code"])).status_code == 400


def test_claim_fails_when_the_account_has_no_computer(api, desktop, phone, db):
    code = create_code(api, desktop)["code"]
    db.collection("users").document("user-1").update({"account_state": "no_devices"})
    assert api.post("/api/pairing/claim", json=claim_body(phone, code)).status_code == 400


def test_claim_is_rate_limited(api, login, phone):
    from core.extensions import limiter

    login()
    limiter.enabled = True
    codes = [api.post("/api/pairing/claim", json=claim_body(phone, "ABCDEFGH")).status_code for _ in range(6)]
    assert codes[:5] == [400] * 5
    assert codes[5] == 429


# ---------- GET /api/pairing/current ----------

def test_current_requires_login(api):
    assert api.get("/api/pairing/current").status_code == 401


def test_current_is_empty_without_a_pairing(api, desktop):
    assert api.get("/api/pairing/current").get_json() == {"pairing": None}


def test_current_shows_an_open_code(api, desktop):
    created = create_code(api, desktop)
    pairing = api.get("/api/pairing/current").get_json()["pairing"]
    assert pairing["pairingId"] == created["pairingId"]
    assert pairing["status"] == "open"
    assert "phone" not in pairing


def test_current_shows_the_claiming_phone(api, desktop, phone):
    code = create_code(api, desktop)["code"]
    api.post("/api/pairing/claim", json=claim_body(phone, code))
    pairing = api.get("/api/pairing/current").get_json()["pairing"]
    assert pairing["status"] == "claimed"
    assert pairing["phone"] == {"name": "My phone", "fingerprint": fingerprint(phone.jwk)}


def test_current_ignores_expired_codes(api, desktop, db):
    created = create_code(api, desktop)
    ref = db.collection("users").document("user-1").collection("pairings").document(created["pairingId"])
    ref.update({"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
    assert api.get("/api/pairing/current").get_json() == {"pairing": None}


def test_current_picks_the_latest_when_several_are_live(api, desktop, db):
    older = create_code(api, desktop)
    users = db.collection("users").document("user-1").collection("pairings")
    users.document(older["pairingId"]).update({"expires_at": datetime.now(timezone.utc) + timedelta(seconds=5)})
    newer_id = str(uuid.uuid4())
    users.document(newer_id).set({
        "code_hash": "x", "status": "open", "expires_at": datetime.now(timezone.utc) + timedelta(seconds=100),
    })
    assert api.get("/api/pairing/current").get_json()["pairing"]["pairingId"] == newer_id


# ---------- POST /api/pairing/<id>/approve ----------

def claimed(api, desktop, phone):
    created = create_code(api, desktop)
    api.post("/api/pairing/claim", json=claim_body(phone, created["code"]))
    return created["pairingId"]


def approve(api, desktop, pairing_id, phone_fingerprint, **extra):
    body = api.signed(desktop, "pairing-approve", [pairing_id, phone_fingerprint], **extra)
    return api.post(f"/api/pairing/{pairing_id}/approve", json=body)


def test_approve_requires_a_recent_sign_in(api, login):
    login(age=3600)
    assert api.post(f"/api/pairing/{uuid.uuid4()}/approve", json={}).status_code == 401


def test_approve_with_a_malformed_id(api, desktop):
    assert api.post("/api/pairing/nope/approve", json={}).status_code == 404


def test_approve_unknown_pairing(api, desktop):
    assert api.post(f"/api/pairing/{uuid.uuid4()}/approve", json={}).status_code == 404


def test_approve_needs_a_claimed_pairing(api, desktop):
    created = create_code(api, desktop)
    assert api.post(f"/api/pairing/{created['pairingId']}/approve", json={}).status_code == 404


def test_approve_needs_the_computers_signature(api, desktop, phone):
    pairing_id = claimed(api, desktop, phone)
    response = api.post(f"/api/pairing/{pairing_id}/approve", json={})
    assert response.status_code == 403


def test_approve_rejects_a_signature_for_a_different_phone(api, desktop, phone):
    pairing_id = claimed(api, desktop, phone)
    other = Device("phone")
    assert approve(api, desktop, pairing_id, fingerprint(other.jwk)).status_code == 403


def test_approve_creates_the_phone_device(api, desktop, phone, db):
    pairing_id = claimed(api, desktop, phone)
    response = approve(api, desktop, pairing_id, fingerprint(phone.jwk))
    assert response.status_code == 200

    stored = db.collection("users").document("user-1").collection("devices").document(phone.device_id).get().to_dict()
    assert stored["type"] == "phone" and stored["status"] == "active"
    assert stored["public_key"] == phone.jwk
    assert user_doc(db)["account_state"] == "phone_paired"
    assert pairing_docs(db)[pairing_id]["status"] == "approved"


def test_approve_fails_if_the_code_expired_in_the_meantime(api, desktop, phone, db):
    pairing_id = claimed(api, desktop, phone)
    ref = db.collection("users").document("user-1").collection("pairings").document(pairing_id)
    ref.update({"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
    response = approve(api, desktop, pairing_id, fingerprint(phone.jwk))
    assert response.status_code == 409
    assert response.get_json() == {"error": "Pairing is no longer valid"}


def test_approve_fails_if_the_account_state_changed(api, desktop, phone, db):
    pairing_id = claimed(api, desktop, phone)
    db.collection("users").document("user-1").update({"account_state": "no_devices"})
    response = approve(api, desktop, pairing_id, fingerprint(phone.jwk))
    # the computer record is still active, so the proof passes and the transaction refuses
    assert response.status_code == 409


# ---------- POST /api/pairing/<id>/cancel ----------

def test_cancel_requires_login(api):
    assert api.post(f"/api/pairing/{uuid.uuid4()}/cancel").status_code == 401


def test_cancel_with_a_malformed_id(api, desktop):
    assert api.post("/api/pairing/nope/cancel").status_code == 404


def test_cancel_closes_a_live_pairing(api, desktop, db):
    created = create_code(api, desktop)
    assert api.post(f"/api/pairing/{created['pairingId']}/cancel").status_code == 200
    assert pairing_docs(db)[created["pairingId"]]["status"] == "cancelled"
    assert api.get("/api/pairing/current").get_json() == {"pairing": None}


def test_cancel_is_quiet_for_unknown_or_finished_pairings(api, desktop, phone, db):
    assert api.post(f"/api/pairing/{uuid.uuid4()}/cancel").status_code == 200
    pairing_id = claimed(api, desktop, phone)
    approve(api, desktop, pairing_id, fingerprint(phone.jwk))
    assert api.post(f"/api/pairing/{pairing_id}/cancel").status_code == 200
    assert pairing_docs(db)[pairing_id]["status"] == "approved"


def test_approve_transaction_refuses_a_phone_with_a_different_fingerprint(db, phone):
    """The route always passes the right fingerprint, so the transaction's own check is tested directly."""
    from routes.pairing import PairingError, _approve_in_txn
    from tests.fakes import FakeTransaction

    users = db.collection("users")
    users.document("user-1").set({"account_state": "desktop_enrolled"})
    pairing_ref = users.document("user-1").collection("pairings").document("p1")
    pairing_ref.set({
        "status": "claimed",
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=1),
        "phone": {"device_id": phone.device_id, "name": phone.name, "public_key": phone.jwk},
    })
    phone_ref = users.document("user-1").collection("devices").document(phone.device_id)

    with pytest.raises(PairingError):
        _approve_in_txn(FakeTransaction(), users.document("user-1"), pairing_ref, phone_ref, "WRONG-FING-ERPR")
    assert phone_ref.get().exists is False