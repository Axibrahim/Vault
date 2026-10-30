import base64
import binascii
import json
import os

import firebase_admin
from firebase_admin import credentials, firestore


def _load_credentials(app):
    # 1) Hosting platform: the key arrives as a base64 environment variable.
    encoded = app.config["FIREBASE_CREDENTIALS_BASE64"]
    if encoded:
        try:
            info = json.loads(base64.b64decode(encoded))
        except (binascii.Error, ValueError) as e:
            raise RuntimeError("FIREBASE_CREDENTIALS_BASE64 is not valid base64-encoded JSON") from e
        return credentials.Certificate(info)

    # 2) Your computer: a key file next to app.py (it is git-ignored).
    path = app.config["FIREBASE_CREDENTIALS_FILE"]
    if not os.path.isabs(path):
        # relative paths are resolved from the container/ folder
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), path)

    if not os.path.isfile(path):
        raise RuntimeError(f"Firebase service account file not found: {path}")
    return credentials.Certificate(path)


def init_firebase(app):
    firebase_admin.initialize_app(_load_credentials(app))


def get_db():
    return firestore.client()