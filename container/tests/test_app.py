from unittest import mock

import pytest

import app as app_module
from core.security import build_csp


def test_index_page_is_served(api):
    response = api.get("/")
    assert response.status_code == 200
    assert b"<title>Vault</title>" in response.data


def test_health_check(api):
    response = api.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_unknown_api_path_returns_json_404(api):
    response = api.get("/api/nope")
    assert response.status_code == 404
    assert response.get_json() == {"error": "Not Found"}


def test_wrong_method_returns_json_405(api):
    response = api.client.put("/api/health", headers={"Origin": "http://localhost", "X-Vault-Request": "1"})
    assert response.status_code == 405
    assert response.get_json() == {"error": "Method Not Allowed"}


def test_unexpected_error_returns_generic_500(flask_app, api, login, monkeypatch):
    login()

    def boom(*args, **kwargs):
        raise RuntimeError("secret detail that must not leak")

    monkeypatch.setattr("routes.devices.make_challenge", boom)
    monkeypatch.setitem(flask_app.config, "PROPAGATE_EXCEPTIONS", False)
    response = api.post("/api/devices/challenge")
    assert response.status_code == 500
    assert response.get_json() == {"error": "Internal Server Error"}
    assert b"secret detail" not in response.data


def test_static_files_are_served(api):
    response = api.get("/static/js/main.js")
    assert response.status_code == 200
    assert "javascript" in response.content_type
    response.close()


def test_manifest_has_the_right_mime_type(api):
    response = api.get("/static/manifest.webmanifest")
    assert response.status_code == 200
    assert response.content_type.startswith("application/manifest+json")
    response.close()


def test_page_templates_cannot_be_downloaded_raw(api):
    response = api.get("/static/templates/index.html")
    assert response.status_code == 404
    assert response.get_json() == {"error": "Not Found"}


def test_security_headers_on_every_response(api):
    response = api.get("/")
    assert response.headers["Content-Security-Policy"] == build_csp("vault-test.firebaseapp.com")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "camera=()" in response.headers["Permissions-Policy"]
    assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin-allow-popups"
    assert "Strict-Transport-Security" not in response.headers      # development: plain http is fine
    assert "no-store" not in response.headers.get("Cache-Control", "")


def test_api_responses_are_never_cached(api):
    assert api.get("/api/health").headers["Cache-Control"] == "no-store"


def test_csp_blocks_everything_by_default():
    csp = build_csp("example.firebaseapp.com")
    assert "default-src 'none'" in csp
    assert "frame-src https://example.firebaseapp.com" in csp
    assert "frame-ancestors 'none'" in csp


# ---------- production behaviour: https redirect, HSTS, __Host- cookie, proxy ----------

@pytest.fixture
def production_app(monkeypatch):
    monkeypatch.setenv("VAULT_ENV", "production")

    def build(proxy_hops=0):
        monkeypatch.setattr("core.config.BaseConfig.PROXY_HOPS", proxy_hops)
        with mock.patch("firebase_admin.initialize_app"), mock.patch("firebase_admin.credentials.Certificate"):
            return app_module.create_app()

    return build


def test_production_redirects_http_to_https(production_app):
    client = production_app(proxy_hops=0).test_client()
    response = client.get("/")
    assert response.status_code == 308
    assert response.headers["Location"].startswith("https://")


def test_production_warns_when_no_proxy_is_configured(production_app, caplog):
    production_app(proxy_hops=0)
    assert "PROXY_HOPS=0" in caplog.text


def test_production_health_check_works_over_plain_http(production_app):
    client = production_app(proxy_hops=0).test_client()
    assert client.get("/api/health").status_code == 200


def test_production_sets_hsts_and_trusts_the_proxy(production_app):
    client = production_app(proxy_hops=1).test_client()
    response = client.get("/", headers={"X-Forwarded-Proto": "https"})
    assert response.status_code == 200
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000"


def test_production_uses_the_host_cookie_name(production_app):
    app = production_app(proxy_hops=1)
    assert app.config["AUTH_COOKIE_NAME"] == "__Host-vault_auth"
    assert app.config["AUTH_COOKIE_SECURE"] is True