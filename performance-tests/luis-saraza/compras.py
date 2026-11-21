"""Pruebas C01 a C09: ms-compras (Express + PostgreSQL). Los escenarios están en escenarios.py."""
import random
import uuid
from datetime import date, timedelta

from locust import task

import comun
from comun import UsuarioBase, orden_base, preparar, una_vez

ESTADOS = ["CREADA", "ENVIADA", "RECIBIDA_PARCIAL", "RECIBIDA", "ANULADA"]
ORDENES_DE_PRUEBA = 40


def _recibir(id_orden, id_detalle, cantidad, lote=None):
    linea = {"id_detalle": id_detalle, "cantidad": cantidad}
    if lote:
        linea.update(codigo_lote=lote, fecha_vencimiento=(date.today() + timedelta(days=90)).isoformat())
    return preparar(
        "POST", "compras", f"/ordenes-compra/{id_orden}/recepciones",
        json={"lineas": [linea]}, headers={"Idempotency-Key": f"perf-prep-{uuid.uuid4()}"},
    )


def _datos_de_consulta():
    """Órdenes en todos los estados, algunas con recepciones y una devolución, para que las consultas lean datos reales.
    Las recepciones necesitan ms-inventario y ms-catalogo: si no responden, se sigue sin ellas."""
    corrida = uuid.uuid4().hex[:8]  # lotes nuevos en cada corrida: uno repetido con otra fecha responde 409
    ids = []
    con_recepciones = []
    for i in range(ORDENES_DE_PRUEBA):
        orden = preparar("POST", "compras", "/ordenes-compra", json=orden_base(cantidad=10))
        ids.append(orden["id_orden"])
        if i % 4 == 0:
            continue  # queda CREADA
        preparar("PATCH", "compras", f"/ordenes-compra/{orden['id_orden']}/estado", json={"estado": "ENVIADA"})
        if i % 4 == 1:
            continue  # queda ENVIADA
        try:
            _recibir(orden["id_orden"], orden["detalles"][0]["id_detalle"], 10 if i % 4 == 3 else 4, lote=f"PERF-{corrida}-{i}")
            con_recepciones.append(orden["id_orden"])
        except RuntimeError as error:
            print(f"[preparación] sin recepciones: {error}")
            break
    if con_recepciones:
        try:
            preparar(
                "POST", "compras", "/devoluciones-proveedor",
                json={"id_proveedor": comun.ID_PROVEEDOR, "id_producto": comun.ID_PRODUCTO, "id_bodega": comun.ID_BODEGA,
                      "cantidad": 1, "motivo": "Prueba de rendimiento", "id_orden": con_recepciones[0]},
                headers={"Idempotency-Key": f"perf-prep-{uuid.uuid4()}"},
            )
        except RuntimeError as error:
            print(f"[preparación] sin devolución: {error}")
    return {"ordenes": ids, "con_recepciones": con_recepciones or ids}


class UsuarioCompras(UsuarioBase):
    abstract = True
    host = comun.host_de("compras")

    def datos(self):
        return una_vez("compras-consultas", _datos_de_consulta)


class ListadoOrdenes(UsuarioCompras):
    """C01: la consulta que más usan el administrador y el operador."""

    @task
    def listar(self):
        self.pedir("GET", f"/ordenes-compra?pagina={random.randint(1, 2)}&por_pagina=20", "GET /ordenes-compra")


class FiltrosOrdenes(UsuarioCompras):
    """C02: cada filtro cambia el plan de la consulta (índices por estado, bodega y fecha)."""

    def on_start(self):
        super().on_start()
        self.datos()

    @task(3)
    def por_estado(self):
        self.pedir("GET", f"/ordenes-compra?estado={random.choice(ESTADOS)}", "GET /ordenes-compra?estado")

    @task(2)
    def por_bodega_y_proveedor(self):
        self.pedir(
            "GET", f"/ordenes-compra?id_bodega_destino={comun.ID_BODEGA}&id_proveedor={comun.ID_PROVEEDOR}",
            "GET /ordenes-compra?id_bodega_destino&id_proveedor",
        )

    @task(1)
    def por_fechas(self):
        hoy = date.today()
        self.pedir(
            "GET", f"/ordenes-compra?fecha_desde={(hoy - timedelta(days=30)).isoformat()}&fecha_hasta={hoy.isoformat()}",
            "GET /ordenes-compra?fecha_desde&fecha_hasta",
        )


class DetalleOrden(UsuarioCompras):
    """C03: la orden con sus líneas y recepciones (tres consultas en el servicio)."""

    def on_start(self):
        super().on_start()
        self.ids = self.datos()["ordenes"]

    @task
    def detalle(self):
        self.pedir("GET", f"/ordenes-compra/{random.choice(self.ids)}", "GET /ordenes-compra/{id}")


