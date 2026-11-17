"""Registros en formato JSON, una línea por evento, a la salida estándar (RNF10).

Se leen con `docker logs ms-notificaciones` o `docker compose logs ms-notificaciones`.
"""
import json
import logging
import sys
from datetime import datetime, timezone

_servicio = "ms-notificaciones"


class _FormatoJson(logging.Formatter):
    def format(self, registro):
        linea = {
            "fecha": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "nivel": "warn" if registro.levelno == logging.WARNING else registro.levelname.lower(),
            "servicio": _servicio,
            "mensaje": registro.getMessage(),
        }
        linea.update(getattr(registro, "datos", {}))
        return json.dumps(linea, ensure_ascii=False, default=str)


_logger = logging.getLogger("ms-notificaciones")


def configurar(servicio, nivel):
    global _servicio
    _servicio = servicio
    if not _logger.handlers:
        manejador = logging.StreamHandler(sys.stdout)
        manejador.setFormatter(_FormatoJson())
        _logger.addHandler(manejador)
    _logger.setLevel(getattr(logging, nivel, logging.INFO))
    _logger.propagate = False


def debug(mensaje, **datos):
    _logger.debug(mensaje, extra={"datos": datos})


def info(mensaje, **datos):
    _logger.info(mensaje, extra={"datos": datos})


def warn(mensaje, **datos):
    _logger.warning(mensaje, extra={"datos": datos})


def error(mensaje, **datos):
    _logger.error(mensaje, extra={"datos": datos})
