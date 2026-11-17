"""Convierte cualquier error en la respuesta común {"error": {...}} y registra los inesperados."""
from flask import g, request
from werkzeug.exceptions import BadRequest, HTTPException, MethodNotAllowed, NotFound

from . import logger
from .errores import ApiError


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
        logger.error("error inesperado", request_id=g.get("request_id"), error=str(error), tipo=type(error).__name__)
        return ApiError(500, "ERROR_INTERNO", "Ocurrió un error inesperado en ms-notificaciones.").a_json(), 500
