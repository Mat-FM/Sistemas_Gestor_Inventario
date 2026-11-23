"""Llamadas a ms-inventario (llamadas 6 y 7 de la Entrega 2).

Los nombres de los campos son los atributos del modelo de ms-inventario (Figura 5 de la Entrega 2), como dice la
sección 4 del contrato. Los listados paginados se piden completos, de 100 en 100.
"""

import hashlib
import json

from flask import current_app

from app.clients.base import ClienteServicio, DemasiadosElementos
from app.errores import ApiError

_cliente = ClienteServicio("ms-inventario", "MS_INVENTARIO_URL")

# La carga inicial aplica cada fila en su propia transacción: unos 5 ms por fila en local (README de ms-inventario).
# Por eso su plazo es CALL_TIMEOUT_SECONDS más 10 ms por fila (1 000 filas: 13 s).
SEGUNDOS_POR_FILA = 0.01


def bodegas() -> list[dict]:
    """Todas las bodegas. GET /bodegas pagina como los demás listados, así que se recorren todas las páginas."""
    return _cliente.todas_las_paginas("/bodegas")


def saldos(id_bodega: int | None = None) -> list[dict]:
    """Saldos por producto y bodega: [{id_producto, id_bodega, cantidad_disponible, ...}]."""
    return _cliente.todas_las_paginas("/saldos", _sin_vacios({"id_bodega": id_bodega}))


def saldos_bajo_umbral() -> list[dict]:
    """[{id_producto, cantidad_total, cantidad_minima}] (RF09)."""
    return _cliente.get("/saldos/bajo-umbral")


def movimientos(filtros: dict) -> list[dict]:
    """El kardex con los filtros de GET /movimientos (id_producto, id_bodega, id_usuario, tipo, fecha_desde,
    fecha_hasta), del más reciente al más antiguo. Se piden de 100 en 100 y con muchos movimientos no se llega a
    responder antes de que el Gateway se rinda (3 s): pasado KARDEX_MAX_FILAS se pide acotar la consulta (422)."""
    try:
        return _cliente.todas_las_paginas("/movimientos", _sin_vacios(filtros),
                                          maximo=current_app.config["KARDEX_MAX_FILAS"])
    except DemasiadosElementos as e:
        raise ApiError.datos_no_validos([{"campo": "filtros", "mensaje": (
            f"El kardex tiene {e.total} movimientos y el máximo por consulta es {e.maximo}: "
            "acote por producto, bodega, tipo o fechas.")}]) from e


def lotes(vence_antes_de: str) -> list[dict]:
    """Lotes con existencia que vencen antes de la fecha, del que vence primero al último (RF17)."""
    return _cliente.todas_las_paginas("/lotes", {"vence_antes_de": vence_antes_de, "con_existencia": "true"})


def carga_inicial(filas: list[dict]) -> dict:
    """Carga inicial de saldos (como máximo 1 000 filas por llamada). Lleva Idempotency-Key, así que se puede
    reintentar sin duplicar movimientos (RNF17).

    La clave se deriva del contenido de las filas: si se vuelve a subir un archivo que ya se aplicó, el bloque llega
    con la misma clave y ms-inventario lo reconoce como repetición en lugar de sumar otra vez los saldos. ms-inventario
    reconoce la repetición por clave y usuario: si otro usuario sube el mismo archivo, sí se suma.
    """
    contenido = json.dumps(filas, sort_keys=True, ensure_ascii=False).encode("utf-8")
    clave = "carga-inicial-" + hashlib.sha256(contenido).hexdigest()
    espera = current_app.config["CALL_TIMEOUT_SECONDS"] + SEGUNDOS_POR_FILA * len(filas)
    return _cliente.post("/internas/saldos/carga-inicial", {"filas": filas},
                         cabeceras={"Idempotency-Key": clave}, reintentar=True, espera=espera)


def _sin_vacios(filtros: dict) -> dict:
    return {clave: valor for clave, valor in filtros.items() if valor is not None}
