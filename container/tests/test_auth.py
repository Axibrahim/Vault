import time

import pytest

GOOD_TOKEN = "t" * 40


def google_claims(**overrides):
    claims = {
        "uid": "user-1",
        "email": "user@example.com",
        "email_verified": True,
        "auth_time": time.time() - 5,
        "firebase": {"sign_in_provider": "google.com"},
    }
    claims.update(overrides)
    return claims


@pytest.fixture
def good_token(stub):
    stub.id_tokens[GOOD_TOKEN] = google_claims()
    return GOOD_TOKEN


# ---------- GET /api/auth/config ----------

def test_public_config_returns_only_public_firebase_settings(api):
    response = api.get("/api/auth/config")
    assert response.status_code == 200
    assert response.get_json() == {
        "apiKey": "test-api-key",
        "authDomain": "vault-test.firebaseapp.com",
        "projectId": "vault-test",
        "appId": "1:123:web:abc",
    }


# ---------- POST /api/auth/login ----------

@pytest.mark.parametrize("body", [None, {}, {"idToken": 123}, {"idToken": "short"}, {"idToken": "x" * 5000}])
def test_login_rejects_bad_requests(api, body):
    response = api.post("/api/auth/login", json=body)
    assert response.status_code == 400
    assert response.get_json() == {"error": "Invalid request"}


def test_login_rejects_unverifiable_token(api):
    response = api.post("/api/auth/login", json={"idToken": "u" * 40})
    assert response.status_code == 401
    assert response.get_json() == {"error": "Authentication failed"}
    assert "Set-Cookie" not in response.headers


def test_login_rejects_non_google_provider(api, stub):
    stub.id_tokens[GOOD_TOKEN] = google_claims(firebase={"sign_in_provider": "password"})
    assert api.post("/api/auth/login", json={"idToken": GOOD_TOKEN}).status_code == 401


def test_login_rejects_unverified_email(api, stub):
    stub.id_tokens[GOOD_TOKEN] = google_claims(email_verified=False)
    assert api.post("/api/auth/login", json={"idToken": GOOD_TOKEN}).status_code == 401


def test_login_rejects_a_stale_google_sign_in(api, stub):
    stub.id_tokens[GOOD_TOKEN] = google_claims(auth_time=time.time() - 3600)
    assert api.post("/api/auth/login", json={"idToken": GOOD_TOKEN}).status_code == 401


def test_login_fails_cleanly_when_firebase_cannot_make_a_cookie(api, stub, good_token):
    stub.cookie_error = RuntimeError("firebase down")
    response = api.post("/api/auth/login", json={"idToken": good_token})
    assert response.status_code == 401
    assert "Set-Cookie" not in response.headers


def test_login_creates_the_user_and_a_browser_session_cookie(api, db, stub, good_token):
    response = api.post("/api/auth/login", json={"idToken": good_token})
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok", "email": "user@example.com", "remember": False}

    cookie = response.headers["Set-Cookie"]
    assert cookie.startswith("vault_auth=session-")
    assert "HttpOnly" in cookie
    assert "SameSite=Strict" in cookie
    assert "Max-Age" not in cookie                      # disappears when the browser closes
    assert stub.created_cookies[0][1].total_seconds() == 8 * 3600

    user = db.collection("users").document("user-1").get().to_dict()
    assert user["account_state"] == "no_devices"
    assert user["email"] == "user@example.com"


def test_login_with_remember_sets_a_14_day_cookie(api, stub, good_token):
    response = api.post("/api/auth/login", json={"idToken": good_token, "remember": True})
    assert response.status_code == 200
    assert response.get_json()["remember"] is True
    assert f"Max-Age={14 * 24 * 3600}" in response.headers["Set-Cookie"]


def test_remember_must_be_the_boolean_true(api, good_token):
    response = api.post("/api/auth/login", json={"idToken": good_token, "remember": "yes"})
    assert response.get_json()["remember"] is False


def test_second_login_keeps_the_account_state(api, db, seed, good_token):
    seed.user("user-1", "desktop_enrolled")
    assert api.post("/api/auth/login", json={"idToken": good_token}).status_code == 200
    user = db.collection("users").document("user-1").get().to_dict()
    assert user["account_state"] == "desktop_enrolled"
    assert "last_login" in user


def test_login_needs_the_csrf_headers(api, good_token):
    response = api.post("/api/auth/login", json={"idToken": good_token}, csrf=False)
    assert response.status_code == 403


def test_login_is_rate_limited(api, good_token):
    from core.extensions import limiter

    limiter.enabled = True
    codes = [api.post("/api/auth/login", json={"idToken": good_token}).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10
    assert codes[10] == 429


# ---------- GET /api/auth/me ----------

def test_me_requires_a_session(api):
    response = api.get("/api/auth/me")
    assert response.status_code == 401
    assert response.get_json() == {"error": "Not authenticated"}


def test_me_rejects_and_clears_an_invalid_cookie(api):
    api.client.set_cookie("vault_auth", "garbage")
    response = api.get("/api/auth/me")
    assert response.status_code == 401
    assert "vault_auth=;" in response.headers["Set-Cookie"]       # the browser is told to delete it


def test_me_returns_the_signed_in_user(api, login):
    login("user-9", "nine@example.com")
    assert api.get("/api/auth/me").get_json() == {"uid": "user-9", "email": "nine@example.com"}


# ---------- POST /api/auth/logout and /logout-all ----------

def test_logout_clears_the_cookie_even_without_a_session(api):
    response = api.post("/api/auth/logout")
    assert response.status_code == 200
    assert "vault_auth=;" in response.headers["Set-Cookie"]


def test_logout_all_requires_a_session(api):
    assert api.post("/api/auth/logout-all").status_code == 401


def test_logout_all_revokes_every_session(api, login, stub):
    login("user-3")
    response = api.post("/api/auth/logout-all")
    assert response.status_code == 200
    assert stub.revoked_uids == ["user-3"]
    assert "vault_auth=;" in response.headers["Set-Cookie"]


# ---------- fresh_login_required (used by enroll, revoke, pairing) ----------

def test_sensitive_routes_ask_for_a_recent_sign_in(api, login):
    login(age=3600)                                   # signed in an hour ago
    response = api.post("/api/devices/enroll-desktop", json={})
    assert response.status_code == 401
    assert response.get_json()["code"] == "reauth_required"