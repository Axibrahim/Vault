import base64
import json
import threading
import time
import uuid
from unittest import mock

import pytest

from core import deviceauth
from core.config import REQUIRED
from core.deviceauth import (
    CHALLENGE_MAX_AGE,
    b64url_decode,
    challenge_is_valid,
    consume_challenge,
    fingerprint,
    make_challenge,
    signature_is_valid,
    verify_device_proof,
)
from core.firebase_setup import _load_credentials, get_db, init_firebase
from core.signaling import SignalHub, TransferRegistry
from tests.helpers import Device, b64url


# ======================= deviceauth =======================

def test_b64url_decode_handles_missing_padding():
    assert b64url_decode(b64url(b"hello!")) == b"hello!"


def test_b64url_decode_rejects_non_strings():
    with pytest.raises(ValueError):
        b64url_decode(123)


def test_challenges_are_valid_for_their_user_only(flask_app):
    with flask_app.app_context():
        challenge = make_challenge("alice")
        assert challenge_is_valid("alice", challenge)
        assert not challenge_is_valid("bob", challenge)


@pytest.mark.parametrize("bad", [None, 123, "x" * 201, "nodots", "a.b", "abc.def.ghi", "1.2."])
def test_garbage_challenges_are_rejected(flask_app, bad):
    with flask_app.app_context():
        assert not challenge_is_valid("alice", bad)


def test_tampered_challenge_is_rejected(flask_app):
    with flask_app.app_context():
        challenge = make_challenge("alice")
        payload, mac = challenge.rsplit(".", 1)
        assert not challenge_is_valid("alice", payload + "." + ("0" * len(mac)))


def test_old_and_future_challenges_are_rejected(flask_app):
    with flask_app.app_context():
        with mock.patch("core.deviceauth.time.time", return_value=1_000_000):
            challenge = make_challenge("alice")
        with mock.patch("core.deviceauth.time.time", return_value=1_000_000 + CHALLENGE_MAX_AGE + 1):
            assert not challenge_is_valid("alice", challenge)
        with mock.patch("core.deviceauth.time.time", return_value=1_000_000 - 5):
            assert not challenge_is_valid("alice", challenge)


def test_a_challenge_is_consumed_exactly_once(flask_app):
    with flask_app.app_context():
        challenge = make_challenge("alice")
        assert consume_challenge("alice", challenge) is True
        assert consume_challenge("alice", challenge) is False


def test_consuming_an_invalid_challenge_fails(flask_app):
    with flask_app.app_context():
        assert consume_challenge("alice", "garbage") is False


def test_consumed_challenges_are_forgotten_after_they_expire(flask_app):
    with flask_app.app_context():
        challenge = make_challenge("alice")
        consume_challenge("alice", challenge)
        assert len(deviceauth._used_challenges) == 1
        future = time.time() + CHALLENGE_MAX_AGE + 5
        with mock.patch("core.deviceauth.time.time", return_value=future):
            other = deviceauth.make_challenge("alice")
            assert consume_challenge("alice", other) is True
        assert len(deviceauth._used_challenges) == 1       # the old entry was purged


