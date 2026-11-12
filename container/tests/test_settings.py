from datetime import datetime, timezone

from core.deviceauth import fingerprint
from tests.helpers import Device


def test_settings_requires_login(api):
    assert api.get("/api/settings").status_code == 401


def test_settings_shows_the_account_and_only_its_active_devices(api, login, seed, db):
    login(email="amr@example.com", age=60)
    created = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    db.collection("users").document("user-1").set(
        {"email": "amr@example.com", "account_state": "phone_paired", "created_at": created}
    )
    computer = Device("desktop", "Home PC")
    phone = Device("phone", "My phone")
    old_phone = Device("phone", "Old phone")
    seed.device(computer)
    seed.device(phone)
    seed.device(old_phone, status="revoked")

    body = api.get("/api/settings").get_json()

    account = body["account"]
    assert account["email"] == "amr@example.com"
    assert account["provider"] == "google.com"
    assert account["createdAt"] == created.isoformat()
    assert account["signedInAt"] and account["sessionExpiresAt"]
    assert body["limits"] == {"perType": 3}

    # the revoked phone is hidden, and devices are sorted by type
    assert [(d["type"], d["name"]) for d in body["devices"]] == [("desktop", "Home PC"), ("phone", "My phone")]
    assert body["devices"][0]["fingerprint"] == fingerprint(computer.jwk)


def test_settings_for_a_brand_new_account(api, login):
    login()
    body = api.get("/api/settings").get_json()
    assert body["devices"] == []
    assert body["account"]["createdAt"] is None