# Vault

A web app for sending photos and videos between your phone and your PC.
Work in progress: sign-in with Google and computer setup are done; the phone-to-PC transfer is next.

## Project structure

```
backend/
├── app.py                  creates the Flask app
├── core/                   shared plumbing
│   ├── config.py           settings, read from backend/.env
│   ├── extensions.py       rate limiter
│   ├── firebase_setup.py   Firebase / Firestore connection
│   └── security.py         CSP, HTTPS, CSRF and security headers
├── routes/                 API endpoints
│   ├── auth.py             /api/auth/*
│   └── devices.py          /api/devices/*
├── templates/index.html    the single page
└── static/
    ├── css/                tokens, base, components, views, responsive
    ├── fonts/              self-hosted fonts
    ├── vendor/             Three.js (self-hosted, the CSP blocks CDNs)
    └── js/
        ├── main.js         entry point: picks which screen to show
        ├── state.js        shared state
        ├── core/           api, auth, storage
        ├── device/         device key and receiving folder
        ├── ui/             DOM helpers
        ├── views/          login, enroll, desktop, other
        └── scene/          3D vault door
```

## Run locally

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env          # then fill in the values
python app.py                   # http://127.0.0.1:5000
```

Put your Firebase service account key at `backend/serviceAccountKey.json` (it is git-ignored).
Production start command: `gunicorn app:app` (run from `backend/`).