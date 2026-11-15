"""Llamadas a ms-inventario (llamadas 6 y 7 de la Entrega 2).

Los nombres de los campos son los atributos del modelo de ms-inventario (Figura 5 de la Entrega 2), como dice la
sección 4 del contrato. Los listados paginados se piden completos, de 100 en 100.
"""

from app.clients.base import ClienteServicio

_cliente = ClienteServicio("ms-inventario", "MS_INVENTARIO_URL")


def bodegas() -> list[dict]:
    """Todas las bodegas. Acepta la lista simple o la forma paginada {datos, meta}: la Entrega 2 solo dice
    «200 listado», y el sistema tiene pocas bodegas, así que basta con una página de 100."""
    respuesta = _cliente.get("/bodegas", params={"pagina": 1, "por_pagina": 100})
    return respuesta["datos"] if isinstance(respuesta, dict) else respuesta


def saldos(id_bodega: int | None = None) -> list[dict]:
    """Saldos por producto y bodega: [{id_producto, id_bodega, cantidad_disponible, ...}]."""
    return _cliente.todas_las_paginas("/saldos", _sin_vacios({"id_bodega": id_bodega}))


def saldos_bajo_umbral() -> list[dict]:
    """[{id_producto, cantidad_total, cantidad_minima}] (RF09)."""
    return _cliente.get("/saldos/bajo-umbral")


def movimientos(filtros: dict) -> list[dict]:
    """El kardex con los filtros de GET /movimientos (id_producto, id_bodega, id_usuario, tipo, fecha_desde,
    fecha_hasta), del más reciente al más antiguo."""
    return _cliente.todas_las_paginas("/movimientos", _sin_vacios(filtros))


def lotes(vence_antes_de: str) -> list[dict]:
    """Lotes con existencia que vencen antes de la fecha, del que vence primero al último (RF17)."""
    return _cliente.todas_las_paginas("/lotes", {"vence_antes_de": vence_antes_de, "con_existencia": "true"})


def carga_inicial(filas: list[dict], clave_idempotencia: str) -> dict:
    """Carga inicial de saldos. Lleva Idempotency-Key, así que se puede reintentar sin duplicar movimientos (RNF17)."""
    return _cliente.post("/internas/saldos/carga-inicial", {"filas": filas},
                         cabeceras={"Idempotency-Key": clave_idempotencia}, reintentar=True)


def _sin_vacios(filtros: dict) -> dict:
    return {clave: valor for clave, valor in filtros.items() if valor is not None}
