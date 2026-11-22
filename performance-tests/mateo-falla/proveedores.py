"""Pruebas P01 a P03: ms-proveedores (Laravel + MySQL). Los escenarios están en escenarios.py."""
import random

from locust import task

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


def paginado(cuerpo):
    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("datos"), list) or "meta" not in cuerpo:
        return "se esperaba un listado {datos, meta}"
    return None


def lista(cuerpo):
    return None if isinstance(cuerpo, list) else "se esperaba una lista"


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
        self.pedir("GET", f"/proveedores?pagina={random.randint(1, 2)}&por_pagina=20", "GET /proveedores", validar=paginado)

    @task(2)
    def por_razon_social(self):
        self.pedir("GET", "/proveedores?razon_social=Proveedor&estado=ACTIVO", "GET /proveedores?razon_social&estado", validar=paginado)

    @task(1)
    def por_producto(self):
        self.pedir("GET", f"/proveedores?id_producto={10_000 + random.randint(0, PROVEEDORES_DE_PRUEBA - 1) * 10 + 1}", "GET /proveedores?id_producto",
                   validar=paginado)


class ProveedorConSusProductos(UsuarioProveedores):
    """P02"""

    @task(3)
    def proveedor(self):
        self.pedir("GET", f"/proveedores/{self.uno()}", "GET /proveedores/{id}")

    @task(3)
    def productos(self):
        self.pedir("GET", f"/proveedores/{self.uno()}/productos", "GET /proveedores/{id}/productos", validar=lista)


# ---------------- Referencia: escritura ----------------

class AltaYAsociacion(UsuarioProveedores):
    """P03: el alta de un proveedor (NIT único) y la asociación de sus productos, como se hace desde el formulario del cliente web. Las
    asociaciones son las que luego usa el filtro por proveedor de ms-catalogo. Un 409 (NIT o asociación repetidos) cuenta como error."""

    @task
    def alta_y_asociacion(self):
        proveedor = self.pedir("POST", "/proveedores", "POST /proveedores", esperados=(201,), json=_proveedor("Alta", sufijo(), random.randint(0, 999)))
        if not proveedor:
            return
        for producto in random.sample(range(20_000, 30_000), 3):
            self.pedir("POST", f"/proveedores/{proveedor['id_proveedor']}/productos", "POST /proveedores/{id}/productos", esperados=(201,),
                       json={"id_producto": producto})
