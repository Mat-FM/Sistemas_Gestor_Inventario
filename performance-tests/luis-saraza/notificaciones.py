"""Pruebas N01 a N06: ms-notificaciones (Flask + PostgreSQL). Los escenarios están en escenarios.py."""
import itertools
import random

from locust import task

import comun
from comun import UsuarioBase, una_vez

TIPOS = ["STOCK_BAJO", "VENCIMIENTO", "ORDEN_RECIBIDA"]
NOTIFICACIONES_DE_PRUEBA = 300
# Los productos de prueba de los avisos van desde aquí, lejos de los productos reales.
PRODUCTO_BASE = 900_000
_productos_nuevos = itertools.count(PRODUCTO_BASE + 10_000)


def _sembrar_notificaciones():
    """Alertas para el rol ADMINISTRADOR, para que los listados lean y paginen datos reales."""
    import requests

    for i in range(NOTIFICACIONES_DE_PRUEBA):
        tipo = TIPOS[i % 3]
        cuerpo = {"tipo": tipo, "mensaje": f"Alerta de prueba de rendimiento {i}.", "id_bodega": comun.ID_BODEGA}
        if tipo != "ORDEN_RECIBIDA":
            cuerpo["id_producto"] = PRODUCTO_BASE + i
        respuesta = requests.post(
            f"{comun.URLS['notificaciones']}/internas/notificaciones", json=cuerpo, timeout=comun.TIEMPO_PREPARACION_S
        )
        if respuesta.status_code != 202:
            raise RuntimeError(f"Preparación fallida: {respuesta.status_code} {respuesta.text[:200]}")
    return True


class UsuarioNotificaciones(UsuarioBase):
    abstract = True
    host = comun.host_de("notificaciones")

    def on_start(self):
        super().on_start()
        una_vez("notificaciones-sembradas", _sembrar_notificaciones)


class ListadoNotificaciones(UsuarioNotificaciones):
    """N01: la campana de la interfaz. Cada usuario consulta las alertas de su rol, primera y segunda página."""

    @task(3)
    def primera_pagina(self):
        self.pedir("GET", "/notificaciones", "GET /notificaciones")

    @task(1)
    def otra_pagina(self):
        self.pedir("GET", f"/notificaciones?pagina={random.randint(2, 5)}&por_pagina=20", "GET /notificaciones?pagina")


class FiltrosNotificaciones(UsuarioNotificaciones):
    """N02: alertas sin leer, por tipo, y marcar una como leída (escritura ligera mezclada con lecturas)."""

    @task(3)
    def sin_leer(self):
        datos = self.pedir("GET", "/notificaciones?leida=false&por_pagina=20", "GET /notificaciones?leida=false")
        if datos and datos["datos"] and random.random() < 0.3:
            id_notificacion = random.choice(datos["datos"])["id_notificacion"]
            # Otro usuario pudo marcarla antes: marcarla otra vez también responde 200.
            self.pedir("POST", f"/notificaciones/{id_notificacion}/leida", "POST /notificaciones/{id}/leida")

    @task(2)
    def por_tipo(self):
        self.pedir("GET", f"/notificaciones?tipo={random.choice(TIPOS)}", "GET /notificaciones?tipo")


class PreferenciasYConfiguracion(UsuarioNotificaciones):
    """N03: la pantalla de preferencias (una por usuario, upsert en PostgreSQL) y la de configuración de alertas."""

    @task(4)
    def ver_preferencia(self):
        self.pedir("GET", "/preferencias/mia", "GET /preferencias/mia")

    @task(2)
    def guardar_preferencia(self):
        recibir = random.random() < 0.5
        cuerpo = {"recibir_correo": recibir, "correo": f"perf{random.randint(1, 10_000)}@montanero.co"}
        self.pedir("PUT", "/preferencias/mia", "PUT /preferencias/mia", json=cuerpo)

    @task(2)
    def ver_configuracion(self):
        self.pedir("GET", "/configuracion-alertas", "GET /configuracion-alertas")


class AvisosInternos(UsuarioNotificaciones):
    """N04: lo que reciben de ms-inventario (STOCK_BAJO) y ms-compras (ORDEN_RECIBIDA). Cada aviso es nuevo, así que
    cada uno inserta una fila (y, si hubiera correo configurado, lanzaría el envío en segundo plano)."""

    @task(1)
    def stock_bajo(self):
        id_producto = next(_productos_nuevos)
        self.aviso_interno({
            "tipo": "STOCK_BAJO",
            "mensaje": f"Stock bajo del producto {id_producto} tras un movimiento en la bodega {comun.ID_BODEGA}.",
            "id_producto": id_producto,
            "id_bodega": comun.ID_BODEGA,
        })

    @task(1)
    def orden_recibida(self):
        self.aviso_interno({
            "tipo": "ORDEN_RECIBIDA",
            "mensaje": "La orden OC-PERF se recibió completa.",
            "id_bodega": comun.ID_BODEGA,
            "rol_destinatario": "ADMINISTRADOR",
        })


class AvisosDuplicados(UsuarioNotificaciones):
    """N05: muchos avisos iguales a la vez (el mismo producto bajo el umbral tras varios movimientos seguidos).
    El índice único parcial debe dejar una sola alerta sin leer por producto, sin errores ni bloqueos."""

    @task
    def repetido(self):
        id_producto = PRODUCTO_BASE + 50_000 + random.randint(1, 5)
        self.aviso_interno(
            {"tipo": "STOCK_BAJO", "mensaje": f"Stock bajo del producto {id_producto}.", "id_producto": id_producto},
            nombre="POST /internas/notificaciones (repetido)",
        )


class PicoMixto(UsuarioNotificaciones):
    """N06: llegada brusca de usuarios (todos abren la aplicación al empezar el turno) con el uso típico."""

    @task(5)
    def listar(self):
        self.pedir("GET", "/notificaciones", "GET /notificaciones")

    @task(2)
    def sin_leer(self):
        self.pedir("GET", "/notificaciones?leida=false", "GET /notificaciones?leida=false")

    @task(1)
    def preferencia(self):
        self.pedir("GET", "/preferencias/mia", "GET /preferencias/mia")

    @task(1)
    def aviso(self):
        self.aviso_interno({"tipo": "ORDEN_RECIBIDA", "mensaje": "La orden OC-PERF se recibió completa."})
