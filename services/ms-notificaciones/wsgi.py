"""Punto de entrada: aplica las migraciones pendientes, arranca la revisión diaria y entrega la app
a Gunicorn (`gunicorn wsgi:app`). En desarrollo: `flask --app wsgi run --port 5000`."""
from app import crear_app, logger
from app.jobs import revision_diaria
from app.migrar import migrar

app = crear_app()
migrar()
if app.config["SERVICIO"].revision_diaria_activa:
    revision_diaria.programador.iniciar()
logger.info("servicio iniciado", puerto=app.config["SERVICIO"].puerto)
