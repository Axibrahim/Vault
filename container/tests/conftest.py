import base64
import os
import time
from unittest import mock

# --- Settings must exist BEFORE the app is imported (core/config.py reads them on import) ---
os.environ.update(
    VAULT_ENV="development",
    SECRET_KEY="test-secret-key-that-is-at-least-32-characters-long",  # gitleaks:allow
    FIREBASE_API_KEY="test-api-key",
    FIREBASE_AUTH_DOMAIN="vault-test.firebaseapp.com",
    FIREBASE_PROJECT_ID="vault-test",
    FIREBASE_APP_ID="1:123:web:abc",
    FIREBASE_CREDENTIALS_BASE64=base64.b64encode(b"{}").decode(),
    PROXY_HOPS="0",
    STUN_URLS="stun:stun.example.com:3478",
    TURN_URLS="",
    TURN_SECRET="",
)

import firebase_admin.firestore as _fs  # noqa: E402

# Firestore's @transactional needs a live database. The tests run the same function
# bodies against an in-memory fake instead (see tests/fakes.py).
_fs.transactional = lambda fn: fn

import pytest  # noqa: E402
from firebase_admin import auth as fb_auth  # noqa: E402

with mock.patch("firebase_admin.initialize_app"), mock.patch("firebase_admin.credentials.Certificate"):
    import app as app_module  # noqa: E402

from core import deviceauth  # noqa: E402
from core.extensions import limiter  # noqa: E402
from core.signaling import hub, registry  # noqa: E402
from tests.fakes import FakeDb  # noqa: E402
from tests.helpers import Api, Device  # noqa: E402


@pytest.fixture(scope="session")
def flask_app():
    app = app_module.app
    app.config.update(TESTING=True)
    return app


@pytest.fixture(autouse=True)
def clean_state():
    """Every test starts with empty in-memory mailboxes, challenges and rate-limit counters."""
    hub._boxes.clear()
    registry._items.clear()
    deviceauth._used_challenges.clear()
    limiter.reset()
    limiter.enabled = False          # turned on only by the tests that check rate limits
    yield
    limiter.enabled = False


@pytest.fixture
def db(monkeypatch):
    fake = FakeDb()
    for target in (
        "routes.auth.get_db",
        "routes.devices.get_db",
        "routes.pairing.get_db",
        "routes.transfers.get_db",
        "core.firebase_setup.get_db",
    ):
        monkeypatch.setattr(target, lambda fake=fake: fake)
    return fake


class AuthStub:
    """Replaces the Firebase Admin calls that need the network."""

    def __init__(self):
        self.sessions = {}          # cookie value -> claims
        self.id_tokens = {}         # id token -> claims
        self.revoked_uids = []
        self.cookie_error = None
        self.created_cookies = []

    def verify_session_cookie(self, cookie, check_revoked=False):
        assert check_revoked is True
        if cookie not in self.sessions:
            raise ValueError("bad session cookie")
        return self.sessions[cookie]

    def verify_id_token(self, token, check_revoked=False):
        assert check_revoked is True
        if token not in self.id_tokens:
            raise ValueError("bad id token")
        return self.id_tokens[token]

    def create_session_cookie(self, token, expires_in):
        if self.cookie_error:
            raise self.cookie_error
        self.created_cookies.append((token, expires_in))
        return "session-" + token

    def revoke_refresh_tokens(self, uid):
        self.revoked_uids.append(uid)


@pytest.fixture
def stub(monkeypatch):
    stub = AuthStub()
    monkeypatch.setattr(fb_auth, "verify_session_cookie", stub.verify_session_cookie)
    monkeypatch.setattr(fb_auth, "verify_id_token", stub.verify_id_token)
    monkeypatch.setattr(fb_auth, "create_session_cookie", stub.create_session_cookie)
    monkeypatch.setattr(fb_auth, "revoke_refresh_tokens", stub.revoke_refresh_tokens)
    return stub


@pytest.fixture
def api(flask_app, db, stub):
    return Api(flask_app.test_client())


@pytest.fixture
def login(api, stub):
    """login(uid, age=10) signs the test client in. `age` = seconds since the Google sign-in."""

    def _login(uid="user-1", email="user@example.com", age=10):
        cookie = f"cookie-{uid}"
        stub.sessions[cookie] = {"uid": uid, "email": email, "auth_time": time.time() - age}
        api.client.set_cookie("vault_auth", cookie)
        return uid

    return _login


@pytest.fixture
def seed(db):
    """seed.user(uid, state) and seed.device(uid, device) put documents into the fake database."""

    class Seeder:
        @staticmethod
        def user(uid="user-1", state="no_devices"):
            db.collection("users").document(uid).set({"email": "user@example.com", "account_state": state})

        @staticmethod
        def device(device, uid="user-1", status="active"):
            db.collection("users").document(uid).collection("devices").document(device.device_id).set(
                device.record(status)
            )

    return Seeder


@pytest.fixture
def desktop(seed, login):
    """A signed-in account whose computer is enrolled. Returns the computer's Device."""
    uid = login()
    seed.user(uid, "desktop_enrolled")
    device = Device("desktop", "Home PC")
    seed.device(device, uid)
    return device