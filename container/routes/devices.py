import base64
import re
import uuid

from cryptography.hazmat.primitives.asymmetric import ec
from firebase_admin import firestore
from flask import Blueprint, g, jsonify, request
from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore_v1.base_query import FieldFilter

from core.deviceauth import device_has_expired, make_challenge
from core.extensions import limiter
from core.firebase_setup import get_db
from core.signaling import board, end_device_transfers, registry
from routes.auth import fresh_login_required, login_required

bp = Blueprint("devices", __name__, url_prefix="/api/devices")

NAME_PATTERN = re.compile(r"[\w .\-]{1,40}")
B64URL_32_BYTES = re.compile(r"[A-Za-z0-9_-]{43}")   # 32 bytes in base64url, no padding

MAX_PER_TYPE = 3                                      # computers, and phones, per account
PRESENCE_STATES = {"ready", "busy", "blocked"}


class AlreadyEnrolled(Exception):
    pass


class DeviceNotFound(Exception):
    pass


def counts_of(user):
    """(computers, phones) the account has.

    Accounts made before the counters existed only have account_state, so it is worked out from that.
    """
    user = user or {}
    if "desktop_count" in user or "phone_count" in user:
        return user.get("desktop_count", 0), user.get("phone_count", 0)
    state = user.get("account_state", "no_devices")
    return (0 if state == "no_devices" else 1), (1 if state == "phone_paired" else 0)


def counter_update(desktops, phones):
    """The user-document fields that go with these counts."""
    desktops, phones = max(desktops, 0), max(phones, 0)
    state = "no_devices" if desktops == 0 else "phone_paired" if phones else "desktop_enrolled"
    return {"desktop_count": desktops, "phone_count": phones, "account_state": state}


def _uuid_or_none(value):
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        return None


def _b64url_to_int(value):
    raw = base64.urlsafe_b64decode(value + "=")
    return int.from_bytes(raw, "big")


def clean_public_jwk(jwk):
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
    user = snapshot.to_dict() if snapshot.exists else None
    desktops, phones = counts_of(user)
    if user is None or desktops >= MAX_PER_TYPE:
        raise AlreadyEnrolled()

    transaction.create(device_ref, device_data)
    transaction.update(user_ref, counter_update(desktops + 1, phones))


@firestore.transactional
def _revoke_in_txn(transaction, user_ref, device_ref):
    snapshot = device_ref.get(transaction=transaction)
    user = user_ref.get(transaction=transaction).to_dict()
    if not snapshot.exists:
        raise DeviceNotFound()

    device = snapshot.to_dict()
    if device.get("status") != "active":
        raise DeviceNotFound()

    transaction.update(device_ref, {
        "status": "revoked",
        "revoked_at": firestore.SERVER_TIMESTAMP,
    })

    kind = device.get("type")
    desktops, phones = counts_of(user)
    if kind == "desktop":
        desktops -= 1
    elif kind == "phone":
        phones -= 1
    if kind in ("desktop", "phone"):
        transaction.update(user_ref, counter_update(desktops, phones))

    return kind, max(desktops, 0)

def _drop_device(uid, device_id):
    """A removed device must vanish from the presence list and lose its running transfers at once."""
    board.forget(uid, device_id)
    end_device_transfers(uid, device_id)

def _revoke_active_phones(user_ref):
    """When the LAST computer is removed, the phones it vouched for are removed too."""
    phones = user_ref.collection("devices").where(filter=FieldFilter("type", "==", "phone")).stream()
    for doc in phones:
        if doc.to_dict().get("status") == "active":
            doc.reference.update({"status": "revoked", "revoked_at": firestore.SERVER_TIMESTAMP})
            _drop_device(user_ref.id, doc.id)
    user_ref.update({"phone_count": 0})


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


@bp.post("/challenge")
@limiter.limit("240 per minute")      # every signed message (even each network candidate) needs one
@login_required
def challenge():
    """A fresh value that a device signs to prove it holds its private key."""
    return jsonify(challenge=make_challenge(g.uid))


@bp.post("/presence")
@limiter.limit("300 per minute")
@login_required
def presence():
    """A device says "I am open, and I am ready / busy / blocked" and gets everyone's status back.

    Nothing is stored in the database. The first beat of a device is checked against it once.
    """
    data = request.get_json(silent=True) or {}
    device_id = _uuid_or_none(data.get("deviceId"))
    state = data.get("state")
    if not device_id or state not in PRESENCE_STATES:
        return jsonify(error="Invalid request"), 400

    if not board.known(g.uid, device_id):
        snapshot = get_db().collection("users").document(g.uid).collection("devices").document(device_id).get()
        device = snapshot.to_dict() if snapshot.exists else None
        if not device or device.get("status") != "active" or device_has_expired(device):
            return jsonify(error="Not found"), 404

    board.beat(g.uid, device_id, state)
    registry.touch_device(g.uid, device_id)        # an online device keeps its running transfers alive
    return jsonify(presence=board.snapshot(g.uid))


@bp.post("/enroll-desktop")
@limiter.limit("10 per hour")
@fresh_login_required
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

    public_key = clean_public_jwk(data.get("publicKey"))
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
        return jsonify(error="This account already has 3 computers"), 409
    except AlreadyExists:
        return jsonify(error="Invalid request"), 400

    return jsonify(status="ok", deviceId=device_id, name=name), 201


@bp.post("/<device_id>/revoke")
@limiter.limit("10 per hour")
@fresh_login_required
def revoke_device(device_id):
    try:
        device_id = str(uuid.UUID(device_id))
    except ValueError:
        return jsonify(error="Not found"), 404

    db = get_db()
    user_ref = db.collection("users").document(g.uid)
    device_ref = user_ref.collection("devices").document(device_id)

    try:
        kind, desktops_left = _revoke_in_txn(db.transaction(), user_ref, device_ref)
    except DeviceNotFound:
        return jsonify(error="Not found"), 404

    _drop_device(g.uid, device_id)
    if kind == "desktop" and desktops_left == 0:
        _revoke_active_phones(user_ref)

    return jsonify(status="ok")