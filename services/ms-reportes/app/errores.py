"""Forma común de error de la Entrega 2 (sección 4.1): {"error": {"codigo", "mensaje", "detalles"}}.

Es la misma forma y los mismos textos que usan el API Gateway, ms-catalogo y ms-proveedores.
"""

import logging

from flask import Flask, jsonify
from sqlalchemy import exc as sa_exc
from werkzeug.exceptions import HTTPException

log = logging.getLogger(__name__)


class ApiError(Exception):
    """Error que el servicio responde con la forma común. Se lanza desde cualquier capa."""

    def __init__(self, status: int, codigo: str, mensaje: str, detalles: list | None = None):
        super().__init__(mensaje)
        self.status = status
        self.codigo = codigo
        self.mensaje = mensaje
        self.detalles = detalles or []

    def cuerpo(self) -> dict:
        return {"error": {"codigo": self.codigo, "mensaje": self.mensaje, "detalles": self.detalles}}

    @classmethod
    def no_existe(cls, mensaje: str = "El recurso no existe.") -> "ApiError":
        return cls(404, "NO_EXISTE", mensaje)

    @classmethod
    def conflicto(cls, codigo: str, mensaje: str) -> "ApiError":
        """409 con un código propio."""
        return cls(409, codigo, mensaje)

    @classmethod
    def datos_no_validos(cls, detalles: list[dict]) -> "ApiError":
        """422 con un detalle {campo, mensaje} por cada error."""
        return cls(422, "DATOS_NO_VALIDOS", "Los datos enviados no son válidos.", detalles)

    @classmethod
    def peticion_mal_formada(cls, status: int = 400, mensaje: str = "La petición está mal formada.") -> "ApiError":
        return cls(status, "PETICION_MAL_FORMADA", mensaje)

    @classmethod
    def servicio_no_disponible(cls, mensaje: str = "El servicio no está disponible.") -> "ApiError":
        """503: algo de lo que depende el servicio no responde (su base de datos u otro servicio)."""
        return cls(503, "SERVICIO_NO_DISPONIBLE", mensaje)

    @classmethod
    def error_interno(cls) -> "ApiError":
        """Siempre genérico: nunca muestra el mensaje ni la traza del error original."""
        return cls(500, "ERROR_INTERNO", "Error interno del servidor.")


# SQLSTATE de conexión: servidor apagándose, caído, sin aceptar aún o sin conexiones libres.
_SQLSTATE_DE_CONEXION = {"53300", "57P01", "57P02", "57P03"}


def _base_inalcanzable(e: Exception) -> bool:
    """La base no se puede alcanzar (conexión rechazada o cortada, sin conexión libre en el pool). No es un fallo del
    código: un reintento puede funcionar, así que se responde 503 y no 500 (RNF18)."""
    if isinstance(e, sa_exc.TimeoutError):
        return True
    if isinstance(e, sa_exc.OperationalError):
        # Sin SQLSTATE es un fallo del lado del cliente (no pudo conectar, se cortó); con él, solo los de conexión.
        sqlstate = getattr(e.orig, "sqlstate", None)
        return sqlstate is None or sqlstate.startswith("08") or sqlstate in _SQLSTATE_DE_CONEXION
    return False


def _responder(error: ApiError):
    return jsonify(error.cuerpo()), error.status


def registrar_manejadores(app: Flask) -> None:
    """Todas las respuestas de error salen con la forma común, incluidos 404, 405 y 500."""

    # Errores esperados (404, 409, 422, 503...): no son fallos del servidor y no se registran como error.
    @app.errorhandler(ApiError)
    def _api_error(e: ApiError):
        return _responder(e)

    # Ruta inexistente (404), método no permitido (405), JSON mal escrito (400) y demás errores HTTP.
    @app.errorhandler(HTTPException)
    def _http_error(e: HTTPException):
        status = e.code or 500
        if status == 404:
            return _responder(ApiError.no_existe())
        if status == 405:
            return _responder(ApiError.peticion_mal_formada(405, "Método no permitido."))
        if 400 <= status < 500:
            return _responder(ApiError.peticion_mal_formada(status))
        return _responder(ApiError.error_interno())

    # Último recurso: cualquier otro fallo es un 500 genérico. La traza solo va al registro.
    @app.errorhandler(Exception)
    def _error_inesperado(e: Exception):
        if _base_inalcanzable(e):
            log.error("base_de_datos_inalcanzable", extra={"contexto": {"tipo": type(e).__name__}})
            return _responder(ApiError.servicio_no_disponible())
        log.exception("error_interno")
        return _responder(ApiError.error_interno())
