"""Helping two of your devices open a direct connection to each other.

The files never pass through this server. It only carries the few small messages
the devices need to find each other (WebRTC "signaling") and hands out the list of
network helper servers (STUN / TURN). Every offer and answer is signed by the
sending device's private key, so nobody who merely holds a stolen session cookie
can pose as one of your devices.
"""
import base64
import hashlib
import hmac
import time
import uuid

from flask import Blueprint, current_app, g, jsonify, request

from core.deviceauth import fingerprint, verify_device_proof
from core.extensions import limiter
from core.firebase_setup import get_db
from core.signaling import hub, registry
from routes.auth import login_required

bp = Blueprint("transfers", __name__, url_prefix="/api/transfers")

MAX_SDP_CHARS = 16000
MAX_CANDIDATE_CHARS = 2000
MAX_ICE_PER_TRANSFER = 300
CLOSE_REASONS = {"done", "declined", "cancelled", "error"}


def _sha256_hex(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _uuid_or_none(value):
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        return None


def _user_ref():
    return get_db().collection("users").document(g.uid)


def _active_device(user_ref, device_id):
    snapshot = user_ref.collection("devices").document(device_id).get()
    device = snapshot.to_dict() if snapshot.exists else None
    return device if device and device.get("status") == "active" else None


def _urls(text):
    return [part.strip() for part in text.split(",") if part.strip()]


@bp.get("/ice-servers")
@login_required
def ice_servers():
    """Helper servers the browsers use to find a path to each other."""
    cfg = current_app.config
    servers = []

    stun = _urls(cfg["STUN_URLS"])
    if stun:
        servers.append({"urls": stun})

    turn = _urls(cfg["TURN_URLS"])
    if turn and cfg["TURN_SECRET"]:
        # Short-lived credentials (the scheme coturn's "use-auth-secret" expects),
        # so a leaked username/password stops working within the hour.
        expires = int(time.time()) + cfg["TURN_TTL_SECONDS"]
        username = f"{expires}:{g.uid}"
        digest = hmac.new(cfg["TURN_SECRET"].encode(), username.encode(), hashlib.sha1).digest()
        servers.append({
            "urls": turn,
            "username": username,
            "credential": base64.b64encode(digest).decode(),
        })

    return jsonify(iceServers=servers)


@bp.post("/offer")
@limiter.limit("30 per minute")
@login_required
def offer():
    data = request.get_json(silent=True) or {}

    from_id = _uuid_or_none(data.get("deviceId"))
    to_id = _uuid_or_none(data.get("toDeviceId"))
    sdp = data.get("sdp")
    if not from_id or not to_id or from_id == to_id:
        return jsonify(error="Invalid request"), 400
    if not isinstance(sdp, str) or not 20 <= len(sdp) <= MAX_SDP_CHARS:
        return jsonify(error="Invalid request"), 400

    user_ref = _user_ref()
    offer_hash = _sha256_hex(sdp)

    # The sender must prove it is that device. The signature covers who is
    # sending to whom and a hash of the offer, so none of it can be swapped.
    sender = verify_device_proof(
        user_ref, g.uid, data, "offer", [from_id, to_id, offer_hash],
        device_types=("desktop", "phone"),
    )
    if sender is None:
        return jsonify(error="Device check failed"), 403

    if _active_device(user_ref, to_id) is None:
        return jsonify(error="Device not found"), 404

    if registry.active_count(g.uid) >= current_app.config["MAX_ACTIVE_TRANSFERS"]:
        return jsonify(error="Too many transfers at once"), 429

    transfer_id = registry.create(g.uid, from_id, to_id, offer_hash)
    hub.publish(g.uid, to_id, {
        "type": "offer",
        "transferId": transfer_id,
        "from": from_id,
        "fromName": sender["name"],
        "fromPublicKey": sender["public_key"],
        "fromFingerprint": fingerprint(sender["public_key"]),
        "sdp": sdp,
        "challenge": data["challenge"],
        "signature": data["signature"],
    })
    return jsonify(transferId=transfer_id), 201


@bp.post("/<transfer_id>/answer")
@limiter.limit("30 per minute")
@login_required
def answer(transfer_id):
    data = request.get_json(silent=True) or {}

    transfer_id = _uuid_or_none(transfer_id)
    device_id = _uuid_or_none(data.get("deviceId"))
    sdp = data.get("sdp")
    if not transfer_id or not device_id:
        return jsonify(error="Not found"), 404
    if not isinstance(sdp, str) or not 20 <= len(sdp) <= MAX_SDP_CHARS:
        return jsonify(error="Invalid request"), 400

    transfer = registry.get(g.uid, transfer_id)
    if transfer is None or transfer["status"] != "offered":
        return jsonify(error="Not found"), 404
    if device_id != transfer["to"]:
        return jsonify(error="Device check failed"), 403

    # The answer is signed over the transfer, the exact offer it replies to
    # and its own hash, so it cannot be attached to a different offer.
    responder = verify_device_proof(
        _user_ref(), g.uid, data, "answer", [transfer_id, transfer["offer_hash"], _sha256_hex(sdp)],
        device_types=("desktop", "phone"),
    )
    if responder is None:
        return jsonify(error="Device check failed"), 403

    if not registry.mark_answered(g.uid, transfer_id):
        return jsonify(error="Not found"), 404

    hub.publish(g.uid, transfer["from"], {
        "type": "answer",
        "transferId": transfer_id,
        "from": device_id,
        "fromPublicKey": responder["public_key"],
        "fromFingerprint": fingerprint(responder["public_key"]),
        "sdp": sdp,
        "challenge": data["challenge"],
        "signature": data["signature"],
    })
    return jsonify(status="ok")


@bp.post("/<transfer_id>/ice")
@limiter.limit("600 per minute")
@login_required
def ice(transfer_id):
    """Passes a network address from one device to the other."""
    data = request.get_json(silent=True) or {}

    transfer_id = _uuid_or_none(transfer_id)
    device_id = _uuid_or_none(data.get("deviceId"))
    transfer = registry.get(g.uid, transfer_id) if transfer_id else None
    if transfer is None:
        return jsonify(error="Not found"), 404
    if device_id not in (transfer["from"], transfer["to"]):
        return jsonify(error="Device check failed"), 403

    candidate = data.get("candidate")
    mid = data.get("sdpMid")
    index = data.get("sdpMLineIndex")
    if not isinstance(candidate, str) or len(candidate) > MAX_CANDIDATE_CHARS:
        return jsonify(error="Invalid request"), 400
    if mid is not None and (not isinstance(mid, str) or len(mid) > 64):
        return jsonify(error="Invalid request"), 400
    if index is not None and (not isinstance(index, int) or isinstance(index, bool) or not 0 <= index <= 16):
        return jsonify(error="Invalid request"), 400

    if not registry.note_ice(g.uid, transfer_id, MAX_ICE_PER_TRANSFER):
        return jsonify(error="Too many messages"), 429

    peer = transfer["to"] if device_id == transfer["from"] else transfer["from"]
    hub.publish(g.uid, peer, {
        "type": "ice",
        "transferId": transfer_id,
        "candidate": candidate,
        "sdpMid": mid,
        "sdpMLineIndex": index,
    })
    return jsonify(status="ok")


@bp.post("/<transfer_id>/close")
@limiter.limit("60 per minute")
@login_required
def close(transfer_id):
    data = request.get_json(silent=True) or {}

    transfer_id = _uuid_or_none(transfer_id)
    device_id = _uuid_or_none(data.get("deviceId"))
    transfer = registry.get(g.uid, transfer_id) if transfer_id else None
    if transfer is None:
        return jsonify(error="Not found"), 404
    if device_id not in (transfer["from"], transfer["to"]):
        return jsonify(error="Device check failed"), 403

    reason = data.get("reason")
    reason = reason if reason in CLOSE_REASONS else "done"

    peer = transfer["to"] if device_id == transfer["from"] else transfer["from"]
    registry.remove(g.uid, transfer_id)
    hub.publish(g.uid, peer, {"type": "closed", "transferId": transfer_id, "reason": reason})
    return jsonify(status="ok")


@bp.get("/events")
@limiter.limit("120 per minute")
@login_required
def events():
    """Long-poll: answers as soon as a message for this device arrives (or after a short wait)."""
    cfg = current_app.config
    device_id = _uuid_or_none(request.args.get("device"))
    after = request.args.get("after", default=0, type=int)
    wait = request.args.get("wait", default=cfg["SIGNAL_MAX_WAIT_SECONDS"], type=int)
    wait = max(0, min(wait, cfg["SIGNAL_MAX_WAIT_SECONDS"]))

    if not device_id or _active_device(_user_ref(), device_id) is None:
        return jsonify(error="Not found"), 404

    items = hub.wait(g.uid, device_id, after, wait)
    cursor = max((seq for seq, _ in items), default=after)
    return jsonify(events=[{"seq": seq, **event} for seq, event in items], cursor=cursor)