def test_only_one_thread_can_consume_a_challenge(flask_app):
    with flask_app.app_context():
        challenge = make_challenge("alice")
    results = []

    def attempt():
        with flask_app.app_context():
            results.append(consume_challenge("alice", challenge))

    threads = [threading.Thread(target=attempt) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count(True) == 1


def test_valid_signature_is_accepted():
    device = Device()
    assert signature_is_valid(device.jwk, b"vault-v1|x|c", device.sign("x", [], "c"))


def test_signature_for_another_message_is_rejected():
    device = Device()
    assert not signature_is_valid(device.jwk, b"something else", device.sign("x", [], "c"))


def test_signature_from_another_key_is_rejected():
    assert not signature_is_valid(Device().jwk, b"vault-v1|x|c", Device().sign("x", [], "c"))


@pytest.mark.parametrize("signature", [None, 5, "", "short", "A" * 85, "A" * 87, "!" * 86])
def test_malformed_signatures_are_rejected(signature):
    assert not signature_is_valid(Device().jwk, b"msg", signature)


def test_signature_with_a_broken_public_key_is_rejected():
    device = Device()
    assert not signature_is_valid({"x": "bad"}, b"msg", device.sign("x", [], "c"))
    assert not signature_is_valid({}, b"msg", device.sign("x", [], "c"))


def test_signature_that_decodes_to_the_wrong_length_is_rejected():
    # 86 base64url characters always decode to 64 bytes, so force the odd case with a patch
    with mock.patch("core.deviceauth.b64url_decode", return_value=b"short"):
        assert not signature_is_valid(Device().jwk, b"msg", "A" * 86)


def test_fingerprint_is_stable_and_short():
    device = Device()
    assert fingerprint(device.jwk) == fingerprint(dict(device.jwk))
    assert len(fingerprint(device.jwk)) == 14
    assert fingerprint(device.jwk) != fingerprint(Device().jwk)


class UserRef:
    """The smallest thing verify_device_proof needs: .collection().document().get()."""

    def __init__(self, record):
        self.record = record

    def collection(self, name):
        return self

    def document(self, doc_id):
        return self

    def get(self):
        record = self.record
        return mock.Mock(exists=record is not None, to_dict=lambda: record)


def proof(flask_app, device, record, **changes):
    with flask_app.app_context():
        challenge = make_challenge("alice")
        data = {"deviceId": device.device_id, "challenge": challenge,
                "signature": device.sign("act", ["p1"], challenge)}
        data.update(changes)
        return verify_device_proof(UserRef(record), "alice", data, "act", ["p1"])


def test_proof_accepts_a_good_request(flask_app):
    device = Device()
    assert proof(flask_app, device, device.record())["name"] == "Home PC"


def test_proof_only_works_once(flask_app):
    device = Device()
    with flask_app.app_context():
        challenge = make_challenge("alice")
        data = {"deviceId": device.device_id, "challenge": challenge,
                "signature": device.sign("act", [], challenge)}
        assert verify_device_proof(UserRef(device.record()), "alice", data, "act", [])
        assert verify_device_proof(UserRef(device.record()), "alice", data, "act", []) is None


@pytest.mark.parametrize("data", [None, [], "x", 5])
def test_proof_needs_a_dict(flask_app, data):
    with flask_app.app_context():
        assert verify_device_proof(UserRef({}), "alice", data, "act", []) is None


@pytest.mark.parametrize("device_id", [None, "nope", 12])
def test_proof_needs_a_valid_device_id(flask_app, device_id):
    device = Device()
    assert proof(flask_app, device, device.record(), deviceId=device_id) is None


def test_proof_needs_an_existing_device(flask_app):
    assert proof(flask_app, Device(), None) is None


def test_proof_rejects_a_non_dict_record(flask_app):
    device = Device()
    with flask_app.app_context():
        ref = UserRef(None)
        ref.get = lambda: mock.Mock(exists=True, to_dict=lambda: "not a dict")
        data = {"deviceId": device.device_id, "challenge": "x", "signature": "y"}
        assert verify_device_proof(ref, "alice", data, "act", []) is None


def test_proof_rejects_revoked_devices(flask_app):
    device = Device()
    assert proof(flask_app, device, device.record(status="revoked")) is None


def test_proof_rejects_the_wrong_device_type(flask_app):
    phone = Device("phone")
    assert proof(flask_app, phone, phone.record()) is None          # default allows desktops only


def test_proof_rejects_a_bad_challenge(flask_app):
    device = Device()
    assert proof(flask_app, device, device.record(), challenge="garbage") is None


@pytest.mark.parametrize("action,parts", [(5, []), ("act", "p1"), ("act", [1, 2])])
def test_proof_validates_action_and_parts(flask_app, action, parts):
    device = Device()
    with flask_app.app_context():
        challenge = make_challenge("alice")
        data = {"deviceId": device.device_id, "challenge": challenge, "signature": "A" * 86}
        assert verify_device_proof(UserRef(device.record()), "alice", data, action, parts) is None


def test_proof_rejects_a_bad_signature_without_burning_the_challenge(flask_app):
    device = Device()
    with flask_app.app_context():
        challenge = make_challenge("alice")
        data = {"deviceId": device.device_id, "challenge": challenge, "signature": "A" * 86}
        assert verify_device_proof(UserRef(device.record()), "alice", data, "act", ["p1"]) is None
        data["signature"] = device.sign("act", ["p1"], challenge)
        assert verify_device_proof(UserRef(device.record()), "alice", data, "act", ["p1"])


def test_proof_loses_a_replay_race(flask_app):
    device = Device()
    with flask_app.app_context(), mock.patch("core.deviceauth.consume_challenge", return_value=False):
        challenge = make_challenge("alice")
        data = {"deviceId": device.device_id, "challenge": challenge,
                "signature": device.sign("act", ["p1"], challenge)}
        assert verify_device_proof(UserRef(device.record()), "alice", data, "act", ["p1"]) is None


# ======================= signaling =======================

def test_hub_delivers_messages_in_order():
    hub = SignalHub()
    first = hub.publish("u", "d", {"n": 1})
    second = hub.publish("u", "d", {"n": 2})
    assert second > first
    assert hub.wait("u", "d", 0, 0) == [(first, {"n": 1}), (second, {"n": 2})]
    assert hub.wait("u", "d", first, 0) == [(second, {"n": 2})]
    assert hub.wait("u", "d", second, 0) == []


def test_hub_mailboxes_are_separate():
    hub = SignalHub()
    hub.publish("u", "d1", {"n": 1})
    assert hub.wait("u", "d2", 0, 0) == []
    assert hub.wait("other", "d1", 0, 0) == []


def test_hub_drops_old_and_surplus_messages():
    hub = SignalHub(ttl=0.05, max_per_box=3)
    for n in range(6):
        hub.publish("u", "d", {"n": n})
    assert [event["n"] for _, event in hub.wait("u", "d", 0, 0)] == [3, 4, 5]
    time.sleep(0.1)
    assert hub.wait("u", "d", 0, 0) == []
    hub.publish("u", "d", {"n": 9})
    assert [event["n"] for _, event in hub.wait("u", "d", 0, 0)] == [9]


def test_hub_wait_wakes_up_when_a_message_arrives():
    hub = SignalHub()
    threading.Timer(0.1, hub.publish, args=("u", "d", {"n": 1})).start()
    started = time.monotonic()
    result = hub.wait("u", "d", 0, 5)
    assert result[0][1] == {"n": 1}
    assert time.monotonic() - started < 2


def test_hub_wait_times_out():
    started = time.monotonic()
    assert SignalHub().wait("u", "d", 0, 0.1) == []
    assert 0.08 < time.monotonic() - started < 1


def test_registry_lifecycle():
    registry = TransferRegistry()
    transfer_id = registry.create("u", "from", "to", "hash")
    uuid.UUID(transfer_id)
    item = registry.get("u", transfer_id)
    assert (item["from"], item["to"], item["offer_hash"], item["status"]) == ("from", "to", "hash", "offered")
    assert registry.active_count("u") == 1
    assert registry.active_count("someone-else") == 0

    assert registry.mark_answered("u", transfer_id) is True
    assert registry.mark_answered("u", transfer_id) is False
    assert registry.mark_answered("u", "missing") is False

    registry.remove("u", transfer_id)
    registry.remove("u", transfer_id)                       # removing twice is harmless
    assert registry.get("u", transfer_id) is None
    assert registry.active_count("u") == 0


def test_registry_get_returns_a_copy():
    registry = TransferRegistry()
    transfer_id = registry.create("u", "a", "b", "h")
    registry.get("u", transfer_id)["status"] = "hacked"
    assert registry.get("u", transfer_id)["status"] == "offered"


def test_registry_counts_ice_messages_up_to_a_limit():
    registry = TransferRegistry()
    transfer_id = registry.create("u", "a", "b", "h")
    assert registry.note_ice("u", transfer_id, 2) is True
    assert registry.note_ice("u", transfer_id, 2) is True
    assert registry.note_ice("u", transfer_id, 2) is False
    assert registry.note_ice("u", "missing", 2) is False


def test_registry_forgets_idle_transfers():
    registry = TransferRegistry(idle_ttl=0.05)
    transfer_id = registry.create("u", "a", "b", "h")
    time.sleep(0.1)
    assert registry.get("u", transfer_id) is None
    assert registry.active_count("u") == 0


# ======================= config =======================

@pytest.fixture
def env(monkeypatch):
    values = {
        "VAULT_ENV": "development",
        "SECRET_KEY": "x" * 32,
        "FIREBASE_API_KEY": "k",
        "FIREBASE_AUTH_DOMAIN": "d",
        "FIREBASE_PROJECT_ID": "p",
        "FIREBASE_APP_ID": "a",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return monkeypatch


@pytest.fixture
def fresh_config(env):
    """get_config() reads class attributes that were set when core.config was imported."""
    import importlib

    import core.config as config

    def build(**overrides):
        for key, value in overrides.items():
            if value is None:
                env.delenv(key, raising=False)
            else:
                env.setenv(key, value)
        reloaded = importlib.reload(config)
        return reloaded.get_config()

    yield build
    env.undo()                      # back to the settings from conftest.py
    importlib.reload(config)


def test_development_config(fresh_config):
    cfg = fresh_config()
    assert cfg.DEBUG is True and cfg.ENFORCE_HTTPS is False
    assert cfg.AUTH_COOKIE_NAME == "vault_auth" and cfg.AUTH_COOKIE_SECURE is False


def test_anything_but_development_is_production(fresh_config):
    for value in ("production", "staging", "", "DEVELOPMENT "):
        cfg = fresh_config(VAULT_ENV=value)
        assert cfg.ENFORCE_HTTPS is True
        assert cfg.AUTH_COOKIE_NAME == "__Host-vault_auth"
        assert cfg.DEBUG is False


def test_environment_is_case_insensitive(fresh_config):
    assert fresh_config(VAULT_ENV="DeveLopment").DEBUG is True


@pytest.mark.parametrize("name", REQUIRED)
def test_missing_required_settings_are_reported(fresh_config, name):
    with pytest.raises(RuntimeError, match=name):
        fresh_config(**{name: ""})


def test_short_secret_key_is_rejected(fresh_config):
    with pytest.raises(RuntimeError, match="at least 32"):
        fresh_config(SECRET_KEY="short")


def test_turn_settings_must_come_together(fresh_config):
    with pytest.raises(RuntimeError, match="TURN_URLS and TURN_SECRET"):
        fresh_config(TURN_URLS="turn:x", TURN_SECRET="")
    with pytest.raises(RuntimeError, match="TURN_URLS and TURN_SECRET"):
        fresh_config(TURN_URLS="", TURN_SECRET="s")
    assert fresh_config(TURN_URLS="turn:x", TURN_SECRET="s").TURN_URLS == "turn:x"


# ======================= firebase_setup =======================

class FakeApp:
    def __init__(self, **config):
        self.config = {"FIREBASE_CREDENTIALS_BASE64": "", "FIREBASE_CREDENTIALS_FILE": "key.json", **config}


def test_credentials_from_base64():
    encoded = base64.b64encode(json.dumps({"type": "service_account"}).encode()).decode()
    with mock.patch("core.firebase_setup.credentials.Certificate", return_value="cert") as certificate:
        assert _load_credentials(FakeApp(FIREBASE_CREDENTIALS_BASE64=encoded)) == "cert"
    certificate.assert_called_once_with({"type": "service_account"})


@pytest.mark.parametrize("encoded", ["!!!not-base64!!!", base64.b64encode(b"not json").decode()])
def test_bad_base64_credentials_have_a_clear_error(encoded):
    with pytest.raises(RuntimeError, match="not valid base64-encoded JSON"):
        _load_credentials(FakeApp(FIREBASE_CREDENTIALS_BASE64=encoded))


def test_credentials_from_a_key_file(tmp_path):
    key = tmp_path / "key.json"
    key.write_text("{}")
    with mock.patch("core.firebase_setup.credentials.Certificate", return_value="cert") as certificate:
        assert _load_credentials(FakeApp(FIREBASE_CREDENTIALS_FILE=str(key))) == "cert"
    certificate.assert_called_once_with(str(key))


def test_relative_key_paths_are_resolved_from_the_container_folder():
    with mock.patch("core.firebase_setup.os.path.isfile", return_value=True) as isfile, \
            mock.patch("core.firebase_setup.credentials.Certificate"):
        _load_credentials(FakeApp(FIREBASE_CREDENTIALS_FILE="serviceAccountKey.json"))
    assert isfile.call_args.args[0].endswith("container/serviceAccountKey.json")


def test_missing_key_file_has_a_clear_error(tmp_path):
    with pytest.raises(RuntimeError, match="not found"):
        _load_credentials(FakeApp(FIREBASE_CREDENTIALS_FILE=str(tmp_path / "missing.json")))


def test_init_firebase_uses_the_loaded_credentials():
    with mock.patch("core.firebase_setup._load_credentials", return_value="cert"), \
            mock.patch("core.firebase_setup.firebase_admin.initialize_app") as initialize:
        init_firebase(FakeApp())
    initialize.assert_called_once_with("cert")


def test_get_db_returns_a_firestore_client():
    with mock.patch("core.firebase_setup.firestore.client", return_value="client"):
        assert get_db() == "client"


# ======================= extensions / asgi =======================

def test_every_route_is_limited_to_120_requests_per_minute(api):
    from core.extensions import limiter

    limiter.enabled = True
    codes = [api.get("/api/health").status_code for _ in range(121)]
    assert codes[:120] == [200] * 120
    assert codes[120] == 429


def test_asgi_entry_point_wraps_the_flask_app():
    import asgi
    from app import app

    assert asgi.asgi_app.app is app