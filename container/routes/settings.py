"""Everything the Settings panel shows, in one request.

Nothing here comes from the browser: who you are, when you signed in and when the
session ends are read from the verified Firebase session cookie (checked against
Google's revocation list on every request), and the devices are read from YOUR
account document. Another account's data can never be asked for.
"""
from datetime import datetime, timezone

from flask import Blueprint, g, jsonify

from core.deviceauth import fingerprint
from core.firebase_setup import get_db
from routes.auth import login_required
from routes.devices import MAX_PER_TYPE

bp = Blueprint("settings", __name__, url_prefix="/api/settings")


def _iso(value):
    return value.isoformat() if value else None


def _from_seconds(seconds):
    """Firebase tokens carry times as seconds since 1970."""
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat() if seconds else None


@bp.get("")
@login_required
def overview():
    user_ref = get_db().collection("users").document(g.uid)
    user = user_ref.get().to_dict() or {}

    devices = []
    for doc in user_ref.collection("devices").stream():
        d = doc.to_dict()
        if d.get("status") != "active":
            continue
        devices.append({
            "id": doc.id,
            "type": d.get("type"),
            "name": d.get("name"),
            "createdAt": _iso(d.get("created_at")),
            "fingerprint": fingerprint(d["public_key"]),     # the short code both devices can compare
        })
    devices.sort(key=lambda item: (item["type"], item["createdAt"] or "", item["id"]))

    return jsonify(
        account={
            "email": g.email,
            "provider": "google.com",                         # login() refuses every other provider
            "signedInAt": _from_seconds(g.auth_time),
            "sessionExpiresAt": _from_seconds(g.session_exp),
            "createdAt": _iso(user.get("created_at")),
        },
        devices=devices,
        limits={"perType": MAX_PER_TYPE},
    )