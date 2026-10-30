import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BASE_DIR / ".env")    # reads container/.env into os.environ (does nothing if the file is missing)


class BaseConfig:
    DEBUG = False
    SECRET_KEY = os.environ.get("SECRET_KEY", "")

    # Reject request bodies bigger than 16 MB before Flask reads them.
    # Files never travel through this server (they go straight between your
    # devices), so every API body is tiny and this limit can stay small.
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024

    # How many reverse proxies sit in front of Flask (0 = none)
    PROXY_HOPS = int(os.environ.get("PROXY_HOPS", "0"))

    # -- Auth session --
    AUTH_COOKIE_SAMESITE = "Strict"
    AUTH_SESSION_DURATION = timedelta(hours=8)     # normal sign-in (Firebase allows 5 minutes to 14 days)
    AUTH_REMEMBER_DURATION = timedelta(days=14)    # "Keep me signed in" (14 days is Firebase's maximum)
    LOGIN_MAX_AGE_SECONDS = 300                    # the Google sign-in must be this fresh to open a session
    SENSITIVE_MAX_AGE_SECONDS = 600                # pairing / removing devices needs a sign-in this recent

    # -- Pairing --
    PAIRING_CODE_TTL_SECONDS = 180                 # a pairing code works for 3 minutes

    # -- Transfers (device to device; this server only helps the two devices find each other) --
    SIGNAL_MAX_WAIT_SECONDS = 25                   # one long-poll request waits at most this long
    MAX_ACTIVE_TRANSFERS = 4                       # per account, at the same time
    STUN_URLS = os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302")
    TURN_URLS = os.environ.get("TURN_URLS", "")    # optional relay, e.g. turns:turn.example.com:5349
    TURN_SECRET = os.environ.get("TURN_SECRET", "")
    TURN_TTL_SECONDS = 3600

    # -- Firebase --
    FIREBASE_CREDENTIALS_FILE = os.environ.get("FIREBASE_CREDENTIALS_FILE", "serviceAccountKey.json")
    # On a hosting platform there is no key file: put the key (base64-encoded) in this variable instead
    FIREBASE_CREDENTIALS_BASE64 = os.environ.get("FIREBASE_CREDENTIALS_BASE64", "")
    # Public web-app settings (they identify the project, they are not secrets)
    FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY", "")
    FIREBASE_AUTH_DOMAIN = os.environ.get("FIREBASE_AUTH_DOMAIN", "")
    FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "")
    FIREBASE_APP_ID = os.environ.get("FIREBASE_APP_ID", "")

    # Rate-limit counters live in memory for now (ok for one process)
    RATELIMIT_STORAGE_URI = "memory://"


class DevelopmentConfig(BaseConfig):
    DEBUG = True
    AUTH_COOKIE_SECURE = False
    ENFORCE_HTTPS = False                    # allow plain http://localhost
    AUTH_COOKIE_NAME = "vault_auth"


class ProductionConfig(BaseConfig):
    AUTH_COOKIE_SECURE = True                # cookie sent over HTTPS only
    ENFORCE_HTTPS = True                     # redirect http:// to https://
    AUTH_COOKIE_NAME = "__Host-vault_auth"


REQUIRED = [
    "SECRET_KEY",
    "FIREBASE_API_KEY",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_APP_ID",
]


def get_config():
    # Anything other than the exact word "development" is treated as production.
    env = os.environ.get("VAULT_ENV", "production").lower()
    cfg = DevelopmentConfig() if env == "development" else ProductionConfig()

    missing = [name for name in REQUIRED if not getattr(cfg, name)]
    if missing:
        raise RuntimeError("Missing settings in container/.env: " + ", ".join(missing))

    if len(cfg.SECRET_KEY) < 32:
        raise RuntimeError("SECRET_KEY must be at least 32 characters long. Please set it in container/.env.")

    if bool(cfg.TURN_URLS) != bool(cfg.TURN_SECRET):
        raise RuntimeError("TURN_URLS and TURN_SECRET must be set together (or both left empty).")

    return cfg