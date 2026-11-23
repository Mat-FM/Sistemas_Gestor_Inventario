"""Pruebas M01 (carga), E01 (estrés) y S01 (capacidad): la MISMA mezcla de operaciones por el API Gateway hacia ms-inventario y
ms-catalogo, como pide la guía del taller (Albeiro Montes): GET predominante (~85 %) y POST minoritario (~15 %). Solo cambia cuántos
usuarios, a qué ritmo entran y cuánto dura (escenarios.py):

- M01 carga: 50 usuarios en meseta, para ver el comportamiento nominal frente a RNF06.
- E01 estrés: una rampa agresiva hasta 300 usuarios, para registrar en qué concurrencia y RPS se quiebra (resumen.py lo calcula).
- S01 capacidad: una carga cercana al máximo estable, sostenida, para ver si hay degradación con el tiempo (resumen.py compara el principio
  y el final).

Van SIEMPRE por el Gateway (como las pruebas G), porque el Gateway es parte de lo que se mide y el usuario real nunca llama a un servicio
directo. Las escrituras son entradas y salidas de mercancía sobre stock abundante (1 000 000 de unidades por producto y bodega): en una
hora de S01 no lo agotan, así que un 409 STOCK_INSUFICIENTE sería un defecto y no el fin de las existencias.
"""
import random
from datetime import date, timedelta

from locust import task

import comun
from comun import clave, movimiento_registrado, paginado, paginado_de
from gateway import UsuarioGateway


class UsuarioMixto(UsuarioGateway):
    abstract = True

    def movimiento(self, tipo, cantidad):
        bodega = random.choice([comun.ID_BODEGA, comun.ID_BODEGA_2])
        return self.pedir(
            "POST", "/movimientos", f"POST /api/movimientos ({tipo})", esperados=(201,), validar=movimiento_registrado,
            headers={"Idempotency-Key": clave()},
            json={"tipo": tipo, "id_producto": comun.ID_PRODUCTO, "id_bodega": bodega, "cantidad": cantidad},
        )

    # ---------- GET (~85 %: 17 de 20) ----------

    @task(5)
    def saldos(self):
        pagina = random.randint(1, 2)
        self.pedir("GET", f"/saldos?pagina={pagina}&por_pagina=20", "GET /api/saldos", validar=paginado_de(pagina))

    @task(4)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 5)}&por_pagina=20", "GET /api/movimientos", validar=paginado)

    @task(3)
    def productos(self):
        self.pedir("GET", "/productos?por_pagina=20", "GET /api/productos", validar=paginado)

    @task(2)
    def lotes_por_vencer(self):
        limite = (date.today() + timedelta(days=365)).isoformat()
        self.pedir("GET", f"/lotes?vence_antes_de={limite}&con_existencia=true&por_pagina=20", "GET /api/lotes?vence_antes_de", validar=paginado)

    @task(1)
    def busqueda(self):
        self.pedir("GET", f"/productos?nombre={random.choice(['Caf', 'Jug', 'Pan', 'Gal'])}&por_pagina=10", "GET /api/productos?nombre",
                   validar=lambda c: paginado(c, vacio_ok=True))

    @task(1)
    def usuarios(self):
        self.pedir("GET", "/usuarios?por_pagina=20", "GET /api/usuarios", validar=paginado)

    @task(1)
    def bodegas(self):
        self.pedir("GET", "/bodegas", "GET /api/bodegas", validar=paginado)

    # ---------- POST (~15 %: 3 de 20) ----------

    @task(2)
    def entrada(self):
        self.movimiento("ENTRADA", random.randint(1, 10))

    @task(1)
    def salida(self):
        self.movimiento("SALIDA", random.randint(1, 3))


class CargaMixta(UsuarioMixto):
    """M01: carga nominal (50 usuarios en meseta)."""


class EstresMixto(UsuarioMixto):
    """E01: estrés (rampa agresiva hasta 300 usuarios)."""


class CapacidadMixta(UsuarioMixto):
    """S01: capacidad o soak (carga cercana al máximo estable, sostenida)."""
