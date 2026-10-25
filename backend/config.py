import os
from datetime import timedelta
from dotenv import load_dotenv

load_dotenv()    # reads backend/.env file as os.environ (Does nothing if the file is missing)

class BaseConfig:
    DEBUG = False
    SECRET_KEY = os.environ.get('SECRET_KEY', '')

    # Reject requests with a body Larger than 16MB before Flask can reads them
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024

    # How many reverse proxies sit in front of flask (0 = none)
    PROXY_HOPS = int(os.environ.get("PROXY_HOPS", "0"))

    # -- Auth session --
    AUTH_COOKIE_SAMESITE = "Strict"
    AUTH_SESSION_DURATION = timedelta(hours=8)   # Firebase allows 5 minutes to 14 days
    LOGIN_MAX_AGE_SECONDS = 300                 # The Google sign-in must be this fresh

    # -- Firebase --
    FIREBASE_CREDENTIALS_FILE = os.environ.get("FIREBASE_CREDENTIALS_FILE", "serviceAccountKey.json")
    # Public web-app settings (They identify the project not secrets)
    FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY", "")
    FIREBASE_AUTH_DOMAIN = os.environ.get("FIREBASE_AUTH_DOMAIN", "")
    FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "")
    FIREBASE_APP_ID = os.environ.get("FIREBASE_APP_ID", "")

    # Rate-limit counters live in memory for now (ok for one process per session)
    RATELIMIT_STORAGE_URI = "memory://"



class DevelopmentConfig(BaseConfig):
    DEBUG = True
    AUTH_COOKIE_SECURE = False
    ENFORCE_HTTPS = False                    # alloe plain http://localhost
    AUTH_COOKIE_NAME = 'vault_auth'


class ProductionConfig(BaseConfig):
    AUTH_COOKIE_SECURE = True             # cookie sent over HTTPS only
    ENFORCE_HTTPS = True                     # redirect http:// to https://
    AUTH_COOKIE_NAME = '__Host-vault_auth'


REQUIRED = [
    "SECRET_KEY",
    "FIREBASE_API_KEY",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_APP_ID",
]


def get_config():
    # Anything other than the exact word 'development' is considered production
    env = os.environ.get('VAULT_ENV', 'production').lower()
    cfg = DevelopmentConfig() if env == 'development' else ProductionConfig()

    missing = [name for name in REQUIRED if not getattr(cfg, name)]
    if missing:
        raise RuntimeError("Missing setting in backend/.env: " + ", ".join(missing))

    if len(cfg.SECRET_KEY) < 32:
        raise RuntimeError("SECRET_KEY must be at least 32 characters long." \
        " Please set it in the .env file.")
    return cfg
