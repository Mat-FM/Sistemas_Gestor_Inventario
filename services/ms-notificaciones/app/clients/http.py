"""Cliente para llamar a otros servicios con las reglas de RNF18:

- espera máxima de 3 s por intento;
- reintentos (0,2 s, 0,4 s y 0,8 s) solo si la operación no se duplica al repetirse;
- cortacircuito: tras 5 fallos seguidos deja de llamar al servicio durante 30 s.

Usa urllib de la biblioteca estándar: no hace falta otra dependencia.
"""
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .. import logger


class ServicioNoDisponible(Exception):
    def __init__(self, servicio, causa):
        super().__init__(f"{servicio} no responde: {causa}")
        self.servicio = servicio
        self.causa = causa


class Cortacircuito:
    def __init__(self, nombre, fallos_para_abrir, tiempo_abierto_s):
        self.nombre = nombre
        self.fallos_para_abrir = fallos_para_abrir
        self.tiempo_abierto_s = tiempo_abierto_s
        self.fallos_seguidos = 0
        self.abierto_hasta = 0.0
        self._candado = threading.Lock()

    def permite(self):
        """Abierto: no se llama. Pasado el tiempo, se deja pasar una llamada de prueba."""
        return time.monotonic() >= self.abierto_hasta

    def exito(self):
        with self._candado:
            self.fallos_seguidos = 0
            self.abierto_hasta = 0.0

    def fallo(self):
        with self._candado:
            self.fallos_seguidos += 1
            if self.fallos_seguidos >= self.fallos_para_abrir:
                self.abierto_hasta = time.monotonic() + self.tiempo_abierto_s
                logger.warn("cortacircuito abierto", destino=self.nombre, segundos=self.tiempo_abierto_s)

    @property
    def estado(self):
        return "CERRADO" if self.permite() else "ABIERTO"


class ClienteHttp:
    def __init__(self, nombre, url_base, timeout_s, esperas_reintento_s, fallos_para_abrir, tiempo_abierto_s):
        self.nombre = nombre
        self.url_base = url_base.rstrip("/")
        self.timeout_s = timeout_s
        self.esperas = esperas_reintento_s
        self.cortacircuito = Cortacircuito(nombre, fallos_para_abrir, tiempo_abierto_s)

    def get(self, ruta, parametros=None, cabeceras=None, reintentar=True):
        """GET no cambia nada en el destino, por eso se reintenta por defecto.

        Devuelve (status, cuerpo) para cualquier respuesta HTTP (también 4xx).
        Lanza ServicioNoDisponible si no hubo respuesta, si respondió 5xx o si el cortacircuito está abierto.
        """
        if not self.cortacircuito.permite():
            raise ServicioNoDisponible(self.nombre, "cortacircuito abierto")
        consulta = f"?{urllib.parse.urlencode(parametros)}" if parametros else ""
        url = f"{self.url_base}{ruta}{consulta}"
        intentos = len(self.esperas) + 1 if reintentar else 1
        ultimo_error = None

        for intento in range(intentos):
            if intento > 0:
                if not self.cortacircuito.permite():
                    break
                time.sleep(self.esperas[intento - 1])
            peticion = urllib.request.Request(url, headers={"Accept": "application/json", **(cabeceras or {})})
            try:
                with urllib.request.urlopen(peticion, timeout=self.timeout_s) as respuesta:
                    status, texto = respuesta.status, respuesta.read()
            except urllib.error.HTTPError as error:
                status, texto = error.code, error.read()
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as error:
                causa = getattr(error, "reason", error)
                es_espera = isinstance(causa, (socket.timeout, TimeoutError))
                ultimo_error = f"no respondió en {self.timeout_s} s" if es_espera else str(causa)
                self.cortacircuito.fallo()
                continue

            if status >= 500:
                ultimo_error = f"respondió {status}"
                self.cortacircuito.fallo()
                continue
            self.cortacircuito.exito()
            try:
                cuerpo = json.loads(texto) if texto else None
            except ValueError:
                cuerpo = {"texto": texto.decode("utf-8", "replace")}
            return status, cuerpo

        logger.warn("llamada fallida", destino=self.nombre, metodo="GET", ruta=ruta, causa=ultimo_error)
        raise ServicioNoDisponible(self.nombre, ultimo_error)
