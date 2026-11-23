"""Piezas comunes de las pruebas: configuración, los dos modos de acceso y la preparación de datos.

Modos (PERF_MODO):
- gateway: como un usuario real. Inicia sesión en POST /api/auth/login y llama /api/<ruta> con el token JWT.
  Es la medición de punta a punta: incluye el Gateway, su validación del token y su límite de peticiones.
- directo: llama a ms-inventario sin pasar por el Gateway, con las cabeceras X-User-* que el Gateway agregaría.
  Mide el servicio aislado.
"""
import itertools
import os
import uuid

import gevent.lock
import requests
from locust import HttpUser, between

MODO = os.environ.get("PERF_MODO", "directo").strip().lower()
if MODO not in ("directo", "gateway"):
    raise RuntimeError("PERF_MODO debe ser directo o gateway")

URLS = {
    "gateway": os.environ.get("PERF_GATEWAY_URL", "http://api-gateway:8000"),
    "inventario": os.environ.get("PERF_INVENTARIO_URL", "http://ms-inventario:3000"),
}

# Datos que deben existir: dos productos activos en ms-catalogo (ms-inventario los valida en cada movimiento) y dos
# bodegas activas en ms-inventario (la segunda es el destino de los traslados).
ID_PRODUCTO = int(os.environ.get("PERF_ID_PRODUCTO", "1"))
ID_PRODUCTO_2 = int(os.environ.get("PERF_ID_PRODUCTO_2", "2"))
ID_BODEGA = int(os.environ.get("PERF_ID_BODEGA", "1"))
ID_BODEGA_2 = int(os.environ.get("PERF_ID_BODEGA_2", "2"))

# Modo gateway: "correo:contraseña,correo:contraseña". El Gateway limita a 100 peticiones por minuto POR USUARIO y a
# 10 inicios de sesión por minuto por IP (RNF19): con 50 usuarios simulados hacen falta varias cuentas, y cada cuenta
# inicia sesión una sola vez (el token se reutiliza). Ver README.
CUENTAS = [c.split(":", 1) for c in os.environ.get("PERF_USUARIOS", "").split(",") if ":" in c]

ADMIN_DIRECTO = {"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"}
TIEMPO_PREPARACION_S = 30

_ids_usuario = itertools.count(1000)
_cuentas = itertools.cycle(range(len(CUENTAS))) if CUENTAS else None
_tokens = {}
_candado = gevent.lock.Semaphore()
# Otro candado para la preparación: prepara datos con peticiones que inician sesión (_iniciar_sesion usa _candado) y un candado no se puede
# pedir dos veces desde la misma tarea: con uno solo, en modo gateway la preparación se bloquearía para siempre.
_candado_datos = gevent.lock.Semaphore()
_preparado = {}


def nuevo_request_id(prueba):
    return f"perf-{prueba}-{uuid.uuid4().hex[:12]}"


def clave():
    """Una Idempotency-Key nueva (RNF17): sin «#» y de menos de 200 caracteres."""
    return f"perf-{uuid.uuid4()}"


def _iniciar_sesion(indice):
    """Un token por cuenta: se pide la primera vez y se comparte entre los usuarios simulados que usan esa cuenta."""
    with _candado:
        if indice not in _tokens:
            correo, contrasena = CUENTAS[indice]
            respuesta = requests.post(
                f"{URLS['gateway']}/api/auth/login",
                json={"correo": correo, "contrasena": contrasena},
                timeout=TIEMPO_PREPARACION_S,
            )
            respuesta.raise_for_status()
            _tokens[indice] = respuesta.json()["token"]
    return _tokens[indice]


def cabeceras_admin():
    """Cabeceras de un administrador para preparar datos fuera de la medición."""
    if MODO == "gateway":
        if not CUENTAS:
            raise RuntimeError("En modo gateway defina PERF_USUARIOS con al menos una cuenta de ADMINISTRADOR")
        return {"Authorization": f"Bearer {_iniciar_sesion(0)}"}
    return dict(ADMIN_DIRECTO)


def host():
    """Host de Locust: el Gateway o ms-inventario, según el modo."""
    return URLS["gateway"] if MODO == "gateway" else URLS["inventario"]


def url_publica(ruta):
    return f"{URLS['gateway']}/api{ruta}" if MODO == "gateway" else f"{URLS['inventario']}{ruta}"


