"""Pruebas K01 a K06: ms-catalogo (Laravel + MySQL). Los escenarios están en escenarios.py."""
import random

from locust import task

import comun
from comun import UsuarioBase, host, preparar, sufijo, una_vez

PRODUCTOS_DE_PRUEBA = 60
FRAGMENTOS = ["Prueba", "Café", "Lote", "PERF", "Producto"]


def _datos():
    """Una categoría con una subcategoría y 60 productos para que los listados, las búsquedas y los filtros devuelvan datos reales
    (el listado pagina de 20 en 20). No cuenta en las mediciones."""
    corrida = sufijo()
    categoria = preparar("catalogo", "POST", "/categorias", json={"nombre": f"PERF {corrida}"})
    preparar("catalogo", "POST", "/categorias", json={"nombre": f"PERF {corrida} sub", "id_categoria_padre": categoria["id_categoria"]})
    productos = []
    for i in range(PRODUCTOS_DE_PRUEBA):
        producto = preparar(
            "catalogo", "POST", "/productos",
            json={"codigo": f"PERF-{corrida}-{i}", "nombre": f"Producto de prueba {i} {corrida}", "descripcion": "Para las pruebas de rendimiento",
                  "id_categoria": categoria["id_categoria"], "unidad_medida": "UNIDAD", "precio": 1000 + i},
        )
        productos.append({"id": producto["id_producto"], "codigo": producto["codigo"]})
    return {"corrida": corrida, "categoria": categoria["id_categoria"], "productos": productos}


class UsuarioCatalogo(UsuarioBase):
    abstract = True
    host = host("catalogo")

    def on_start(self):
        super().on_start()
        self.datos = una_vez("catalogo", _datos)

    def un_producto(self):
        return random.choice(self.datos["productos"])


# ---------------- Consultas (RNF06) ----------------

class ListadoProductos(UsuarioCatalogo):
    """K01"""

    @task
    def listado(self):
        self.pedir("GET", f"/productos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /productos")


class BusquedaDeProductos(UsuarioCatalogo):
    """K02"""

    @task(3)
    def por_nombre(self):
        self.pedir("GET", f"/productos?nombre={random.choice(FRAGMENTOS)}&por_pagina=20", "GET /productos?nombre")

    @task(2)
    def por_codigo(self):
        self.pedir("GET", f"/productos?codigo={self.un_producto()['codigo']}", "GET /productos?codigo")

    @task(2)
    def por_categoria(self):
        self.pedir("GET", f"/productos?id_categoria={self.datos['categoria']}&estado=ACTIVO&por_pagina=20", "GET /productos?id_categoria&estado")


class ConsultaPuntual(UsuarioCatalogo):
    """K03"""

    @task(4)
    def producto(self):
        self.pedir("GET", f"/productos/{self.un_producto()['id']}", "GET /productos/{id}")

    @task(2)
    def categorias(self):
        self.pedir("GET", "/categorias?arbol=true", "GET /categorias?arbol")

    @task(1)
    def categoria(self):
        self.pedir("GET", f"/categorias/{self.datos['categoria']}", "GET /categorias/{id}")


# ---------------- Referencia: escritura, estrés y pico ----------------

class AltaDeProductos(UsuarioCatalogo):
    """K04"""

    @task
    def crear(self):
        self.pedir(
            "POST", "/productos", "POST /productos", esperados=(201,),
            json={"codigo": f"ALTA-{sufijo()}", "nombre": "Producto de la prueba de altas", "descripcion": "Alta simultánea",
                  "id_categoria": self.datos["categoria"], "unidad_medida": "UNIDAD", "precio": 1500},
        )


class _Mixto(UsuarioCatalogo):
    abstract = True
    wait_time = comun.between(1, 2)

    @task(5)
    def listado(self):
        self.pedir("GET", f"/productos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /productos")

    @task(3)
    def producto(self):
        self.pedir("GET", f"/productos/{self.un_producto()['id']}", "GET /productos/{id}")

    @task(2)
    def busqueda(self):
        self.pedir("GET", f"/productos?nombre={random.choice(FRAGMENTOS)}&por_pagina=20", "GET /productos?nombre")


class EstresCatalogo(_Mixto):
    """K05: de 0 a 200 usuarios, uno por segundo, sobre las consultas del catálogo."""


class PicoCatalogo(_Mixto):
    """K06: 200 usuarios en 2 s con el uso típico: sobre todo consultas y alguna alta."""

    @task(1)
    def alta(self):
        self.pedir(
            "POST", "/productos", "POST /productos", esperados=(201,),
            json={"codigo": f"PICO-{sufijo()}", "nombre": "Producto del pico", "descripcion": "Pico",
                  "id_categoria": self.datos["categoria"], "unidad_medida": "UNIDAD", "precio": 900},
        )
