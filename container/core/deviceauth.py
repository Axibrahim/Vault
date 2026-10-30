"""Proving that a request really comes from an enrolled device.

The browser signs a message with its private device key (WebCrypto, ECDSA P-256).
The server checks that signature with the public key stored at enrollment.
"""
import base64
import hashlib
import hmac
import secrets
import time
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from flask import current_app

CHALLENGE_MAX_AGE = 60   # seconds a challenge stays valid


def b64url_decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


# ---------- challenges: a fresh random value the device must sign ----------

def _mac(uid, payload):
    key = current_app.config["SECRET_KEY"].encode()
    return hmac.new(key, f"challenge|{uid}|{payload}".encode(), hashlib.sha256).hexdigest()


def make_challenge(uid):
    payload = f"{int(time.time())}.{secrets.token_urlsafe(16)}"
    return f"{payload}.{_mac(uid, payload)}"


def challenge_is_valid(uid, challenge):
    if not isinstance(challenge, str) or len(challenge) > 200:
        return False
    try:
        payload, mac = challenge.rsplit(".", 1)
        issued = int(payload.split(".", 1)[0])
    except ValueError:
        return False

    if not hmac.compare_digest(mac, _mac(uid, payload)):
        return False
    return 0 <= time.time() - issued <= CHALLENGE_MAX_AGE


# ---------- signatures ----------

def signature_is_valid(public_jwk, message, signature_b64url):
    """message is bytes. The browser's signature is raw r||s (64 bytes)."""
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
        numbers.public_key().verify(encode_dss_signature(r, s), message, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, KeyError, TypeError):
        return False


def fingerprint(public_jwk):
    """A short code both screens can show so a human can compare them."""
    digest = hashlib.sha256(f"{public_jwk['x']}.{public_jwk['y']}".encode()).hexdigest().upper()
    return "-".join(digest[i:i + 4] for i in (0, 4, 8))


def verify_device_proof(user_ref, uid, data, action, parts, device_types=("desktop",)):
    """Check that the request carries a valid signature from an active device.

    The signed text is  vault-v1|<action>|<parts...>|<challenge>.
    Returns the device's stored record when everything checks out, otherwise None.
    """
    try:
        device_id = str(uuid.UUID(str(data.get("deviceId"))))
    except ValueError:
        return None

    snapshot = user_ref.collection("devices").document(device_id).get()
    if not snapshot.exists:
        return None

    device = snapshot.to_dict()
    if device.get("type") not in device_types or device.get("status") != "active":
        return None

    challenge = data.get("challenge")
    if not challenge_is_valid(uid, challenge):
        return None

    message = "|".join(["vault-v1", action, *parts, challenge]).encode()
    if not signature_is_valid(device["public_key"], message, data.get("signature")):
        return None
    return device