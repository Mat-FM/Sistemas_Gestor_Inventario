"""Fábrica de la aplicación de ms-reportes.

`flask run` y `flask db ...` encuentran create_app por la variable FLASK_APP=app del .env.
"""

from flask import Flask

from app.config import cargar_configuracion
from app.extensions import db, migrate


def create_app(configuracion: dict | None = None) -> Flask:
    """Crea la aplicación. `configuracion` reemplaza valores del entorno; lo usan las pruebas (por ejemplo, SQLite)."""
    # Sin carpeta de archivos estáticos: es una API y no sirve /static.
    app = Flask(__name__, static_folder=None)
    app.config.update(cargar_configuracion())
    if configuracion:
        app.config.update(configuracion)

    # Las respuestas JSON conservan tildes y eñes en lugar de escribirlas como á.
    app.json.ensure_ascii = False

    db.init_app(app)
    migrate.init_app(app, db)

    # Registra los modelos en SQLAlchemy, para que las migraciones (flask db migrate) los encuentren.
    from app import models  # noqa: F401

    return app
