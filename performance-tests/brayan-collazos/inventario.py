"""Pruebas I01 a I15: ms-inventario (Express + PostgreSQL). Los escenarios están en escenarios.py."""
import random
import uuid
from datetime import date, timedelta

from locust import between, task

import comun
from comun import UsuarioBase, clave, preparar, una_vez

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
            "POST", "/movimientos", nombre or f"POST /movimientos ({tipo})", esperados=(201,),
            headers={"Idempotency-Key": clave()},
            json={"tipo": tipo, "id_producto": producto or comun.ID_PRODUCTO, "id_bodega": bodega or comun.ID_BODEGA, "cantidad": cantidad, **extra},
        )


# ---------------- Consultas (RNF06) ----------------

class ListadoSaldos(UsuarioInventario):
    """I01"""

    @task
    def saldos(self):
        self.pedir("GET", f"/saldos?pagina={random.randint(1, 2)}&por_pagina=20", "GET /saldos")


class SaldosDeProducto(UsuarioInventario):
    """I02"""

    @task
    def por_producto(self):
        producto = random.choice([comun.ID_PRODUCTO, comun.ID_PRODUCTO_2])
        self.pedir("GET", f"/saldos?id_producto={producto}", "GET /saldos?id_producto")

    @task
    def por_bodega(self):
        self.pedir("GET", f"/saldos?id_bodega={random.choice([comun.ID_BODEGA, comun.ID_BODEGA_2])}&por_pagina=20", "GET /saldos?id_bodega")


class KardexConFiltros(UsuarioInventario):
    """I03"""

    @task(3)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 5)}&por_pagina=20", "GET /movimientos")

    @task(2)
    def por_tipo(self):
        self.pedir("GET", f"/movimientos?tipo={random.choice(['ENTRADA', 'SALIDA'])}&id_bodega={comun.ID_BODEGA}", "GET /movimientos?tipo&id_bodega")

    @task(2)
    def por_fechas(self):
        desde = (date.today() - timedelta(days=30)).isoformat()
        self.pedir("GET", f"/movimientos?fecha_desde={desde}&fecha_hasta={date.today().isoformat()}&id_producto={comun.ID_PRODUCTO}", "GET /movimientos?fechas&id_producto")


class LotesFefo(UsuarioInventario):
    """I04"""

    @task(2)
    def por_vencer(self):
        limite = (date.today() + timedelta(days=365)).isoformat()
        self.pedir("GET", f"/lotes?vence_antes_de={limite}&con_existencia=true&por_pagina=20", "GET /lotes?vence_antes_de")

    @task
    def de_un_producto(self):
        self.pedir("GET", f"/lotes?id_producto={comun.ID_PRODUCTO}&id_bodega={comun.ID_BODEGA}", "GET /lotes?id_producto&id_bodega")


class SugerenciaFefo(UsuarioInventario):
    """I05"""

    @task
    def sugerir(self):
        self.pedir(
            "GET", f"/lotes/sugerencia-salida?id_producto={comun.ID_PRODUCTO}&id_bodega={comun.ID_BODEGA}&cantidad={random.randint(1, 50)}",
            "GET /lotes/sugerencia-salida",
        )


class BodegasYUmbrales(UsuarioInventario):
    """I06"""

    @task(2)
    def bodegas(self):
        self.pedir("GET", "/bodegas", "GET /bodegas")

    @task
    def una_bodega(self):
        self.pedir("GET", f"/bodegas/{random.choice([comun.ID_BODEGA, comun.ID_BODEGA_2])}", "GET /bodegas/{id}")

    @task(2)
    def umbrales(self):
        self.pedir("GET", "/umbrales", "GET /umbrales")


class BajoUmbral(UsuarioInventario):
    """I07"""

    @task
    def bajo_umbral(self):
        self.pedir("GET", "/saldos/bajo-umbral", "GET /saldos/bajo-umbral")


