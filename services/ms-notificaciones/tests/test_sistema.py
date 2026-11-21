"""/health, /docs, X-Request-Id, formato de errores y migraciones."""
import pytest

from app import db
from app.migrar import migrar


def test_health_responde_ok_con_la_base_de_datos_y_el_cortacircuito(cliente):
    res = cliente.get("/health")
    assert res.status_code == 200
    assert res.json == {
        "estado": "ok",
        "servicio": "ms-notificaciones",
        "base_de_datos": "ok",
        "cortacircuitos": {"ms-inventario": "CERRADO"},
    }


def test_health_responde_503_si_no_hay_base_de_datos(cliente, monkeypatch):
    def sin_conexion():
        raise RuntimeError("sin conexión")

    monkeypatch.setattr(db, "conexion", sin_conexion)
    res = cliente.get("/health")
    assert res.status_code == 503
    assert res.json["base_de_datos"] == "sin conexión"


def test_docs_publica_la_especificacion_openapi(cliente):
    spec = cliente.get("/docs/openapi.json")
    assert spec.status_code == 200
    assert set(spec.json["paths"]) >= {
        "/notificaciones",
        "/notificaciones/{id}/leida",
        "/preferencias/mia",
        "/configuracion-alertas",
        "/internas/notificaciones",
    }
    for ruta in ("/docs", "/docs/"):
        pagina = cliente.get(ruta)
        assert pagina.status_code == 200
        assert b"swagger-ui" in pagina.data


def test_devuelve_el_x_request_id_que_recibe_o_genera_uno_nuevo(cliente):
    assert cliente.get("/health", headers={"X-Request-Id": "abc-123"}).headers["X-Request-Id"] == "abc-123"
    nuevo = cliente.get("/health").headers["X-Request-Id"]
    assert len(nuevo) == 36


def test_errores_con_el_formato_comun(cliente):
    no_existe = cliente.get("/no-existe")
    assert no_existe.status_code == 404
    assert no_existe.json["error"]["codigo"] == "RUTA_NO_ENCONTRADA"
    metodo = cliente.delete("/notificaciones")
    assert metodo.status_code == 405
    assert set(metodo.json["error"]) == {"codigo", "mensaje", "detalles"}


def test_un_error_inesperado_responde_500_sin_detalles_internos(cliente, monkeypatch):
    from app.services import configuracion

    def falla():
        raise RuntimeError("detalle interno")

    monkeypatch.setattr(configuracion, "obtener", falla)
    res = cliente.get("/configuracion-alertas", headers={"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"})
    assert res.status_code == 500
    assert res.json["error"]["codigo"] == "ERROR_INTERNO"
    assert "detalle interno" not in res.json["error"]["mensaje"]


def test_migrar_dos_veces_no_falla_ni_repite_migraciones():
    assert migrar() == []
    with db.conexion() as con:
        assert con.execute("SELECT count(*) AS n FROM migracion").fetchone()["n"] == 1
        assert con.execute("SELECT count(*) AS n FROM configuracion").fetchone()["n"] == 1


def _falla_con(error, monkeypatch):
    from app.services import configuracion

    def falla():
        raise error

    monkeypatch.setattr(configuracion, "obtener", falla)


def test_con_la_base_inalcanzable_responde_503_sin_detalles_internos(cliente, monkeypatch):
    """Un fallo real de conexión (un PostgreSQL que nadie escucha), no uno inventado: responde 503 (RNF18) y no 500."""
    import psycopg

    with pytest.raises(psycopg.OperationalError) as caida:
        psycopg.connect(host="127.0.0.1", port=1, user="nadie", password="clave-secreta-123", connect_timeout=1)
    _falla_con(caida.value, monkeypatch)

    res = cliente.get("/configuracion-alertas", headers={"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"})

    assert res.status_code == 503
    assert res.json == {"error": {"codigo": "SERVICIO_NO_DISPONIBLE", "mensaje": "El servicio no está disponible.", "detalles": []}}
    assert "clave-secreta-123" not in res.get_data(as_text=True)


def test_sin_conexion_libre_en_el_pool_responde_503(cliente, monkeypatch):
    from psycopg_pool import PoolTimeout

    _falla_con(PoolTimeout("couldn't get a connection after 5.00 sec"), monkeypatch)

    res = cliente.get("/configuracion-alertas", headers={"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"})

    assert res.status_code == 503
    assert res.json["error"]["codigo"] == "SERVICIO_NO_DISPONIBLE"


def test_un_fallo_de_la_base_que_no_es_de_conexion_sigue_siendo_500(cliente, monkeypatch):
    import psycopg

    _falla_con(psycopg.errors.UndefinedColumn("column x no existe clave-secreta-123"), monkeypatch)

    res = cliente.get("/configuracion-alertas", headers={"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"})

    assert res.status_code == 500
    assert res.json["error"]["codigo"] == "ERROR_INTERNO"
    assert "clave-secreta-123" not in res.get_data(as_text=True)
