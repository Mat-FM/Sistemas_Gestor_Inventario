"""Pruebas M01 (carga), E01 (estrés) y S01 (capacidad): la MISMA mezcla de operaciones sobre ms-catalogo, ms-proveedores y ms-reportes, como
pide la guía del taller (Albeiro Montes): GET predominante (~85 %) y POST minoritario (~15 %). Solo cambia cuántos usuarios, a qué ritmo
entran y cuánto dura (escenarios.py):

- M01 carga: 50 usuarios en meseta, para ver el comportamiento nominal frente a RNF06.
- E01 estrés: una rampa agresiva hasta 300 usuarios, para registrar en qué concurrencia y RPS se quiebra (resumen.py lo calcula).
- S01 capacidad: una carga cercana al máximo estable, sostenida, para ver si hay degradación con el tiempo (resumen.py compara el principio
  y el final).

Las escrituras de la mezcla son altas de proveedores e importaciones de stock: NO dan de alta productos, para que el catálogo no crezca
durante la prueba (los reportes lo recorren entero) y una degradación en S01 sea del sistema y no de tener más datos.
"""
import io
import random

from locust import task

import catalogo
import reportes
from comun import UsuarioBase, host, sufijo, una_vez
from proveedores import _proveedor


class UsuarioMixto(UsuarioBase):
    abstract = True
    # En modo directo cada petición indica su servicio; en modo gateway todas van al Gateway.
    host = host("catalogo")

    def on_start(self):
        super().on_start()
        self.catalogo = una_vez("catalogo", catalogo._datos)
        self.reportes = una_vez("reportes", reportes._datos)

    # ---------- GET (~85 %) ----------

    @task(4)
    def listado_productos(self):
        self.pedir("GET", f"/productos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /productos", servicio="catalogo", validar=catalogo.paginado)

    @task(3)
    def un_producto(self):
        self.pedir("GET", f"/productos/{random.choice(self.catalogo['productos'])['id']}", "GET /productos/{id}", servicio="catalogo")

    @task(2)
    def busqueda(self):
        self.pedir("GET", f"/productos?nombre={random.choice(catalogo.FRAGMENTOS)}&por_pagina=20", "GET /productos?nombre", servicio="catalogo",
                   validar=catalogo.paginado)

    @task(2)
    def filtro_por_proveedor(self):
        self.pedir("GET", f"/productos?id_proveedor={random.choice(self.catalogo['proveedores'])}&por_pagina=20", "GET /productos?id_proveedor",
                   servicio="catalogo", validar=catalogo.productos_del_proveedor)

    @task(2)
    def listado_proveedores(self):
        self.pedir("GET", f"/proveedores?pagina={random.randint(1, 2)}&por_pagina=20", "GET /proveedores", servicio="proveedores",
                   validar=catalogo.paginado)

    @task(2)
    def productos_del_proveedor(self):
        self.pedir("GET", f"/proveedores/{random.choice(self.catalogo['proveedores'])}/productos", "GET /proveedores/{id}/productos",
                   servicio="proveedores", validar=reportes.lista)

    @task(1)
    def existencias(self):
        self.pedir("GET", "/reportes/existencias", "GET /reportes/existencias", servicio="reportes", validar=reportes.lista)

    @task(1)
    def kardex(self):
        self.pedir("GET", f"/reportes/kardex?id_producto={random.choice(self.reportes['productos'])}", "GET /reportes/kardex?id_producto",
                   servicio="reportes", validar=reportes.lista)

    @task(1)
    def indicadores(self):
        self.pedir("GET", "/indicadores", "GET /indicadores", servicio="reportes")

    # ---------- POST (~15 %) ----------

    @task(2)
    def alta_de_proveedor(self):
        self.pedir("POST", "/proveedores", "POST /proveedores", esperados=(201,), servicio="proveedores",
                   json=_proveedor("Mezcla", sufijo(), random.randint(0, 999)))

    @task(1)
    def importacion(self):
        self.pedir(
            "POST", "/importaciones", "POST /importaciones (STOCK_INICIAL)", esperados=(201,), servicio="reportes",
            validar=reportes.importacion_procesada, data={"tipo": "STOCK_INICIAL"},
            files={"archivo": ("stock-inicial.csv", io.BytesIO(reportes.archivo_stock_inicial(self.reportes)), "text/csv")},
        )


class CargaMixta(UsuarioMixto):
    """M01: carga nominal (50 usuarios en meseta)."""


class EstresMixto(UsuarioMixto):
    """E01: estrés (rampa agresiva hasta 300 usuarios)."""


class CapacidadMixta(UsuarioMixto):
    """S01: capacidad o soak (carga cercana al máximo estable, sostenida)."""
