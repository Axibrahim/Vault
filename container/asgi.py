"""ASGI entry point, so Vault can also run under uvicorn (this works on Windows too).

Flask itself is a WSGI app. a2wsgi adapts it to ASGI. Vault's device signaling holds one
thread per waiting device, so the adapter gets a bigger thread pool than its default of 10.
Run it with a single process: the signaling mailboxes live in memory.
"""
from a2wsgi import WSGIMiddleware

from app import app

asgi_app = WSGIMiddleware(app, workers=32)