class RecepcionesDeOrden(UsuarioCompras):
    """C04: lo que se recibió de una orden."""

    def on_start(self):
        super().on_start()
        self.ids = self.datos()["con_recepciones"]

    @task
    def recepciones(self):
        self.pedir("GET", f"/ordenes-compra/{random.choice(self.ids)}/recepciones", "GET /ordenes-compra/{id}/recepciones")


class ListadoDevoluciones(UsuarioCompras):
    """C05: devoluciones a proveedor, con y sin filtro."""

    def on_start(self):
        super().on_start()
        self.datos()

    @task(2)
    def todas(self):
        self.pedir("GET", "/devoluciones-proveedor", "GET /devoluciones-proveedor")

    @task(1)
    def por_proveedor(self):
        self.pedir("GET", f"/devoluciones-proveedor?id_proveedor={comun.ID_PROVEEDOR}", "GET /devoluciones-proveedor?id_proveedor")


class CrearOrdenes(UsuarioCompras):
    """C06: crear órdenes a la vez. El número consecutivo (OC-0001...) sale de una secuencia de PostgreSQL:
    ningún número se repite aunque 50 usuarios creen órdenes al mismo tiempo."""

    @task
    def crear(self):
        orden = orden_base(cantidad=random.randint(1, 50))
        self.pedir("POST", "/ordenes-compra", "POST /ordenes-compra", esperados=(201,), json=orden)


class CicloCompleto(UsuarioCompras):
    """C07: el flujo de la demo. La recepción espera a ms-inventario (que consulta a ms-catalogo) y avisa a
    ms-notificaciones: mide la comunicación entre servicios bajo carga."""

    @task
    def ciclo(self):
        orden = self.pedir("POST", "/ordenes-compra", "C07 1. POST /ordenes-compra", esperados=(201,), json=orden_base(cantidad=6))
        if not orden:
            return
        id_orden = orden["id_orden"]
        if self.pedir("PATCH", f"/ordenes-compra/{id_orden}/estado", "C07 2. PATCH /ordenes-compra/{id}/estado",
                      json={"estado": "ENVIADA"}) is None:
            return
        linea = {
            "id_detalle": orden["detalles"][0]["id_detalle"],
            "cantidad": 6,
            "codigo_lote": f"PERF-{uuid.uuid4().hex[:10]}",
            "fecha_vencimiento": (date.today() + timedelta(days=120)).isoformat(),
        }
        self.pedir(
            "POST", f"/ordenes-compra/{id_orden}/recepciones", "C07 3. POST /ordenes-compra/{id}/recepciones",
            esperados=(201,), json={"lineas": [linea]}, headers={"Idempotency-Key": f"perf-{uuid.uuid4()}"},
        )
        self.pedir("GET", f"/ordenes-compra/{id_orden}", "C07 4. GET /ordenes-compra/{id}")


def _orden_grande():
    """Una sola orden enviada con mucha cantidad pendiente: todos los usuarios de C08 reciben sobre ella."""
    orden = preparar("POST", "compras", "/ordenes-compra", json=orden_base(cantidad=1_000_000))
    preparar("PATCH", "compras", f"/ordenes-compra/{orden['id_orden']}/estado", json={"estado": "ENVIADA"})
    return {"id_orden": orden["id_orden"], "id_detalle": orden["detalles"][0]["id_detalle"]}


class RecepcionesConcurrentes(UsuarioCompras):
    """C08: el candado por orden serializa las recepciones de la misma orden para que nunca se reciba más de lo
    pedido. Mide cuánto esperan las peticiones en la fila del candado."""

    def on_start(self):
        super().on_start()
        self.orden = una_vez("compras-orden-grande", _orden_grande)

    @task
    def recibir(self):
        self.pedir(
            "POST", f"/ordenes-compra/{self.orden['id_orden']}/recepciones",
            "POST /ordenes-compra/{id}/recepciones (misma orden)", esperados=(201,),
            json={"lineas": [{"id_detalle": self.orden["id_detalle"], "cantidad": 1}]},
            headers={"Idempotency-Key": f"perf-{uuid.uuid4()}"},
        )


class EstresListado(UsuarioCompras):
    """C09: las consultas de C01 a C03 juntas, con usuarios que llegan sin parar hasta 200."""

    def on_start(self):
        super().on_start()
        self.ids = self.datos()["ordenes"]

    @task(3)
    def listar(self):
        self.pedir("GET", "/ordenes-compra", "GET /ordenes-compra")

    @task(2)
    def detalle(self):
        self.pedir("GET", f"/ordenes-compra/{random.choice(self.ids)}", "GET /ordenes-compra/{id}")

    @task(1)
    def filtrar(self):
        self.pedir("GET", f"/ordenes-compra?estado={random.choice(ESTADOS)}", "GET /ordenes-compra?estado")
