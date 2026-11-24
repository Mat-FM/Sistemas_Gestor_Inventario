"""Pruebas I01 a I06: ms-inventario (Express + PostgreSQL). Los escenarios están en escenarios.py."""
import random
import uuid
from datetime import date, timedelta

from locust import between, task

import comun
from comun import UsuarioBase, clave, movimiento_registrado, paginado, paginado_de, preparar, una_vez

MOVIMIENTOS_DE_HISTORIA = 200
STOCK_INICIAL = 1_000_000


def _datos():
    """Stock abundante en las dos bodegas (con un lote), un mínimo alto para que haya productos bajo el umbral y 200
    movimientos de historia para que el kardex y los saldos devuelvan datos reales. No cuenta en las mediciones."""
    corrida = uuid.uuid4().hex[:8]
    vence = (date.today() + timedelta(days=120)).isoformat()
    for bodega in (comun.ID_BODEGA, comun.ID_BODEGA_2):
        for producto in (comun.ID_PRODUCTO, comun.ID_PRODUCTO_2):
            preparar(
                "POST", "/movimientos", headers={"Idempotency-Key": clave()},
                json={"tipo": "ENTRADA", "id_producto": producto, "id_bodega": bodega, "cantidad": STOCK_INICIAL,
                      "lote": {"codigo_lote": f"PERF-{corrida}-{producto}-{bodega}", "fecha_vencimiento": vence}},
            )
    preparar("PUT", f"/umbrales/{comun.ID_PRODUCTO_2}", json={"cantidad_minima": 2_000_000_000})
    for i in range(MOVIMIENTOS_DE_HISTORIA):
        preparar(
            "POST", "/movimientos", headers={"Idempotency-Key": clave()},
            json={"tipo": "SALIDA" if i % 2 else "ENTRADA", "id_producto": comun.ID_PRODUCTO, "id_bodega": comun.ID_BODEGA, "cantidad": 1 + i % 5},
        )
    return {"corrida": corrida}


class UsuarioInventario(UsuarioBase):
    abstract = True

    def on_start(self):
        super().on_start()
        una_vez("datos", _datos)

    def movimiento(self, tipo, cantidad, nombre=None, producto=None, bodega=None, **extra):
        return self.pedir(
            "POST", "/movimientos", nombre or f"POST /movimientos ({tipo})", esperados=(201,), validar=movimiento_registrado,
            headers={"Idempotency-Key": clave()},
            json={"tipo": tipo, "id_producto": producto or comun.ID_PRODUCTO, "id_bodega": bodega or comun.ID_BODEGA, "cantidad": cantidad, **extra},
        )


# ---------------- Consultas (RNF06) ----------------

class ListadoSaldos(UsuarioInventario):
    """I01"""

    @task
    def saldos(self):
        pagina = random.randint(1, 2)
        self.pedir("GET", f"/saldos?pagina={pagina}&por_pagina=20", "GET /saldos", validar=paginado_de(pagina))


class KardexConFiltros(UsuarioInventario):
    """I02"""

    @task(3)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 5)}&por_pagina=20", "GET /movimientos", validar=paginado)

    @task(2)
    def por_tipo(self):
        self.pedir("GET", f"/movimientos?tipo={random.choice(['ENTRADA', 'SALIDA'])}&id_bodega={comun.ID_BODEGA}", "GET /movimientos?tipo&id_bodega",
                   validar=paginado)

    @task(2)
    def por_fechas(self):
        desde = (date.today() - timedelta(days=30)).isoformat()
        self.pedir("GET", f"/movimientos?fecha_desde={desde}&fecha_hasta={date.today().isoformat()}&id_producto={comun.ID_PRODUCTO}", "GET /movimientos?fechas&id_producto",
                   validar=paginado)


class LotesFefo(UsuarioInventario):
    """I03"""

    @task(2)
    def por_vencer(self):
        limite = (date.today() + timedelta(days=365)).isoformat()
        self.pedir("GET", f"/lotes?vence_antes_de={limite}&con_existencia=true&por_pagina=20", "GET /lotes?vence_antes_de", validar=paginado)

    @task
    def de_un_producto(self):
        self.pedir("GET", f"/lotes?id_producto={comun.ID_PRODUCTO}&id_bodega={comun.ID_BODEGA}", "GET /lotes?id_producto&id_bodega", validar=paginado)


# ---------------- Escritura, idempotencia, contención e integración ----------------

class RegistrarEntradas(UsuarioInventario):
    """I04"""

    @task
    def entrada(self):
        self.movimiento("ENTRADA", random.randint(1, 20), documento_referencia="PERF")


class IdempotenciaReintentos(UsuarioInventario):
    """I05: el mismo movimiento llega varias veces con la misma clave: solo el primero lo registra y los demás
    devuelven el original (200). Un reintento que no devuelve el mismo movimiento cuenta como error."""

    wait_time = between(0.5, 1)

    @task
    def con_reintentos(self):
        llave = clave()
        cuerpo = {"tipo": "ENTRADA", "id_producto": comun.ID_PRODUCTO, "id_bodega": comun.ID_BODEGA, "cantidad": 3}
        original = self.pedir("POST", "/movimientos", "POST /movimientos (primer intento)", esperados=(201,),
                              validar=movimiento_registrado, headers={"Idempotency-Key": llave}, json=cuerpo)
        for _ in range(random.randint(1, 2)):
            cabeceras = {**self.cabeceras, "Idempotency-Key": llave}
            with self.client.post(f"{self.prefijo}/movimientos", name="POST /movimientos (reintento)", json=cuerpo, headers=cabeceras, catch_response=True) as r:
                if r.status_code != 200:
                    r.failure(f"el reintento debía responder 200 y respondió {r.status_code}")
                elif original is not None and r.json().get("id_movimiento") != original.get("id_movimiento"):
                    r.failure("el reintento devolvió otro movimiento (se duplicó)")
                else:
                    r.success()


class SalidasMismoSaldo(UsuarioInventario):
    """I06: muchas salidas a la vez sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores."""

    wait_time = between(0.2, 0.5)

    @task
    def salida(self):
        self.movimiento("SALIDA", 1, nombre="POST /movimientos (SALIDA mismo saldo)", producto=comun.ID_PRODUCTO_2, bodega=comun.ID_BODEGA_2)
