"""Lee las cabeceras que agrega el API Gateway (Entrega 2, sección 2.2) y registra cada petición."""
import time
import uuid

from flask import g, request

from . import logger
from .errores import ApiError

ROLES = ("ADMINISTRADOR", "OPERADOR_BODEGA", "VENDEDOR", "CONTADOR")


def _entero(valor):
    try:
        numero = int(valor)
    except (TypeError, ValueError):
        return None
    return numero if numero > 0 else None


def _antes():
    """g.request_id y g.usuario = {"id", "rol", "id_bodega"} o None.

    Las rutas internas (llamadas desde ms-inventario y ms-compras) llegan sin usuario.
    """
    g.inicio = time.perf_counter()
    g.request_id = request.headers.get("X-Request-Id") or str(uuid.uuid4())
    id_usuario = _entero(request.headers.get("X-User-Id"))
    rol = request.headers.get("X-User-Rol")
    g.usuario = (
        {
            "id": id_usuario,
            "rol": rol if rol in ROLES else None,
            "id_bodega": _entero(request.headers.get("X-User-Bodega")),
        }
        if id_usuario
        else None
    )


def _despues(respuesta):
    respuesta.headers["X-Request-Id"] = g.get("request_id", "")
    logger.info(
        "peticion",
        request_id=g.get("request_id"),
        metodo=request.method,
        ruta=request.full_path.rstrip("?"),
        estado=respuesta.status_code,
        duracion_ms=round((time.perf_counter() - g.get("inicio", time.perf_counter())) * 1000),
        id_usuario=(g.get("usuario") or {}).get("id"),
    )
    return respuesta


def registrar(app):
    app.before_request(_antes)
    app.after_request(_despues)


def usuario_actual():
    """Las rutas públicas necesitan saber quién pregunta: cada usuario ve las alertas de su rol."""
    usuario = g.get("usuario")
    if not usuario or not usuario["rol"]:
        raise ApiError.no_autenticado("Falta la identidad del usuario (cabeceras X-User-Id y X-User-Rol).")
    return usuario
