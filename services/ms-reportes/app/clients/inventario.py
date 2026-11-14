"""Llamadas a ms-inventario (llamadas 6 y 7 de la Entrega 2)."""

from app.clients.base import ClienteServicio

_cliente = ClienteServicio("ms-inventario", "MS_INVENTARIO_URL")


def bodegas() -> list[dict]:
    """Todas las bodegas. Acepta la lista simple o la forma paginada {datos, meta}: la Entrega 2 solo dice
    «200 listado», y el sistema tiene pocas bodegas, así que basta con una página de 100."""
    respuesta = _cliente.get("/bodegas", params={"pagina": 1, "por_pagina": 100})
    return respuesta["datos"] if isinstance(respuesta, dict) else respuesta


def carga_inicial(filas: list[dict], clave_idempotencia: str) -> dict:
    """Carga inicial de saldos. Lleva Idempotency-Key, así que se puede reintentar sin duplicar movimientos (RNF17)."""
    return _cliente.post("/internas/saldos/carga-inicial", {"filas": filas},
                         cabeceras={"Idempotency-Key": clave_idempotencia}, reintentar=True)
