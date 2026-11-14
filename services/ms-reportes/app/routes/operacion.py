"""Rutas propias del servicio, fuera de las operaciones del contrato: /health (RNF10) y /docs (RNF08).
No pasan por el Gateway (Entrega 2, sección 4.1) y no se registran (ver app/registro.py)."""

import logging
from pathlib import Path

from flask import Blueprint, current_app, jsonify, send_file
from sqlalchemy import text

from app.errores import ApiError
from app.extensions import db

bp = Blueprint("operacion", __name__)

log = logging.getLogger(__name__)

# Carpeta del servicio (services/ms-reportes), donde están openapi.yaml y docs/.
_RAIZ = Path(__file__).resolve().parents[2]


@bp.get("/health")
def health():
    """200 solo si el servicio puede atender peticiones, es decir, si PostgreSQL responde. Si no, 503 con la forma
    común de error; el motivo va al registro, nunca en la respuesta. No consulta a los demás servicios: si uno cae,
    este sigue atendiendo lo que no depende de él."""
    try:
        db.session.execute(text("select 1"))
    except Exception as e:
        db.session.rollback()
        log.error("base_de_datos_no_disponible", extra={"contexto": {"excepcion": type(e).__name__}})
        raise ApiError.servicio_no_disponible()
    return jsonify(estado="ok", servicio=current_app.config["SERVICE_NAME"])


@bp.get("/docs")
def interfaz():
    """Página que carga Swagger UI desde un CDN con versión e integridad fijas."""
    return send_file(_RAIZ / "docs" / "swagger-ui.html", mimetype="text/html")


@bp.get("/docs/openapi.yaml")
def especificacion():
    """El documento OpenAPI, en crudo."""
    return send_file(_RAIZ / "openapi.yaml", mimetype="application/yaml")
