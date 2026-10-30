from urllib.parse import urlsplit

from flask import redirect, request, jsonify

UNSAFE_METHODS = {"POST", "PATCH", "DELETE", "PUT"}


def build_csp(auth_domain):
    return "; ".join([
    "default-src 'none'",       # block everything unless a rule below allows it
    "script-src 'self' https://apis.google.com https://www.gstatic.com",
    "style-src 'self'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "font-src 'self'",
    "connect-src 'self' https://identitytoolkit.googleapis.com "
    "https://securetoken.googleapis.com https://www.googleapis.com",
    f"frame-src https://{auth_domain}",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


def register_security(app):
    csp = build_csp(app.config["FIREBASE_AUTH_DOMAIN"])

    @app.before_request
    def hide_templates():
        # page templates live in static/ but must never be downloadable as raw files
        if request.path.startswith("/static/templates"):
            return jsonify(error="Not Found"), 404

    @app.before_request
    def enforce_https():
        if request.path == "/api/health":
            return None    # the hosting platform checks this over plain http
        if app.config["ENFORCE_HTTPS"] and not request.is_secure:
            return redirect(request.url.replace("http://", "https://", 1), code=308)

    @app.before_request
    def csrf_guard():
        if request.method not in UNSAFE_METHODS:
            return None

        # 1) The browser must confirms that we are who sent the request
        origin = request.headers.get("Origin")
        if not origin:
            return jsonify(error="Forbidden"), 403
        parts = urlsplit(origin)
        if parts.scheme != request.scheme or parts.netloc != request.host:
            return jsonify(error="Forbidden"), 403

        # 2) Our own JS always adds this header. Plain HTML forms cannot.
        if request.headers.get("X-Vault-Request") !="1":
            return jsonify(error="Forbidden"), 403

        return None

    @app.after_request
    def add_securiry_headers(resp):
        resp.headers["Content-Security-Policy"] = csp
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"     # your URLs are never leaked to other sites
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"

        if app.config["ENFORCE_HTTPS"]:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"

        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"

        return resp