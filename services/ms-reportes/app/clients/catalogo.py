"""Llamadas a ms-catalogo (llamadas 6 y 7 de la Entrega 2)."""

from app.clients.base import ClienteServicio

_cliente = ClienteServicio("ms-catalogo", "MS_CATALOGO_URL")

_POR_PAGINA = 100


def categorias() -> list[dict]:
    """Todas las categorías y subcategorías, en una lista simple (GET /categorias no se pagina)."""
    return _cliente.get("/categorias")


def productos() -> list[dict]:
    """Todos los productos, pidiendo las páginas de 100 en 100."""
    todos = []
    pagina = 1
    while True:
        respuesta = _cliente.get("/productos", params={"pagina": pagina, "por_pagina": _POR_PAGINA})
        todos.extend(respuesta["datos"])
        if pagina * _POR_PAGINA >= respuesta["meta"]["total"]:
            return todos
        pagina += 1


def crear_productos(filas: list[dict]) -> dict:
    """Carga masiva interna. No se reintenta: repetirla rechazaría como duplicadas las filas ya creadas."""
    return _cliente.post("/internas/productos/lote", {"filas": filas})