def una_vez(nombre, funcion):
    """Ejecuta la preparación una sola vez por corrida aunque la pidan los 50 usuarios a la vez."""
    with _candado_datos:
        if nombre not in _preparado:
            _preparado[nombre] = funcion()
    return _preparado[nombre]


def preparar(metodo, ruta, **opciones):
    """Petición de preparación: NO cuenta en las estadísticas de Locust. Falla en voz alta si algo sale mal."""
    cabeceras = {**cabeceras_admin(), **opciones.pop("headers", {})}
    respuesta = requests.request(metodo, url_publica(ruta), headers=cabeceras, timeout=TIEMPO_PREPARACION_S, **opciones)
    if respuesta.status_code >= 400:
        raise RuntimeError(f"Preparación fallida: {metodo} {ruta} respondió {respuesta.status_code}: {respuesta.text[:300]}")
    return respuesta.json() if respuesta.content else None


class UsuarioBase(HttpUser):
    """Usuario simulado. Piensa entre 1 y 2 s entre una operación y otra, como una persona en la interfaz."""

    abstract = True
    wait_time = between(1, 2)
    host = host()

    def on_start(self):
        self.prefijo = "/api" if MODO == "gateway" else ""
        if MODO == "gateway":
            if not CUENTAS:
                raise RuntimeError("En modo gateway defina PERF_USUARIOS")
            self.cabeceras = {"Authorization": f"Bearer {_iniciar_sesion(next(_cuentas))}"}
        else:
            # Cada usuario simulado es una persona distinta: el movimiento guarda quién lo registró (RF10).
            self.cabeceras = {**ADMIN_DIRECTO, "X-User-Id": str(next(_ids_usuario))}

    def pedir(self, metodo, ruta, nombre, esperados=(200,), validar=None, **opciones):
        """Petición medida. `nombre` agrupa las rutas con parámetros en una sola fila de resultados.

        Cuenta como error (guía del taller: no contar como éxito lo que no lo es):
        - un estado fuera de `esperados` (por ejemplo, un 409 por stock insuficiente o un 429 por el límite de peticiones);
        - un cuerpo que no cumple `validar(cuerpo)`: la función devuelve un texto con el problema, o None si está bien."""
        cabeceras = {**self.cabeceras, "X-Request-Id": nuevo_request_id(self.__class__.__name__), **opciones.pop("headers", {})}
        with self.client.request(
            metodo, f"{self.prefijo}{ruta}", name=nombre, headers=cabeceras, catch_response=True, **opciones
        ) as respuesta:
            if respuesta.status_code not in esperados:
                respuesta.failure(f"{respuesta.status_code}: {respuesta.text[:200]}")
                return None
            try:
                cuerpo = respuesta.json()
            except ValueError:
                cuerpo = None
            problema = validar(cuerpo) if validar else None
            if problema:
                respuesta.failure(problema)
                return None
            respuesta.success()
            return cuerpo


# ---------------- Validaciones de cuerpo ----------------

def paginado(cuerpo, vacio_ok=False):
    """Un listado paginado del contrato: {"datos": [...], "meta": {"pagina", "por_pagina", "total"}}."""
    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("datos"), list) or not isinstance(cuerpo.get("meta"), dict):
        return "el cuerpo no es un listado paginado (datos y meta)"
    if not cuerpo["datos"] and not vacio_ok:
        return "el listado llegó vacío: la preparación debía dejar datos"
    return None


def paginado_de(pagina):
    """Como `paginado`, pero una página posterior a la primera puede llegar vacía (la preparación deja pocos usuarios y saldos)."""
    return lambda cuerpo: paginado(cuerpo, vacio_ok=pagina > 1)


def lista(cuerpo):
    """Una lista no vacía, plana o dentro de «datos» (el árbol de categorías no pagina)."""
    datos = cuerpo.get("datos") if isinstance(cuerpo, dict) else cuerpo
    return None if isinstance(datos, list) and datos else "la lista llegó vacía o con otra forma"


def movimiento_registrado(cuerpo):
    """Un POST /movimientos exitoso devuelve el movimiento con su identificador."""
    return None if isinstance(cuerpo, dict) and cuerpo.get("id_movimiento") else "la respuesta no trae id_movimiento"
