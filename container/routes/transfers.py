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
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests
from firebase_admin import firestore
from flask import Blueprint, current_app, g, jsonify, request
from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore_v1.base_query import FieldFilter

from core.deviceauth import device_has_expired, fingerprint, verify_device_proof
from core.extensions import limiter
from core.firebase_setup import get_db
from core.signaling import ANSWERED, CANCELLED, COMPLETED, DECLINED, FAILED, hub, registry
from routes.auth import login_required

bp = Blueprint("transfers", __name__, url_prefix="/api/transfers")

MAX_SDP_CHARS = 16000
MAX_CANDIDATE_CHARS = 2000
MAX_ICE_PER_TRANSFER = 300
CLOUDFLARE_TURN_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
CLOUDFLARE_TIMEOUT_SECONDS = 4
OFFER_KINDS = {"files", "clip"}       # "clip" is the live shared text box; everything else is a file transfer
# what a device says when it closes a transfer -> the state the transfer moves to
CLOSE_STATES = {"done": COMPLETED, "declined": DECLINED, "cancelled": CANCELLED, "error": FAILED}
CLOSE_REASONS = set(CLOSE_STATES)
HISTORY_DAYS = 30
HISTORY_LIMIT = 50
MAX_RECORD_FILES = 100_000
MAX_RECORD_BYTES = 10 * 1024**4      # 10 TB, far above anything real


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
    if not device or device.get("status") != "active" or device_has_expired(device):
        return None
    return device


def _urls(text):
    return [part.strip() for part in text.split(",") if part.strip()]


def _cloudflare_servers(cfg):
    """Short-lived relay credentials from Cloudflare.

    Returns [] when the call fails, so devices on the same network can still connect directly.
    The relay only ever carries data that is already end-to-end encrypted (DTLS).
    """
    try:
        reply = requests.post(
            CLOUDFLARE_TURN_URL.format(key_id=quote(cfg["CLOUDFLARE_TURN_KEY_ID"], safe="")),
            headers={"Authorization": f"Bearer {cfg['CLOUDFLARE_TURN_API_TOKEN']}"},
            json={"ttl": cfg["TURN_TTL_SECONDS"]},
            timeout=CLOUDFLARE_TIMEOUT_SECONDS,
        )
        reply.raise_for_status()
        servers = reply.json()["iceServers"]
        if isinstance(servers, dict):
            servers = [servers]
        for server in servers:
            if not isinstance(server["urls"], list):
                raise ValueError("unexpected address list")
    except (requests.RequestException, ValueError, KeyError, TypeError) as err:
        current_app.logger.warning("Cloudflare TURN unavailable: %s", type(err).__name__)
        return []

    # Browsers block port 53, so those addresses would only add a timeout.
    return [
        {**server, "urls": [url for url in server["urls"] if not re.search(r":53(\?|$)", url)]}
        for server in servers
    ]


@bp.get("/ice-servers")
@limiter.limit("30 per minute")
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

    if cfg["CLOUDFLARE_TURN_KEY_ID"]:
        servers.extend(_cloudflare_servers(cfg))

    return jsonify(iceServers=servers)


