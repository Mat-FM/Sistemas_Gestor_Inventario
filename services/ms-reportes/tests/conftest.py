"""Preparación común de las pruebas.

- La aplicación usa SQLite en memoria: no hace falta PostgreSQL.
- Los demás servicios se simulan reemplazando requests.request: ninguna prueba sale a la red.
- Las esperas de los reintentos no esperan de verdad, y el reloj del cortacircuitos se puede adelantar.
"""

import pytest
import requests

from app import create_app
from app.clients import base
from app.extensions import db
from tests.simulacion import Reloj, ServiciosFalsos


@pytest.fixture
def app():
    aplicacion = create_app({"SQLALCHEMY_DATABASE_URI": "sqlite://", "TESTING": True})
    with aplicacion.app_context():
        db.create_all()
        yield aplicacion
        db.session.remove()
        db.drop_all()
        # Cierra las conexiones de SQLite, para no dejarlas abiertas entre pruebas.
        db.engine.dispose()


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def servicios(monkeypatch):
    falsos = ServiciosFalsos()
    monkeypatch.setattr(requests, "request", falsos)
    return falsos


@pytest.fixture(autouse=True)
def sin_esperas(monkeypatch):
    """Los reintentos no esperan de verdad; las esperas pedidas quedan en la lista."""
    esperas = []
    monkeypatch.setattr(base.time, "sleep", esperas.append)
    return esperas


@pytest.fixture(autouse=True)
def reloj(monkeypatch):
    """Cada prueba empieza con los cortacircuitos cerrados y un reloj propio."""
    base.reiniciar_cortacircuitos()
    falso = Reloj()
    monkeypatch.setattr(base.time, "monotonic", falso)
    yield falso
    base.reiniciar_cortacircuitos()
