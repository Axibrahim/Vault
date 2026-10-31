"""Small helpers shared by the tests: a fake device that signs like the browser does."""
import base64
import uuid
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

ORIGIN = "http://localhost"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Device:
    """A browser's non-exportable P-256 key, as WebCrypto would sign with it."""

    def __init__(self, kind="desktop", name="Home PC"):
        self.kind = kind
        self.name = name
        self.device_id = str(uuid.uuid4())
        self._key = ec.generate_private_key(ec.SECP256R1())
        numbers = self._key.public_key().public_numbers()
        self.jwk = {
            "kty": "EC",
            "crv": "P-256",
            "x": b64url(numbers.x.to_bytes(32, "big")),
            "y": b64url(numbers.y.to_bytes(32, "big")),
        }

    def sign(self, action, parts, challenge):
        message = "|".join(["vault-v1", action, *parts, challenge]).encode()
        der = self._key.sign(message, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        return b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))

    def record(self, status="active"):
        """The document the server stores for this device."""
        now = datetime.now(timezone.utc)
        return {
            "type": self.kind,
            "name": self.name,
            "public_key": dict(self.jwk),
            "status": status,
            "created_at": now,
            "last_seen": now,
        }


class Api:
    """Wraps the Flask test client and adds the headers our own JavaScript always sends."""

    def __init__(self, client):
        self.client = client

    def get(self, url, **kwargs):
        return self.client.get(url, **kwargs)

    def post(self, url, json=None, csrf=True, headers=None, **kwargs):
        merged = {"Origin": ORIGIN, "X-Vault-Request": "1"} if csrf else {}
        merged.update(headers or {})
        return self.client.post(url, json=json, headers=merged, **kwargs)

    def challenge(self):
        response = self.post("/api/devices/challenge")
        assert response.status_code == 200
        return response.get_json()["challenge"]

    def signed(self, device, action, parts=(), **extra):
        """A request body carrying a fresh challenge and this device's signature."""
        challenge = self.challenge()
        return {
            **extra,
            "deviceId": device.device_id,
            "challenge": challenge,
            "signature": device.sign(action, list(parts), challenge),
        }