
"""Proving that a request really comes from an enrolled device.

The browser signs a message with its private device key (WebCrypto, ECDSA P-256).
The server checks that signature with the public key stored at enrollment.

Challenges are single-use to prevent replay attacks.
"""

import base64
import hashlib
import hmac
import secrets
import threading
import time
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from flask import current_app


CHALLENGE_MAX_AGE = 60  # seconds a challenge stays valid

# In-process replay protection.
# Suitable for the current single-worker Gunicorn configuration.
# Use Redis with atomic operations before deploying multiple workers/instances.
_used_challenges = {}
_challenge_lock = threading.Lock()


def b64url_decode(value):
    """Decode base64url data, including values without padding."""
    if not isinstance(value, str):
        raise ValueError("Invalid base64url value")

    return base64.urlsafe_b64decode(
        value + "=" * (-len(value) % 4)
    )


# ---------- challenges: a fresh random value the device must sign ----------

def _mac(uid, payload):
    key = current_app.config["SECRET_KEY"].encode()

    return hmac.new(
        key,
        f"challenge|{uid}|{payload}".encode(),
        hashlib.sha256,
    ).hexdigest()


def make_challenge(uid):
    payload = f"{int(time.time())}.{secrets.token_urlsafe(16)}"
    return f"{payload}.{_mac(uid, payload)}"


def challenge_is_valid(uid, challenge):
    """Check challenge authenticity and age without consuming it."""
    if not isinstance(challenge, str) or len(challenge) > 200:
        return False

    try:
        payload, mac = challenge.rsplit(".", 1)
        issued = int(payload.split(".", 1)[0])
    except (ValueError, AttributeError):
        return False

    if not hmac.compare_digest(mac, _mac(uid, payload)):
        return False

    age = time.time() - issued

    return 0 <= age <= CHALLENGE_MAX_AGE


def consume_challenge(uid, challenge):
    """Atomically consume a valid challenge exactly once.

    Returns False if the challenge is invalid, expired, or already used.
    """
    if not challenge_is_valid(uid, challenge):
        return False

    now = time.time()

    digest = hashlib.sha256(
        f"{uid}|{challenge}".encode()
    ).hexdigest()

    with _challenge_lock:
        # Remove expired entries to prevent unbounded memory growth.
        expired = [
            key
            for key, expiry in _used_challenges.items()
            if expiry <= now
        ]

        for key in expired:
            _used_challenges.pop(key, None)

        if digest in _used_challenges:
            return False

        _used_challenges[digest] = now + CHALLENGE_MAX_AGE

        return True


# ---------- signatures ----------

def signature_is_valid(public_jwk, message, signature_b64url):
    """Verify WebCrypto's raw ECDSA P-256 signature (64-byte r||s)."""
    if not isinstance(signature_b64url, str) or len(signature_b64url) != 86:
        return False

    try:
        raw = b64url_decode(signature_b64url)

        if len(raw) != 64:
            return False

        r = int.from_bytes(raw[:32], "big")
        s = int.from_bytes(raw[32:], "big")

        numbers = ec.EllipticCurvePublicNumbers(
            int.from_bytes(b64url_decode(public_jwk["x"]), "big"),
            int.from_bytes(b64url_decode(public_jwk["y"]), "big"),
            ec.SECP256R1(),
        )

        numbers.public_key().verify(
            encode_dss_signature(r, s),
            message,
            ec.ECDSA(hashes.SHA256()),
        )

        return True

    except (
        InvalidSignature,
        ValueError,
        KeyError,
        TypeError,
    ):
        return False


def fingerprint(public_jwk):
    """A short code both screens can show so a human can compare them."""
    digest = hashlib.sha256(
        f"{public_jwk['x']}.{public_jwk['y']}".encode()
    ).hexdigest().upper()

    return "-".join(
        digest[i:i + 4]
        for i in (0, 4, 8)
    )


def verify_device_proof(
    user_ref,
    uid,
    data,
    action,
    parts,
    device_types=("desktop",),
):
    """Verify a signed request from an active enrolled device.

    Signed message format:
        vault-v1|<action>|<parts...>|<challenge>

    The challenge is consumed only after the signature is verified.

    Returns the stored device record on success, otherwise None.
    """
    if not isinstance(data, dict):
        return None

    try:
        device_id = str(uuid.UUID(str(data.get("deviceId"))))
    except (ValueError, TypeError, AttributeError):
        return None

    snapshot = (
        user_ref
        .collection("devices")
        .document(device_id)
        .get()
    )

    if not snapshot.exists:
        return None

    device = snapshot.to_dict()

    if not isinstance(device, dict):
        return None

    if (
        device.get("type") not in device_types
        or device.get("status") != "active"
    ):
        return None

    challenge = data.get("challenge")

    if not challenge_is_valid(uid, challenge):
        return None

    if not isinstance(action, str):
        return None

    if not isinstance(parts, (list, tuple)):
        return None

    if not all(isinstance(part, str) for part in parts):
        return None

    message = "|".join(
        ["vault-v1", action, *parts, challenge]
    ).encode()

    if not signature_is_valid(
        device.get("public_key", {}),
        message,
        data.get("signature"),
    ):
        return None

    # Consume after signature verification.
    # This prevents replaying an already accepted signed request.
    if not consume_challenge(uid, challenge):
        return None

    return device
