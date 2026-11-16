"""Rutas de operación (/health, /docs), forma común de error y X-Request-Id (RNF08, RNF10)."""

import re

from app import create_app
from app.extensions import db


def test_health_responde_ok_si_la_base_responde(client):
    respuesta = client.get("/health")

    assert respuesta.status_code == 200
    assert respuesta.get_json() == {"estado": "ok", "servicio": "ms-reportes"}
    # /health no pasa por el registro de peticiones.
    assert "X-Request-Id" not in respuesta.headers


def test_health_responde_503_si_la_base_no_responde():
    caida = create_app({"SQLALCHEMY_DATABASE_URI": "sqlite:////ruta/que/no/existe/x.db"})

    respuesta = caida.test_client().get("/health")
    with caida.app_context():
        db.engine.dispose()

    assert respuesta.status_code == 503
    assert respuesta.get_json()["error"]["codigo"] == "SERVICIO_NO_DISPONIBLE"


def test_docs_entrega_swagger_ui_y_el_documento_openapi(client):
    pagina = client.get("/docs")
    assert pagina.status_code == 200
    assert pagina.mimetype == "text/html"
    assert b"/docs/openapi.yaml" in pagina.data
    pagina.close()

    documento = client.get("/docs/openapi.yaml")
    assert documento.status_code == 200
    assert documento.data.startswith(b"openapi: 3.0.3")
    documento.close()


def test_una_ruta_inexistente_responde_404_con_la_forma_comun(client):
    respuesta = client.get("/ruta-que-no-existe")

    assert respuesta.status_code == 404
    assert respuesta.get_json() == {"error": {"codigo": "NO_EXISTE", "mensaje": "El recurso no existe.", "detalles": []}}


def test_un_metodo_no_permitido_responde_405(client):
    respuesta = client.delete("/importaciones")

    assert respuesta.status_code == 405
    assert respuesta.get_json()["error"]["codigo"] == "PETICION_MAL_FORMADA"


def test_un_error_inesperado_responde_500_sin_detalles(app, client, monkeypatch):
    def falla(*args):
        raise RuntimeError("detalle interno que no debe salir")

    monkeypatch.setattr("app.services.importacion_service.listar", falla)

    respuesta = client.get("/importaciones")

    assert respuesta.status_code == 500
    assert respuesta.get_json() == {
        "error": {"codigo": "ERROR_INTERNO", "mensaje": "Error interno del servidor.", "detalles": []}}


def test_reutiliza_el_x_request_id_que_llega_o_genera_uno(client):
    assert client.get("/importaciones", headers={"X-Request-Id": "id-del-gateway"}).headers["X-Request-Id"] == \
        "id-del-gateway"

    # Un valor con caracteres no permitidos se reemplaza por un UUID nuevo.
    generado = client.get("/importaciones", headers={"X-Request-Id": "malo con espacios"}).headers["X-Request-Id"]
    assert re.fullmatch(r"[0-9a-f-]{36}", generado)


def test_valida_la_paginacion(client):
    respuesta = client.get("/importaciones?pagina=x&por_pagina=101")

    assert respuesta.status_code == 422
    assert respuesta.get_json()["error"]["detalles"] == [
        {"campo": "pagina", "mensaje": "El campo pagina debe ser un número entero."},
        {"campo": "por_pagina", "mensaje": "El campo por_pagina no puede ser mayor que 100."},
    ]
