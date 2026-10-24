from flask import redirect, request


CSP = "; ".join([
    "default-src 'none'",       # block everything unless a rule below allows it
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors" 'none',
])


def register_security(app):
    @app.before_request
    def enforce_https():
        if app.config["ENFORCE_HTTPS"] and not request.is_secure:
            return redirect(request.url.replace("http://", "https://", 1), code=308)

    @app.after_request
    def add_securiry_headers(resp):
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Froma-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"     # your URLs are never leaked to other sites
        resp.headers["Permissions-Policy"] = "camera=(), microphone(), geolocation=()"
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"

        if app.config["ENFORCE_HTTPS"]:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"

        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"

        return resp