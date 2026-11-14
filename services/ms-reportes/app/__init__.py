"""Fábrica de la aplicación de ms-reportes.

`flask run` y `flask db ...` encuentran create_app por la variable FLASK_APP=app del .env.
"""

from flask import Flask

from app.config import cargar_configuracion
from app.errores import registrar_manejadores
from app.extensions import db, migrate
from app.registro import configurar_registro


def create_app(configuracion: dict | None = None) -> Flask:
    """Crea la aplicación. `configuracion` reemplaza valores del entorno; lo usan las pruebas (por ejemplo, SQLite)."""
    # Sin carpeta de archivos estáticos: es una API y no sirve /static.
    app = Flask(__name__, static_folder=None)
    app.config.update(cargar_configuracion())
    if configuracion:
        app.config.update(configuracion)

    # Las respuestas JSON conservan tildes y eñes, en lugar de escribirlas como secuencias de escape.
    app.json.ensure_ascii = False
    # Las claves salen en el orden en que se escriben (como en el contrato), no en orden alfabético.
    app.json.sort_keys = False

    configurar_registro(app)
    registrar_manejadores(app)

    db.init_app(app)
    migrate.init_app(app, db)

    # Registra los modelos en SQLAlchemy, para que las migraciones (flask db migrate) los encuentren.
    from app import models  # noqa: F401

    # Rutas del contrato. No llevan el prefijo /api: el Gateway lo quita antes de reenviar (Entrega 2, sección 4.1).
    from app.routes.importaciones import bp as importaciones
    from app.routes.operacion import bp as operacion

    app.register_blueprint(importaciones)
    # /health y /docs: propias del servicio.
    app.register_blueprint(operacion)

    return app
