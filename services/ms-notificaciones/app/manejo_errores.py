"""Convierte cualquier error en la respuesta común {"error": {...}} y registra los inesperados."""
import psycopg
from flask import g, request
from psycopg_pool import PoolClosed, PoolTimeout
from werkzeug.exceptions import BadRequest, HTTPException, MethodNotAllowed, NotFound

from . import logger
from .errores import ApiError

# Errores de PostgreSQL de conexión: servidor apagándose, caído, sin aceptar aún o sin conexiones libres.
_SQLSTATE_DE_CONEXION = {"53300", "57P01", "57P02", "57P03"}


def _base_inalcanzable(error):
    """La base no se puede alcanzar (conexión rechazada, cortada, sin conexión libre en el pool...). No es un fallo del
    código: el servicio sigue sano y un reintento puede funcionar, así que se responde 503 y no 500 (RNF18)."""
    if isinstance(error, (PoolTimeout, PoolClosed, psycopg.InterfaceError)):
        return True
    if isinstance(error, psycopg.OperationalError):
        # Sin SQLSTATE es un fallo del lado del cliente (no pudo conectar, se cortó); con él, solo los de conexión.
        sqlstate = error.sqlstate
        return sqlstate is None or sqlstate.startswith("08") or sqlstate in _SQLSTATE_DE_CONEXION
    return False


def registrar(app):
    @app.errorhandler(ApiError)
    def _api_error(error):
        return error.a_json(), error.status

    @app.errorhandler(NotFound)
    def _ruta_no_encontrada(_error):
        error = ApiError.no_encontrado(f"No existe la ruta {request.method} {request.path}.", "RUTA_NO_ENCONTRADA")
        return error.a_json(), 404

    @app.errorhandler(MethodNotAllowed)
    def _metodo_no_permitido(_error):
        error = ApiError(405, "METODO_NO_PERMITIDO", f"La ruta {request.path} no acepta {request.method}.")
        return error.a_json(), 405

    # JSON mal formado en el cuerpo.
    @app.errorhandler(BadRequest)
    def _peticion_invalida(_error):
        return ApiError.peticion_invalida("El cuerpo de la petición no es un JSON válido.").a_json(), 400

    @app.errorhandler(HTTPException)
    def _otro_http(error):
        return ApiError(error.code, "ERROR_HTTP", error.description or error.name).a_json(), error.code

    @app.errorhandler(Exception)
    def _inesperado(error):
        if _base_inalcanzable(error):
            logger.error("base de datos inalcanzable", request_id=g.get("request_id"), error=str(error), tipo=type(error).__name__)
            return ApiError(503, "SERVICIO_NO_DISPONIBLE", "El servicio no está disponible.").a_json(), 503
        logger.error("error inesperado", request_id=g.get("request_id"), error=str(error), tipo=type(error).__name__)
        return ApiError(500, "ERROR_INTERNO", "Ocurrió un error inesperado en ms-notificaciones.").a_json(), 500
