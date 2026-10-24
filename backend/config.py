import os
from datetime import timedelta
from dotenv import load_dotenv

load_dotenv()    # reads backend/.env file as os.environ (Does nothing if the file is missing)

class BaseConfig:
    DEBUG = False
    SECRET_KEY = os.environ.get('secret_key', '')

    # Session cookies hardening
    SESSION_COOKIE_HTTPONLY = True          # JavaScript cannot read the cookie
    SESSION_COOKIE_SAMESITE = "Lax"         # not sent on cross-site POSTs (csrf defence)
    PERMANENT_SESSION_LIFETIME = timedelta(minutes=30)

    # Reject requests with a body Larger than 16MB before Flask can reads them
    MAX_CONTENT_LENGTH = 14 * 1024 * 1024

    # How many reverse proxies sit in front of Flask (0 = none)
    PROXY_HOPS = int(os.environ.get('PROXY_HOPS', '0'))


class DevelopmentConfig(BaseConfig):
    DEBUG = True
    SESSION_COOKIE_SECURE = False            # cookie sent over HTTP and HTTPS
    ENFORCE_HTTPS = False                    # url_for() generates http:// urls
    SESSION_COOKIE_NAME = 'vault_session'


class ProductionConfig(BaseConfig):
    SESSION_COOKIE_SECURE = True             # cookie sent over HTTPS only
    ENFORCE_HTTPS = True                     # url_for() generates https:// urls
    SESSION_COOKIE_NAME = '__Host-vault_session'


def get_config():
    # Anything other than the exact word 'development' is considered production
    env = os.environ.get('VAULT_ENV', 'production').lower()
    cfg = DevelopmentConfig() if env == 'development' else ProductionConfig()

    if len(cfg.SECRET_KEY) < 32:
        raise RuntimeError("SECRET_KEY must be at least 32 characters long." \
        " Please set it in the .env file.")
    return cfg
