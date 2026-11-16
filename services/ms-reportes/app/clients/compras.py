"""Llamadas a ms-compras (llamada 6 de la Entrega 2)."""

from app.clients.base import ClienteServicio, ServicioNoDisponible

_cliente = ClienteServicio("ms-compras", "MS_COMPRAS_URL")


def contar_ordenes(estado: str) -> int:
    """Cuántas órdenes de compra hay en ese estado. Basta con el total del listado paginado (una orden por página)."""
    respuesta = _cliente.get("/ordenes-compra", params={"estado": estado, "pagina": 1, "por_pagina": 1})
    try:
        return int(respuesta["meta"]["total"])
    except (KeyError, TypeError, ValueError):
        raise ServicioNoDisponible("ms-compras")
