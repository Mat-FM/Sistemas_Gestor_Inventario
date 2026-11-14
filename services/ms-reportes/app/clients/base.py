"""Base de las llamadas a los demás servicios. Aplica RNF18, igual que ms-catalogo con ms-proveedores:

- Cada intento espera como máximo CALL_TIMEOUT_SECONDS (3 s).
- Solo las operaciones que no se duplican al repetirse se reintentan (las consultas y la carga inicial de
  ms-inventario, que lleva Idempotency-Key), hasta 3 veces, con esperas de 0,2, 0,4 y 0,8 s, ante un fallo de
  conexión o un error 5xx.
- Cortacircuitos: tras 5 llamadas fallidas seguidas a un servicio, durante 30 s no se le llama y se falla de
  inmediato. Después se vuelve a probar: si falla, se abre otra vez; si responde, el contador vuelve a 0.

El estado del cortacircuitos vive en la memoria del proceso, así que cada copia del servicio lleva el suyo.
"""

import logging
import time

import requests
from flask import current_app, g, has_request_context

from app.registro import CABECERA

ESPERAS_REINTENTO = (0.2, 0.4, 0.8)
FALLOS_PARA_ABRIR = 5
SEGUNDOS_ABIERTO = 30

log = logging.getLogger(__name__)

# Por servicio: fallos seguidos y hasta cuándo está abierto (reloj monotónico).
_cortacircuitos: dict[str, dict] = {}


class ServicioNoDisponible(Exception):
    """El servicio no respondió, respondió con un error 5xx, dio una respuesta no válida o el cortacircuitos está abierto."""

    def __init__(self, servicio: str):
        super().__init__(f"{servicio} no responde.")
        self.servicio = servicio


class ClienteServicio:
    def __init__(self, servicio: str, clave_url: str):
        self.servicio = servicio
        self.clave_url = clave_url

    def get(self, ruta: str, params: dict | None = None):
        """Consulta: se reintenta. Devuelve el JSON de una respuesta 200."""
        return self._json(self._llamar("GET", ruta, reintentar=True, params=params))

    def post(self, ruta: str, cuerpo: dict, cabeceras: dict | None = None, reintentar: bool = False):
        """Envío: solo se reintenta si el destino no lo duplica (reintentar=True). Devuelve el JSON de una respuesta 200."""
        return self._json(self._llamar("POST", ruta, reintentar=reintentar, json=cuerpo, headers=cabeceras or {}))

    def _llamar(self, metodo: str, ruta: str, reintentar: bool, headers: dict | None = None, **opciones):
        estado = _cortacircuitos.setdefault(self.servicio, {"fallos": 0, "abierto_hasta": 0.0})
        if time.monotonic() < estado["abierto_hasta"]:
            raise ServicioNoDisponible(self.servicio)

        url = current_app.config[self.clave_url].rstrip("/") + ruta
        cabeceras = dict(headers or {})
        # El mismo identificador de la petición, para seguirla en los registros de los dos servicios (RNF10).
        if has_request_context() and "request_id" in g:
            cabeceras[CABECERA] = g.request_id

        intentos = 1 + len(ESPERAS_REINTENTO) if reintentar else 1
        respuesta = None
        for intento in range(intentos):
            if intento > 0:
                time.sleep(ESPERAS_REINTENTO[intento - 1])
            try:
                respuesta = requests.request(metodo, url, headers=cabeceras,
                                             timeout=current_app.config["CALL_TIMEOUT_SECONDS"], **opciones)
            except requests.RequestException:
                respuesta = None
            # Un 4xx no se reintenta: repetir la misma petición daría el mismo resultado.
            if respuesta is not None and respuesta.status_code < 500:
                break

        if respuesta is None or respuesta.status_code >= 500:
            self._registrar_fallo(estado, None if respuesta is None else respuesta.status_code)
            raise ServicioNoDisponible(self.servicio)

        estado["fallos"] = 0
        return respuesta

    def _json(self, respuesta: requests.Response):
        """Solo una respuesta 200 con JSON es válida; cualquier otra cosa se trata como servicio no disponible."""
        try:
            if respuesta.status_code == 200:
                return respuesta.json()
        except ValueError:
            pass
        log.error("respuesta_no_valida", extra={"contexto": {"destino": self.servicio, "estado": respuesta.status_code}})
        raise ServicioNoDisponible(self.servicio)

    def _registrar_fallo(self, estado: dict, codigo: int | None) -> None:
        estado["fallos"] += 1
        log.error("servicio_no_disponible", extra={"contexto": {
            "destino": self.servicio, "estado": codigo, "fallos_seguidos": estado["fallos"]}})
        if estado["fallos"] >= FALLOS_PARA_ABRIR:
            estado["abierto_hasta"] = time.monotonic() + SEGUNDOS_ABIERTO
            log.warning("cortacircuitos_abierto", extra={"contexto": {
                "destino": self.servicio, "segundos": SEGUNDOS_ABIERTO}})


def reiniciar_cortacircuitos() -> None:
    """Deja todos los cortacircuitos cerrados. Lo usan las pruebas."""
    _cortacircuitos.clear()
