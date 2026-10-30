import base64
import re
import uuid

from cryptography.hazmat.primitives.asymmetric import ec
from firebase_admin import firestore
from flask import Blueprint, g, jsonify, request
from google.api_core.exceptions import AlreadyExists

from core.extensions import limiter
from core.firebase_setup import get_db
from routes.auth import login_required

bp = Blueprint("devices", __name__, url_prefix="/api/devices")

NAME_PATTERN = re.compile(r"[\w .\-]{1,40}")
B64URL_32_BYTES = re.compile(r"[A-Za-z0-9_-]{43}")   # 32 bytes in base64url, no padding


class AlreadyEnrolled(Exception):
    pass


class DeviceNotFound(Exception):
    pass


def _b64url_to_int(value):
    raw = base64.urlsafe_b64decode(value + "=")
    return int.from_bytes(raw, "big")


def _clean_public_jwk(jwk):
    """Return a minimal, verified P-256 public key, or None if anything is off."""
    if not isinstance(jwk, dict):
        return None
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        return None

    x, y = jwk.get("x"), jwk.get("y")
    if not (isinstance(x, str) and isinstance(y, str)):
        return None
    if not (B64URL_32_BYTES.fullmatch(x) and B64URL_32_BYTES.fullmatch(y)):
        return None

    try:
        numbers = ec.EllipticCurvePublicNumbers(_b64url_to_int(x), _b64url_to_int(y), ec.SECP256R1())
        numbers.public_key()   # raises ValueError if the point is not on the curve
    except ValueError:
        return None

    return {"kty": "EC", "crv": "P-256", "x": x, "y": y}


def _iso(value):
    return value.isoformat() if value else None


@firestore.transactional
def _enroll_in_txn(transaction, user_ref, device_ref, device_data):
    snapshot = user_ref.get(transaction=transaction)
    state = (snapshot.to_dict() or {}).get("account_state") if snapshot.exists else None
    if state != "no_devices":
        raise AlreadyEnrolled()

    transaction.create(device_ref, device_data)
    transaction.update(user_ref, {"account_state": "desktop_enrolled"})


@firestore.transactional
def _revoke_in_txn(transaction, user_ref, device_ref):
    snapshot = device_ref.get(transaction=transaction)
    if not snapshot.exists:
        raise DeviceNotFound()

    device = snapshot.to_dict()
    if device.get("status") != "active":
        raise DeviceNotFound()

    transaction.update(device_ref, {
        "status": "revoked",
        "revoked_at": firestore.SERVER_TIMESTAMP,
    })
    if device.get("type") == "desktop":
        transaction.update(user_ref, {"account_state": "no_devices"})


@bp.get("")
@login_required
def list_devices():
    user_ref = get_db().collection("users").document(g.uid)
    state = (user_ref.get().to_dict() or {}).get("account_state", "no_devices")

    devices = []
    for doc in user_ref.collection("devices").stream():
        d = doc.to_dict()
        devices.append({
            "id": doc.id,
            "type": d.get("type"),
            "name": d.get("name"),
            "status": d.get("status"),
            "createdAt": _iso(d.get("created_at")),
            "lastSeen": _iso(d.get("last_seen")),
        })
    return jsonify(accountState=state, devices=devices)


@bp.post("/enroll-desktop")
@limiter.limit("10 per hour")
@login_required
def enroll_desktop():
    data = request.get_json(silent=True) or {}

    name = data.get("name")
    name = name.strip() if isinstance(name, str) else ""
    if not NAME_PATTERN.fullmatch(name):
        return jsonify(error="Invalid computer name"), 400

    try:
        device_id = str(uuid.UUID(str(data.get("deviceId"))))
    except ValueError:
        return jsonify(error="Invalid request"), 400

    public_key = _clean_public_jwk(data.get("publicKey"))
    if public_key is None:
        return jsonify(error="Invalid public key"), 400

    db = get_db()
    user_ref = db.collection("users").document(g.uid)
    device_ref = user_ref.collection("devices").document(device_id)
    device_data = {
        "type": "desktop",
        "name": name,
        "public_key": public_key,
        "status": "active",
        "created_at": firestore.SERVER_TIMESTAMP,
        "last_seen": firestore.SERVER_TIMESTAMP,
    }

    try:
        _enroll_in_txn(db.transaction(), user_ref, device_ref, device_data)
    except AlreadyEnrolled:
        return jsonify(error="This account already has a computer set up"), 409
    except AlreadyExists:
        return jsonify(error="Invalid request"), 400

    return jsonify(status="ok", deviceId=device_id, name=name), 201


@bp.post("/<device_id>/revoke")
@limiter.limit("10 per hour")
@login_required
def revoke_device(device_id):
    try:
        device_id = str(uuid.UUID(device_id))
    except ValueError:
        return jsonify(error="Not found"), 404

    db = get_db()
    user_ref = db.collection("users").document(g.uid)
    device_ref = user_ref.collection("devices").document(device_id)

    try:
        _revoke_in_txn(db.transaction(), user_ref, device_ref)
    except DeviceNotFound:
        return jsonify(error="Not found"), 404

    return jsonify(status="ok")