@bp.post("/offer")
@limiter.limit("30 per minute")
@login_required
def offer():
    data = request.get_json(silent=True) or {}

    from_id = _uuid_or_none(data.get("deviceId"))
    to_id = _uuid_or_none(data.get("toDeviceId"))
    sdp = data.get("sdp")
    kind = data.get("kind", "files")
    if not from_id or not to_id or from_id == to_id:
        return jsonify(error="Invalid request"), 400
    if not isinstance(sdp, str) or not 20 <= len(sdp) <= MAX_SDP_CHARS:
        return jsonify(error="Invalid request"), 400
    if not isinstance(kind, str) or kind not in OFFER_KINDS:
        return jsonify(error="Invalid request"), 400

    user_ref = _user_ref()
    offer_hash = _sha256_hex(sdp)

    # The sender must prove it is that device. The signature covers who is
    # sending to whom and a hash of the offer, so none of it can be swapped.
    # A non-default kind is signed too, so it cannot be changed on the way.
    signed = [from_id, to_id, offer_hash] + ([] if kind == "files" else [kind])
    sender = verify_device_proof(
        user_ref, g.uid, data, "offer", signed,
        device_types=("desktop", "phone"),
    )
    if sender is None:
        return jsonify(error="Device check failed"), 403

    if _active_device(user_ref, to_id) is None:
        return jsonify(error="Device not found"), 404

    transfer_id, superseded = registry.create(
        g.uid, from_id, to_id, offer_hash, kind=kind, limit=current_app.config["MAX_ACTIVE_TRANSFERS"],
    )
    # A fresh signed offer replaces the older transfer between these two devices: the receiver is told,
    # so the old connection can never be carried on with its old authorisation.
    for old_id in superseded:
        hub.publish(g.uid, to_id, {"type": "closed", "transferId": old_id, "reason": "error"})
    if transfer_id is None:
        return jsonify(error="Too many transfers at once"), 429

    hub.publish(g.uid, to_id, {
        "type": "offer",
        "transferId": transfer_id,
        "kind": kind,
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
    """Passes a signed network candidate from one enrolled device to the other."""
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

    if index is not None and (
        not isinstance(index, int)
        or isinstance(index, bool)
        or not 0 <= index <= 16
    ):
        return jsonify(error="Invalid request"), 400

    # Sign in the candidate and its metadata, not just the transfer ID.
    candidate_hash = _sha256_hex(candidate)
    signed_mid = mid or ""
    signed_index = str(index) if index is not None else ""

    proof = verify_device_proof(
        _user_ref(),
        g.uid,
        data,
        "ice",
        [transfer_id, candidate_hash, signed_mid, signed_index],
        device_types=("desktop", "phone"),
    )

    if proof is None:
        return jsonify(error="Device check failed"), 403

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

    transfer = registry.lookup(g.uid, transfer_id) if transfer_id else None
    if transfer is None:
        return jsonify(error="Not found"), 404

    if device_id not in (transfer["from"], transfer["to"]):
        return jsonify(error="Device check failed"), 403

    reason = data.get("reason", "done")
    if reason not in CLOSE_REASONS:
        return jsonify(error="Invalid close reason"), 400

    # The signature binds the device to this exact transfer and close reason.
    proof = verify_device_proof(
        _user_ref(),
        g.uid,
        data,
        "close",
        [transfer_id, reason],
        device_types=("desktop", "phone"),
    )

    if proof is None:
        return jsonify(error="Device check failed"), 403

    # Only the device that sent the files can say the transfer is complete.
    if CLOSE_STATES[reason] == COMPLETED and device_id != transfer["from"]:
        return jsonify(error="Device check failed"), 403

    outcome = registry.advance(g.uid, transfer_id, CLOSE_STATES[reason])
    if outcome == "unknown":
        return jsonify(error="Not found"), 404
    if outcome == "illegal":
        return jsonify(error="Transfer is not in a state that allows this"), 409

    if outcome == "moved":
        peer = transfer["to"] if device_id == transfer["from"] else transfer["from"]
        hub.publish(g.uid, peer, {
            "type": "closed",
            "transferId": transfer_id,
            "reason": reason,
        })

    return jsonify(status="ok")                # closing a transfer that already ended is harmless


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


def _whole_number(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


@bp.post("/record")
@limiter.limit("120 per hour")
@login_required
def record():
    """The sending device notes one finished transfer. Only counts and sizes are kept, never file names."""
    data = request.get_json(silent=True) or {}

    from_id = _uuid_or_none(data.get("deviceId"))
    to_id = _uuid_or_none(data.get("toDeviceId"))
    transfer_id = _uuid_or_none(data.get("transferId"))
    files, size = data.get("files"), data.get("bytes")
    if not from_id or not to_id or not transfer_id or from_id == to_id:
        return jsonify(error="Invalid request"), 400
    if not _whole_number(files, 1, MAX_RECORD_FILES) or not _whole_number(size, 0, MAX_RECORD_BYTES):
        return jsonify(error="Invalid request"), 400

    user_ref = _user_ref()
    sender = verify_device_proof(
        user_ref, g.uid, data, "record", [transfer_id, to_id, str(files), str(size)],
        device_types=("desktop", "phone"),
    )
    if sender is None:
        return jsonify(error="Device check failed"), 403

    # Only a real, running transfer between these two devices can be written to the history.
    transfer = registry.get(g.uid, transfer_id)
    if (
        transfer is None
        or transfer["status"] != ANSWERED
        or transfer["kind"] != "files"
        or (transfer["from"], transfer["to"]) != (from_id, to_id)
    ):
        return jsonify(error="Not found"), 404

    receiver = _active_device(user_ref, to_id)
    if receiver is None:
        return jsonify(error="Device not found"), 404

    expires_at = datetime.now(timezone.utc) + timedelta(days=HISTORY_DAYS)
    try:
        user_ref.collection("history").document(transfer_id).create({
            "from_id": from_id,
            "from_name": sender["name"],
            "to_id": to_id,
            "to_name": receiver["name"],
            "files": files,
            "bytes": size,
            "created_at": firestore.SERVER_TIMESTAMP,
            "expires_at": expires_at,          # Firestore's TTL policy deletes the entry after this time
        })
    except AlreadyExists:
        pass                                   # the same transfer reported twice: keep the first
    return jsonify(status="ok")


@bp.get("/history")
@login_required
def history():
    """The account's transfers from the last 30 days, newest first."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)
    query = (
        _user_ref().collection("history")
        .where(filter=FieldFilter("created_at", ">=", cutoff))
        .order_by("created_at", direction="DESCENDING")
        .limit(HISTORY_LIMIT)
    )
    items = []
    for doc in query.stream():
        d = doc.to_dict()
        items.append({
            "id": doc.id,
            "fromId": d.get("from_id"),
            "fromName": d.get("from_name"),
            "toId": d.get("to_id"),
            "toName": d.get("to_name"),
            "files": d.get("files", 0),
            "bytes": d.get("bytes", 0),
            "at": d["created_at"].isoformat(),
        })
    return jsonify(history=items)