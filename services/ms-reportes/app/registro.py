"""Registro de cada petición (RNF10), igual que en los servicios Laravel:

1. Toma el X-Request-Id que envía el Gateway para seguir la misma operación en los registros de todos los
   componentes (Entrega 2, sección 2.2). Si no llega o no es válido, genera uno nuevo.
2. Lo agrega a todos los registros de la petición (también los errores 500) y lo devuelve en la respuesta.
3. Escribe una línea JSON por petición en la salida de errores. Nunca registra el cuerpo, la cadena de consulta
   ni las cabeceras.

/health y /docs quedan fuera, para que las comprobaciones de Kubernetes no llenen los registros.
"""

import json
import logging
import re
import sys
import time
import uuid
from datetime import UTC, datetime

from flask import Flask, g, has_request_context, request

CABECERA = "X-Request-Id"
# Solo letras, números y guiones (como un UUID), para que no se pueda ensuciar el registro.
_ID_VALIDO = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_RUTAS_SIN_REGISTRO = ("/health", "/docs")

log = logging.getLogger(__name__)


class FormatoJson(logging.Formatter):
    """Una línea JSON por registro, con la misma forma que el JsonFormatter de los servicios Laravel."""

    def __init__(self, servicio: str):
        super().__init__()
        self.servicio = servicio

    def format(self, record: logging.LogRecord) -> str:
        contexto = {"servicio": self.servicio}
        if has_request_context() and "request_id" in g:
            contexto["request_id"] = g.request_id
        # Datos propios del registro: log.info("peticion", extra={"contexto": {...}}).
        contexto.update(getattr(record, "contexto", {}))
        if record.exc_info:
            contexto["excepcion"] = record.exc_info[0].__name__
            contexto["traza"] = self.formatException(record.exc_info)

        return json.dumps({
            "message": record.getMessage(),
            "context": contexto,
            "level_name": record.levelname,
            "datetime": datetime.fromtimestamp(record.created, UTC).isoformat(),
        }, ensure_ascii=False)


def configurar_registro(app: Flask) -> None:
    """Todos los registros del servicio van en JSON a la salida de errores, con el nivel de LOG_LEVEL."""
    manejador = logging.StreamHandler(sys.stderr)
    manejador.setFormatter(FormatoJson(app.config["SERVICE_NAME"]))

    raiz = logging.getLogger()
    raiz.handlers = [manejador]
    raiz.setLevel(app.config["LOG_LEVEL"].upper())

    @app.before_request
    def _inicio():
        if request.path.startswith(_RUTAS_SIN_REGISTRO):
            return
        recibido = request.headers.get(CABECERA, "")
        g.request_id = recibido if _ID_VALIDO.match(recibido) else str(uuid.uuid4())
        g.inicio = time.perf_counter()

    # Aquí ya llega la respuesta final, también cuando hubo un error (404, 422, 500...).
    @app.after_request
    def _fin(respuesta):
        if "request_id" not in g:
            return respuesta
        respuesta.headers[CABECERA] = g.request_id
        log.info("peticion", extra={"contexto": {
            "metodo": request.method,
            "ruta": request.path,
            "estado": respuesta.status_code,
            # Usuario que envía el Gateway; nulo en las llamadas internas entre servicios.
            "id_usuario": request.headers.get("X-User-Id"),
            "duracion_ms": round((time.perf_counter() - g.inicio) * 1000, 2),
        }})
        return respuesta
