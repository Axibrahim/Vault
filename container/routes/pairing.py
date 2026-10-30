import hashlib
import hmac
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from firebase_admin import firestore
from flask import Blueprint, current_app, g, jsonify, request
from google.cloud.firestore_v1.base_query import FieldFilter

from core.deviceauth import fingerprint, verify_device_proof
from core.extensions import limiter
from core.firebase_setup import get_db
from routes.auth import fresh_login_required, login_required
from routes.devices import NAME_PATTERN, clean_public_jwk

bp = Blueprint("pairing", __name__, url_prefix="/api/pairing")

# No 0/O, 1/I/L or U, so a code is hard to misread.
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_PATTERN = re.compile(r"[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}")
LIVE_STATUSES = ["open", "claimed"]


class PairingError(Exception):
    pass


def _now():
    return datetime.now(timezone.utc)


def _new_code():
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))


def _normalize_code(value):
    if not isinstance(value, str):
        return None
    code = re.sub(r"[\s-]", "", value).upper()
    return code if CODE_PATTERN.fullmatch(code) else None


def _hash_code(code):
    key = current_app.config["SECRET_KEY"].encode()
    return hmac.new(key, f"pairing-code|{code}".encode(), hashlib.sha256).hexdigest()


def _user_ref():
    return get_db().collection("users").document(g.uid)


def _live_pairings(user_ref):
    query = user_ref.collection("pairings").where(filter=FieldFilter("status", "in", LIVE_STATUSES))
    return list(query.stream())


@firestore.transactional
def _claim_in_txn(transaction, user_ref, pairing_ref, phone):
    user = user_ref.get(transaction=transaction)
    if (user.to_dict() or {}).get("account_state") != "desktop_enrolled":
        raise PairingError()

    snapshot = pairing_ref.get(transaction=transaction)
    pairing = snapshot.to_dict() if snapshot.exists else None
    if not pairing or pairing.get("status") != "open" or pairing["expires_at"] <= _now():
        raise PairingError()

    transaction.update(pairing_ref, {
        "status": "claimed",
        "phone": phone,
        "claimed_at": firestore.SERVER_TIMESTAMP,
    })


@firestore.transactional
def _approve_in_txn(transaction, user_ref, pairing_ref, phone_ref, expected_fingerprint):
    user = user_ref.get(transaction=transaction)
    if (user.to_dict() or {}).get("account_state") != "desktop_enrolled":
        raise PairingError()

    snapshot = pairing_ref.get(transaction=transaction)
    pairing = snapshot.to_dict() if snapshot.exists else None
    if not pairing or pairing.get("status") != "claimed" or pairing["expires_at"] <= _now():
        raise PairingError()

    phone = pairing["phone"]
    if fingerprint(phone["public_key"]) != expected_fingerprint:
        raise PairingError()

    transaction.create(phone_ref, {
        "type": "phone",
        "name": phone["name"],
        "public_key": phone["public_key"],
        "status": "active",
        "created_at": firestore.SERVER_TIMESTAMP,
        "last_seen": firestore.SERVER_TIMESTAMP,
    })
    transaction.update(pairing_ref, {"status": "approved", "approved_at": firestore.SERVER_TIMESTAMP})
    transaction.update(user_ref, {"account_state": "phone_paired"})


@bp.post("/create")
@limiter.limit("10 per hour")
@fresh_login_required
def create_pairing():
    data = request.get_json(silent=True) or {}
    user_ref = _user_ref()

    state = (user_ref.get().to_dict() or {}).get("account_state")
    if state != "desktop_enrolled":
        return jsonify(error="Pairing is not available right now"), 409

    if not verify_device_proof(user_ref, g.uid, data, "pairing-create", []):
        return jsonify(error="Device check failed"), 403

    # Only one live code at a time.
    for doc in _live_pairings(user_ref):
        doc.reference.update({"status": "cancelled"})

    pairing_id = str(uuid.uuid4())
    code = _new_code()
    expires_at = _now() + timedelta(seconds=current_app.config["PAIRING_CODE_TTL_SECONDS"])

    user_ref.collection("pairings").document(pairing_id).set({
        "code_hash": _hash_code(code),     # the code itself is never stored
        "status": "open",
        "created_at": firestore.SERVER_TIMESTAMP,
        "expires_at": expires_at,
    })
    return jsonify(pairingId=pairing_id, code=code, expiresAt=expires_at.isoformat()), 201


