from flask import Flask, jsonify, render_template
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

import auth
from config import get_config
from extensions import limiter
from firebase_setup import init_firebase
from security import register_security


def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())

    hops = app.config["PROXY_HOPS"]
    if hops:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=hops, x_host=hops)

    register_security(app)
    init_firebase(app)
    limiter.init_app(app)
    app.register_blueprint(auth.bp)


    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/health")
    def health():
        return jsonify(status="ok")

    @app.errorhandler(HTTPException)
    def handle_http_error(e):
        return jsonify(error=e.name), e.code

    @app.errorhandler(Exception)
    def handle_unexpected_error(e):
        app.logger.exception("Unhandled error")
        return jsonify(error="Internal Server Error"), 500

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)


