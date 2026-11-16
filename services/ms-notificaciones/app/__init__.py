"""Fábrica de la aplicación Flask de ms-notificaciones. Se separa de wsgi.py para poder probarla
sin abrir un puerto ni arrancar la revisión diaria."""
from flask import Flask

from . import contexto, db, logger, manejo_errores
from .clients import correo, inventario
from .config import Config
from .jobs import revision_diaria
from .migrar import migrar
from .routes import internas, notificaciones, sistema
from .services import configuracion


def crear_app(config=None):
    config = config or Config()
    logger.configurar(config.servicio, config.nivel_log)

    app = Flask(__name__)
    app.json.ensure_ascii = False
    app.json.sort_keys = False

    db.iniciar(config)
    inventario.iniciar(config)
    correo.iniciar(config)

    contexto.registrar(app)
    manejo_errores.registrar(app)
    app.register_blueprint(sistema.rutas)
    app.register_blueprint(notificaciones.rutas)
    app.register_blueprint(internas.rutas)

    # PUT /configuracion-alertas reprograma la revisión diaria (RF17).
    if revision_diaria.programador.reprogramar not in configuracion.al_cambiar:
        configuracion.al_cambiar.append(revision_diaria.programador.reprogramar)

    @app.cli.command("migrar")
    def _migrar():
        """Aplica las migraciones pendientes."""
        aplicadas = migrar()
        print("\n".join(f"Migración aplicada: {a}" for a in aplicadas) or "No hay migraciones pendientes.")

    @app.cli.command("revision-diaria")
    def _revision():
        """Ejecuta ahora la revisión de vencimientos y stock bajo."""
        print(revision_diaria.ejecutar())

    app.config["SERVICIO"] = config
    return app
