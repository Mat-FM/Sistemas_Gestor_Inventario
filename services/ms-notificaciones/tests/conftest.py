"""Fixtures compartidas. Las pruebas usan una base de datos aparte (notificaciones_test) que se
vacía al empezar, y un ms-inventario falso que corre en un hilo."""
import os

import pytest

os.environ.setdefault("DB_HOST", "127.0.0.1")
os.environ.setdefault("DB_PORT", "5435")
os.environ["DB_NAME"] = os.environ.get("DB_TEST_NAME", "notificaciones_test")
os.environ.setdefault("DB_USER", "notificaciones")
os.environ.setdefault("DB_PASSWORD", "change_me")
os.environ["CALL_TIMEOUT_SECONDS"] = "0.5"
os.environ["REVISION_DIARIA_ACTIVA"] = "false"
os.environ["LOG_LEVEL"] = "CRITICAL"
for variable in ("SMTP_HOST", "MAIL_FROM"):
    os.environ[variable] = ""

from tests import inventario_falso  # noqa: E402

ADMIN = {"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"}
VENDEDOR = {"X-User-Id": "5", "X-User-Rol": "VENDEDOR"}
OPERADOR = {"X-User-Id": "7", "X-User-Rol": "OPERADOR_BODEGA", "X-User-Bodega": "1"}


@pytest.fixture(scope="session")
def inventario():
    estado = inventario_falso.Estado()
    servidor = inventario_falso.crear(estado)
    os.environ["MS_INVENTARIO_URL"] = f"http://127.0.0.1:{servidor.server_address[1]}"
    yield estado
    servidor.shutdown()


@pytest.fixture(scope="session")
def app(inventario):
    from app import crear_app, db
    from app.migrar import migrar

    aplicacion = crear_app()
    with db.conexion() as con:
        con.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    migrar()
    yield aplicacion
    db.cerrar()


@pytest.fixture(autouse=True)
def base_limpia(app, inventario):
    """Cada prueba empieza con las tablas vacías, la configuración inicial y el cortacircuito cerrado."""
    from app import db
    from app.clients import inventario as cliente_inventario

    with db.conexion() as con:
        con.execute("TRUNCATE notificacion, preferencia RESTART IDENTITY")
        con.execute(
            "UPDATE configuracion SET dias_anticipacion_vencimiento = 30, hora_revision_diaria = '06:00'"
        )
    inventario.reiniciar()
    cliente_inventario.cliente.cortacircuito.exito()
    yield


@pytest.fixture
def cliente(app):
    return app.test_client()


@pytest.fixture
def aviso(cliente):
    """Envía un aviso por la ruta interna, como lo hacen ms-inventario y ms-compras."""

    def enviar(**datos):
        cuerpo = {"tipo": "STOCK_BAJO", "mensaje": "Producto bajo el mínimo.", **datos}
        return cliente.post("/internas/notificaciones", json=cuerpo)

    return enviar
