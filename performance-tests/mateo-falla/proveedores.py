"""Pruebas P01 a P04: ms-proveedores (Laravel + MySQL). Los escenarios están en escenarios.py."""
import random

from locust import between, task

from comun import UsuarioBase, host, preparar, sufijo, una_vez

PROVEEDORES_DE_PRUEBA = 40
PRODUCTOS_POR_PROVEEDOR = 5


def _proveedor(nombre, corrida, i):
    return {"nit": f"{corrida}-{i}", "razon_social": f"{nombre} {corrida} {i}", "nombre_contacto": "Contacto de prueba",
            "telefono": "3000000000", "correo": f"perf{i}.{corrida}@prueba.test", "direccion": "Calle 1 # 2-3"}


def _datos():
    """40 proveedores, cada uno con 5 productos asociados (solo el id: ms-proveedores no consulta al catálogo). No cuenta en las mediciones."""
    corrida = sufijo()
    ids = []
    for i in range(PROVEEDORES_DE_PRUEBA):
        proveedor = preparar("proveedores", "POST", "/proveedores", json=_proveedor("Proveedor de prueba", corrida, i))
        ids.append(proveedor["id_proveedor"])
        for producto in range(1, PRODUCTOS_POR_PROVEEDOR + 1):
            preparar("proveedores", "POST", f"/proveedores/{proveedor['id_proveedor']}/productos", json={"id_producto": 10_000 + i * 10 + producto})
    return {"corrida": corrida, "proveedores": ids}


class UsuarioProveedores(UsuarioBase):
    abstract = True
    host = host("proveedores")

    def on_start(self):
        super().on_start()
        self.datos = una_vez("proveedores", _datos)

    def uno(self):
        return random.choice(self.datos["proveedores"])


# ---------------- Consultas (RNF06) ----------------

class ListadoProveedores(UsuarioProveedores):
    """P01"""

    @task(3)
    def listado(self):
        self.pedir("GET", f"/proveedores?pagina={random.randint(1, 2)}&por_pagina=20", "GET /proveedores")

    @task(2)
    def por_razon_social(self):
        self.pedir("GET", "/proveedores?razon_social=Proveedor&estado=ACTIVO", "GET /proveedores?razon_social&estado")

    @task(1)
    def por_producto(self):
        self.pedir("GET", f"/proveedores?id_producto={10_000 + random.randint(0, PROVEEDORES_DE_PRUEBA - 1) * 10 + 1}", "GET /proveedores?id_producto")


class ProveedorConSusProductos(UsuarioProveedores):
    """P02"""

    @task(3)
    def proveedor(self):
        self.pedir("GET", f"/proveedores/{self.uno()}", "GET /proveedores/{id}")

    @task(3)
    def productos(self):
        self.pedir("GET", f"/proveedores/{self.uno()}/productos", "GET /proveedores/{id}/productos")


# ---------------- Referencia: escritura y pico ----------------

class AltaDeProveedores(UsuarioProveedores):
    """P03"""

    @task
    def crear(self):
        self.pedir("POST", "/proveedores", "POST /proveedores", esperados=(201,), json=_proveedor("Alta", sufijo(), random.randint(0, 999)))


class PicoProveedores(UsuarioProveedores):
    """P04: 200 usuarios en 2 s con el uso típico: consultas y alguna alta."""

    wait_time = between(1, 2)

    @task(5)
    def listado(self):
        self.pedir("GET", f"/proveedores?pagina={random.randint(1, 2)}&por_pagina=20", "GET /proveedores")

    @task(3)
    def productos(self):
        self.pedir("GET", f"/proveedores/{self.uno()}/productos", "GET /proveedores/{id}/productos")

    @task(1)
    def alta(self):
        self.pedir("POST", "/proveedores", "POST /proveedores", esperados=(201,), json=_proveedor("Pico", sufijo(), random.randint(0, 999)))
