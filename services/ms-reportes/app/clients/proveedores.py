"""Llamadas a ms-proveedores (llamada 7 de la Entrega 2)."""

from app.clients.base import ClienteServicio

_cliente = ClienteServicio("ms-proveedores", "MS_PROVEEDORES_URL")


def crear_proveedores(filas: list[dict]) -> dict:
    """Carga masiva interna. No se reintenta: repetirla rechazaría como duplicadas las filas ya creadas."""
    return _cliente.post("/internas/proveedores/lote", {"filas": filas})
