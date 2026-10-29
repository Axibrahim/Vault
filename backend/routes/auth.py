import time
from functools import wraps

from firebase_admin import auth as fb_auth
from firebase_admin import firestore
from flask import Blueprint, current_app, g, jsonify, request
from google.api_core.exceptions import AlreadyExists

from core.extensions import limiter
from core.firebase_setup import get_db

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

def _fail(message, status):
    resp = jsonify(error=message)
    resp.status_code = status
    return resp

def _clear_cookie(resp):
    cfg = current_app.config
    resp.delete_cookie(
        cfg["AUTH_COOKIE_NAME"],
        path="/",
        secure=cfg["AUTH_COOKIE_SECURE"],
        httponly=True,
        samesite=cfg["AUTH_COOKIE_SAMESITE"]
    )
    return resp

def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        cookie = request.cookies.get(current_app.config["AUTH_COOKIE_NAME"])
        if not cookie:
            return _fail("Not authenticated", 401)

        try:
            # check_revoked = true asks firebase whether this session was revoked
            claims = fb_auth.verify_session_cookie(cookie, check_revoked=True)
        except Exception as e:
            current_app.logger.info("session rejected: %s", type(e).__name__)
            return _clear_cookie(_fail("Not authenticated", 401))

        g.uid = claims["uid"]
        g.email = claims.get("email")
        return view(*args, **kwargs)

    return wrapper


def _ensure_user(decoded):
    ref = get_db().collection("users").document(decoded["uid"])
    try:
        # create() fails if the document already exists, so this is atomic
        ref.create({
            "email": decoded.get("email"),
            "account_state": "no_devices",
            "created_at": firestore.SERVER_TIMESTAMP,
            "last_login": firestore.SERVER_TIMESTAMP,
        })
    except AlreadyExists:
        ref.update({"last_login": firestore.SERVER_TIMESTAMP})


@bp.get("/config")
def public_config():
    cfg = current_app.config
    return jsonify(
        apiKey=cfg["FIREBASE_API_KEY"],
        authDomain=cfg["FIREBASE_AUTH_DOMAIN"],
        projectId=cfg["FIREBASE_PROJECT_ID"],
        appId=cfg["FIREBASE_APP_ID"],
    )


@bp.post("/login")
@limiter.limit("10 per minute; 60 per hour")
def login():
    data = request.get_json(silent=True) or {}
    id_token = data.get("idToken")
    if not isinstance(id_token, str) or not 20 <= len(id_token) <= 4096:
        return _fail("Invalid request", 400)

    # 1) verify signature, expiry, audiance and revokation.
    try:
        decoded = fb_auth.verify_id_token(id_token, check_revoked=True)
    except Exception as e:
        current_app.logger.warning("login rejected: %s", type(e).__name__)
        return _fail("Authentication failed", 401)

    # 2) our own rules on top of firebase's
    if decoded.get("firebase", {}).get("sign_in_provider") != "google.com":
        return _fail("Authentication failed", 401)
    if decoded.get("email_verified") is not True:
        return _fail("Authentication failed", 401)
    if time.time() - decoded.get("auth_time", 0) > current_app.config["LOGIN_MAX_AGE_SECONDS"]:
        return _fail("Authentication failed", 401)

    # 3) swap the short-lived ID token for a longer-lived session token
    duration = current_app.config["AUTH_SESSION_DURATION"]
    try:
        session_cookie = fb_auth.create_session_cookie(id_token, expires_in=duration)
    except Exception as e:
        current_app.logger.warning("session cookie failed: %s", type(e). __name__)
        return _fail("Authentication failed", 401)

    # 4) make sure the user have a recordin the db
    _ensure_user(decoded)

    resp = jsonify(status="ok", email=decoded.get("email"))
    cfg = current_app.config
    resp.set_cookie(
        cfg["AUTH_COOKIE_NAME"],
        session_cookie,
        max_age=int(duration.total_seconds()),
        secure=cfg["AUTH_COOKIE_SECURE"],
        httponly=True,
        samesite=cfg["AUTH_COOKIE_SAMESITE"],
        path="/",
    )
    return resp

@bp.get("/me")
@login_required
def me():
    return jsonify(uid=g.uid, email=g.email)


@bp.post("/logout")
def logout():
    return _clear_cookie(jsonify(status="ok"))


@bp.post("/logout-all")
@login_required
def logout_all():
    # invalidates every ssession and refresh token this user has, on every single device
    fb_auth.revoke_refresh_tokens(g.uid)
    return _clear_cookie(jsonify(status="ok"))

                                   