@bp.post("/claim")
@limiter.limit("5 per minute; 30 per hour")
@login_required
def claim_pairing():
    data = request.get_json(silent=True) or {}

    code = _normalize_code(data.get("code"))
    name = data.get("name")
    name = name.strip() if isinstance(name, str) else ""
    public_key = clean_public_jwk(data.get("publicKey"))
    try:
        device_id = str(uuid.UUID(str(data.get("deviceId"))))
    except ValueError:
        device_id = None

    if code is None or not NAME_PATTERN.fullmatch(name) or public_key is None or device_id is None:
        return jsonify(error="Invalid or expired code"), 400

    user_ref = _user_ref()
    query = user_ref.collection("pairings").where(filter=FieldFilter("code_hash", "==", _hash_code(code))).limit(1)
    matches = list(query.stream())
    if not matches:
        return jsonify(error="Invalid or expired code"), 400

    pairing_ref = matches[0].reference
    phone = {"device_id": device_id, "name": name, "public_key": public_key}
    try:
        _claim_in_txn(get_db().transaction(), user_ref, pairing_ref, phone)
    except PairingError:
        return jsonify(error="Invalid or expired code"), 400

    return jsonify(status="ok", pairingId=pairing_ref.id, fingerprint=fingerprint(public_key))


@bp.get("/current")
@login_required
def current_pairing():
    live = []
    for doc in _live_pairings(_user_ref()):
        pairing = doc.to_dict()
        if pairing["expires_at"] > _now():
            live.append((pairing["expires_at"], doc.id, pairing))

    if not live:
        return jsonify(pairing=None)

    _, pairing_id, pairing = max(live, key=lambda item: item[0])
    result = {
        "pairingId": pairing_id,
        "status": pairing["status"],
        "expiresAt": pairing["expires_at"].isoformat(),
    }
    if pairing["status"] == "claimed":
        phone = pairing["phone"]
        result["phone"] = {"name": phone["name"], "fingerprint": fingerprint(phone["public_key"])}
    return jsonify(pairing=result)


@bp.post("/<pairing_id>/approve")
@limiter.limit("10 per hour")
@fresh_login_required
def approve_pairing(pairing_id):
    data = request.get_json(silent=True) or {}
    try:
        pairing_id = str(uuid.UUID(pairing_id))
    except ValueError:
        return jsonify(error="Not found"), 404

    user_ref = _user_ref()
    pairing_ref = user_ref.collection("pairings").document(pairing_id)
    snapshot = pairing_ref.get()
    pairing = snapshot.to_dict() if snapshot.exists else None
    if not pairing or pairing.get("status") != "claimed":
        return jsonify(error="Not found"), 404

    # The desktop signs the pairing id AND the phone's fingerprint,
    # so it can only approve the exact phone that is shown on its screen.
    phone = pairing["phone"]
    phone_fingerprint = fingerprint(phone["public_key"])
    if not verify_device_proof(user_ref, g.uid, data, "pairing-approve", [pairing_id, phone_fingerprint]):
        return jsonify(error="Device check failed"), 403

    phone_ref = user_ref.collection("devices").document(phone["device_id"])
    try:
        _approve_in_txn(get_db().transaction(), user_ref, pairing_ref, phone_ref, phone_fingerprint)
    except PairingError:
        return jsonify(error="Pairing is no longer valid"), 409

    return jsonify(status="ok")


@bp.post("/<pairing_id>/cancel")
@login_required
def cancel_pairing(pairing_id):
    try:
        pairing_id = str(uuid.UUID(pairing_id))
    except ValueError:
        return jsonify(error="Not found"), 404

    pairing_ref = _user_ref().collection("pairings").document(pairing_id)
    snapshot = pairing_ref.get()
    if snapshot.exists and (snapshot.to_dict() or {}).get("status") in LIVE_STATUSES:
        pairing_ref.update({"status": "cancelled"})
    return jsonify(status="ok")