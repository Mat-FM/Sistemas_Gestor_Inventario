"""Llamada 5 de la Tabla 2: ms-notificaciones → ms-inventario, GET /lotes y GET /saldos/bajo-umbral
(espera respuesta). La usa solo la revisión diaria: si inventario no responde, la revisión registra
el fallo y termina, y el resto del servicio sigue funcionando."""
from .http import ClienteHttp, ServicioNoDisponible

_POR_PAGINA = 100
# Tope de seguridad: 50 páginas de 100 lotes.
_MAX_PAGINAS = 50

cliente = None


def iniciar(config):
    global cliente
    cliente = ClienteHttp(
        "ms-inventario",
        config.inventario_url,
        timeout_s=config.timeout_s,
        esperas_reintento_s=config.esperas_reintento_s,
        fallos_para_abrir=config.fallos_para_abrir,
        tiempo_abierto_s=config.tiempo_abierto_s,
    )
    return cliente


def _datos(status, cuerpo, ruta):
    if status != 200:
        raise ServicioNoDisponible("ms-inventario", f"{ruta} respondió {status}")
    if isinstance(cuerpo, list):
        return cuerpo, None
    if isinstance(cuerpo, dict) and isinstance(cuerpo.get("datos"), list):
        return cuerpo["datos"], cuerpo.get("meta")
    raise ServicioNoDisponible("ms-inventario", f"{ruta} devolvió una respuesta sin lista de datos")


def lotes_por_vencer(vence_antes_de, request_id):
    """Lotes con existencia que vencen antes de la fecha (AAAA-MM-DD), recorriendo todas las páginas."""
    lotes = []
    for pagina in range(1, _MAX_PAGINAS + 1):
        status, cuerpo = cliente.get(
            "/lotes",
            {"vence_antes_de": vence_antes_de, "con_existencia": "true", "pagina": pagina, "por_pagina": _POR_PAGINA},
            cabeceras={"X-Request-Id": request_id},
        )
        datos, meta = _datos(status, cuerpo, "/lotes")
        lotes.extend(datos)
        total = (meta or {}).get("total")
        if not datos or len(datos) < _POR_PAGINA or (total is not None and len(lotes) >= total):
            break
    return lotes


def saldos_bajo_umbral(request_id):
    """[{id_producto, cantidad_total, cantidad_minima}] de los productos por debajo de su umbral."""
    status, cuerpo = cliente.get("/saldos/bajo-umbral", cabeceras={"X-Request-Id": request_id})
    datos, _meta = _datos(status, cuerpo, "/saldos/bajo-umbral")
    return datos
