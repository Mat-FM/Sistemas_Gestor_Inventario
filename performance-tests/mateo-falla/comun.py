"""Piezas comunes de las pruebas: configuración, los dos modos de acceso y la preparación de datos.

Modos (PERF_MODO):
- gateway: como un usuario real. Inicia sesión en POST /api/auth/login y llama /api/<ruta> con el token JWT.
  Es la medición de punta a punta: incluye el Gateway, su validación del token y su límite de peticiones.
  Es el modo que se puede correr desde fuera de la red de contenedores: ms-catalogo, ms-proveedores y ms-reportes no publican puertos (RNF09).
- directo: llama a cada servicio sin pasar por el Gateway, con las cabeceras X-User-* que el Gateway agregaría. Mide el servicio aislado;
  hay que correrlo dentro de la red de contenedores (ver README).
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
    "catalogo": os.environ.get("PERF_CATALOGO_URL", "http://ms-catalogo:8000"),
    "proveedores": os.environ.get("PERF_PROVEEDORES_URL", "http://ms-proveedores:8000"),
    "reportes": os.environ.get("PERF_REPORTES_URL", "http://ms-reportes:5000"),
    # Solo para preparar el stock que miran los reportes (no se mide).
    "inventario": os.environ.get("PERF_INVENTARIO_URL", "http://ms-inventario:3000"),
}

# Dos bodegas activas en ms-inventario: los reportes de existencias y el kardex las recorren.
ID_BODEGA = int(os.environ.get("PERF_ID_BODEGA", "1"))
ID_BODEGA_2 = int(os.environ.get("PERF_ID_BODEGA_2", "2"))

# Modo gateway: "correo:contraseña,correo:contraseña". El Gateway limita a 100 peticiones por minuto POR USUARIO y a 10 inicios de sesión
# por minuto por IP (RNF19): con 50 usuarios simulados hacen falta varias cuentas, o un Gateway con esos límites subidos para medir el
# servicio y no el limitador (ver README). Cada cuenta inicia sesión una sola vez (el token se reutiliza).
CUENTAS = [c.split(":", 1) for c in os.environ.get("PERF_USUARIOS", "").split(",") if ":" in c]

ADMIN_DIRECTO = {"X-User-Id": "1", "X-User-Rol": "ADMINISTRADOR"}
TIEMPO_PREPARACION_S = 60

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


def sufijo():
    """Cuatro letras y números al azar para que los códigos y NIT de cada corrida no choquen con los de otra."""
    return uuid.uuid4().hex[:8]


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


def host(servicio):
    """Host de Locust de un servicio: el Gateway (modo gateway) o el propio servicio (modo directo)."""
    return URLS["gateway"] if MODO == "gateway" else URLS[servicio]


def url_publica(servicio, ruta):
    return f"{URLS['gateway']}/api{ruta}" if MODO == "gateway" else f"{URLS[servicio]}{ruta}"


def url_interna(servicio, ruta):
    """Rutas /internas/...: el Gateway no las publica (las llama ms-reportes dentro de la red), así que van siempre directo al servicio,
    en los dos modos. Por eso estas pruebas se corren dentro de la red de contenedores (ver README)."""
    return f"{URLS[servicio]}{ruta}"


def una_vez(nombre, funcion):
    """Ejecuta la preparación una sola vez por corrida aunque la pidan los 50 usuarios a la vez."""
    with _candado_datos:
        if nombre not in _preparado:
            _preparado[nombre] = funcion()
    return _preparado[nombre]


def preparar(servicio, metodo, ruta, **opciones):
    """Petición de preparación: NO cuenta en las estadísticas de Locust. Falla en voz alta si algo sale mal."""
    cabeceras = {**cabeceras_admin(), **opciones.pop("headers", {})}
    respuesta = requests.request(metodo, url_publica(servicio, ruta), headers=cabeceras, timeout=TIEMPO_PREPARACION_S, **opciones)
    if respuesta.status_code >= 400:
        raise RuntimeError(f"Preparación fallida: {metodo} {ruta} respondió {respuesta.status_code}: {respuesta.text[:300]}")
    return respuesta.json() if respuesta.content else None


class UsuarioBase(HttpUser):
    """Usuario simulado. Piensa entre 1 y 2 s entre una operación y otra, como una persona en la interfaz. Cada subclase abstracta
    de un servicio fija `host`; la mezcla de M01, E01 y S01 llama a los tres servicios indicando `servicio` en cada petición."""

    abstract = True
    wait_time = between(1, 2)

    def on_start(self):
        self.prefijo = "/api" if MODO == "gateway" else ""
        if MODO == "gateway":
            if not CUENTAS:
                raise RuntimeError("En modo gateway defina PERF_USUARIOS")
            self.cabeceras = {"Authorization": f"Bearer {_iniciar_sesion(next(_cuentas))}"}
        else:
            # Cada usuario simulado es una persona distinta: el log de cada petición lleva quién la hizo.
            self.cabeceras = {**ADMIN_DIRECTO, "X-User-Id": str(next(_ids_usuario))}

    def pedir(self, metodo, ruta, nombre, esperados=(200,), servicio=None, validar=None, interna=False, **opciones):
        """Petición medida. `nombre` agrupa las rutas con parámetros en una sola fila de resultados.

        Cuenta como error (guía del taller: no contar como éxito lo que no lo es):
        - un estado fuera de `esperados` (por ejemplo, un 422 por un código o NIT repetido);
        - un cuerpo que no cumple `validar(cuerpo)`: la función devuelve un texto con el problema, o None si está bien.

        `servicio` permite llamar a otro servicio desde la misma prueba (en modo gateway da igual: todo va al Gateway).
        `interna=True` va siempre directo al servicio (rutas /internas/...)."""
        if interna:
            url = url_interna(servicio, ruta)
        elif servicio and MODO == "directo":
            url = f"{URLS[servicio]}{ruta}"
        else:
            url = f"{self.prefijo}{ruta}"
        cabeceras = {**self.cabeceras, "X-Request-Id": nuevo_request_id(self.__class__.__name__), **opciones.pop("headers", {})}
        if interna:
            # La ruta interna no pasa por el Gateway: lleva la identidad que él pondría (ms-catalogo exige ADMINISTRADOR en el lote).
            cabeceras = {**cabeceras, **ADMIN_DIRECTO}
            cabeceras.pop("Authorization", None)
        with self.client.request(metodo, url, name=nombre, headers=cabeceras, catch_response=True, **opciones) as respuesta:
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
