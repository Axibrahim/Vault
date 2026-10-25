import os

import firebase_admin
from firebase_admin import credentials, firestore

def init_firebase(app):
    path = app.config["FIREBASE_CREDENTIALS_FILE"]
    if not os.path.isabs(path):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), path)

    if not os.path.isfile(path):
        raise RuntimeError(f"firebase service account file not found: {path}")

    firebase_admin.initialize_app(credentials.Certificate(path))

def get_db():
    return firestore.client()
