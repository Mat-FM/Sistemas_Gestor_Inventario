"""Con la base de datos de ms-reportes inalcanzable las rutas que la usan (importaciones) responden 503 y no 500 (RNF18).
Los reportes y el panel no usan la base: siguen funcionando."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy import exc as sa_exc

from app.repositories import importacion_repository


def error_real_de_conexion() -> sa_exc.OperationalError:
    """El error que da SQLAlchemy ante un PostgreSQL que nadie escucha, no uno inventado."""
    motor = create_engine("postgresql+psycopg://nadie:clave-secreta-123@127.0.0.1:1/nada", connect_args={"connect_timeout": 1})
    with pytest.raises(sa_exc.OperationalError) as caida:
        motor.connect()
    return caida.value


def con_listado_que_falla(monkeypatch, error):
    def falla(*_):
        raise error

    monkeypatch.setattr(importacion_repository, "listar", falla)


def test_con_la_base_inalcanzable_las_importaciones_responden_503_sin_detalles_internos(client, monkeypatch):
    con_listado_que_falla(monkeypatch, error_real_de_conexion())

    respuesta = client.get("/importaciones")

    assert respuesta.status_code == 503
    assert respuesta.get_json() == {"error": {"codigo": "SERVICIO_NO_DISPONIBLE", "mensaje": "El servicio no está disponible.",
                                              "detalles": []}}
    assert "clave-secreta-123" not in respuesta.get_data(as_text=True)


def test_sin_conexion_libre_en_el_pool_tambien_es_503(client, monkeypatch):
    con_listado_que_falla(monkeypatch, sa_exc.TimeoutError("QueuePool limit of size 5 overflow 10 reached"))

    assert client.get("/importaciones").status_code == 503


def test_un_error_de_sql_que_no_es_de_conexion_sigue_siendo_500(client, monkeypatch):
    con_listado_que_falla(monkeypatch, sa_exc.ProgrammingError("select x", {}, Exception("columna x no existe clave-secreta-123")))

    respuesta = client.get("/importaciones")

    assert respuesta.status_code == 500
    assert respuesta.get_json()["error"]["codigo"] == "ERROR_INTERNO"
    assert "clave-secreta-123" not in respuesta.get_data(as_text=True)