class TrasladosYConteos(UsuarioInventario):
    """I08"""

    @task(2)
    def traslados(self):
        self.pedir("GET", "/traslados", "GET /traslados")

    @task
    def en_transito(self):
        self.pedir("GET", "/traslados?estado=EN_TRANSITO", "GET /traslados?estado")

    @task(2)
    def conteos(self):
        self.pedir("GET", "/conteos", "GET /conteos")


# ---------------- Escritura, idempotencia, contención e integración ----------------

class RegistrarEntradas(UsuarioInventario):
    """I09"""

    @task
    def entrada(self):
        self.movimiento("ENTRADA", random.randint(1, 20), documento_referencia="PERF")


class SalidasConFefo(UsuarioInventario):
    """I10: una salida (que consume el lote que vence primero) y una reposición, para no agotar el stock."""

    @task
    def salida_y_reposicion(self):
        cantidad = random.randint(1, 5)
        self.movimiento("SALIDA", cantidad)
        self.movimiento("ENTRADA", cantidad, nombre="POST /movimientos (ENTRADA de reposición)")


class IdempotenciaReintentos(UsuarioInventario):
    """I11: el mismo movimiento llega varias veces con la misma clave: solo el primero lo registra y los demás
    devuelven el original (200). Un reintento que no devuelve el mismo movimiento cuenta como error."""

    wait_time = between(0.5, 1)

    @task
    def con_reintentos(self):
        llave = clave()
        cuerpo = {"tipo": "ENTRADA", "id_producto": comun.ID_PRODUCTO, "id_bodega": comun.ID_BODEGA, "cantidad": 3}
        original = self.pedir("POST", "/movimientos", "POST /movimientos (primer intento)", esperados=(201,), headers={"Idempotency-Key": llave}, json=cuerpo)
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
    """I12: muchas salidas a la vez sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores."""

    wait_time = between(0.2, 0.5)

    @task
    def salida(self):
        self.movimiento("SALIDA", 1, nombre="POST /movimientos (SALIDA mismo saldo)", producto=comun.ID_PRODUCTO_2, bodega=comun.ID_BODEGA_2)


class CicloTraslado(UsuarioInventario):
    """I13: enviar un traslado y recibirlo (ms-inventario valida el producto con ms-catalogo)."""

    @task
    def traslado(self):
        creado = self.pedir(
            "POST", "/traslados", "POST /traslados", esperados=(201,), headers={"Idempotency-Key": clave()},
            json={"id_producto": comun.ID_PRODUCTO, "id_bodega_origen": comun.ID_BODEGA, "id_bodega_destino": comun.ID_BODEGA_2, "cantidad": 1},
        )
        if creado:
            self.pedir("POST", f"/traslados/{creado['id_traslado']}/recepcion", "POST /traslados/{id}/recepcion", esperados=(200, 201), headers={"Idempotency-Key": clave()}, json={})


# ---------------- Estrés y pico ----------------

class EstresConsultas(UsuarioInventario):
    """I14: de 0 a 200 usuarios, uno por segundo, con la mezcla de consultas más pesada, para hallar el punto de quiebre."""

    @task(3)
    def saldos(self):
        self.pedir("GET", "/saldos?por_pagina=20", "GET /saldos")

    @task(3)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 5)}&por_pagina=20", "GET /movimientos")

    @task
    def lotes(self):
        self.pedir("GET", f"/lotes?vence_antes_de={(date.today() + timedelta(days=365)).isoformat()}&con_existencia=true", "GET /lotes?vence_antes_de")


class PicoMixto(UsuarioInventario):
    """I15: 200 usuarios en 2 s con el uso típico: casi todo consultas y algún movimiento."""

    @task(8)
    def saldos(self):
        self.pedir("GET", "/saldos?por_pagina=20", "GET /saldos")

    @task(4)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /movimientos")

    @task(2)
    def bodegas(self):
        self.pedir("GET", "/bodegas", "GET /bodegas")

    @task(2)
    def entrada(self):
        self.movimiento("ENTRADA", random.randint(1, 10))
