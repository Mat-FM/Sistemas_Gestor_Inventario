"""Pruebas G01 a G07: el API Gateway (Laravel). Los escenarios están en escenarios.py.

Van SIEMPRE por el Gateway (aunque PERF_MODO sea directo) y con usuarios con sesión: miden lo que el Gateway añade a cada petición
(validar el JWT, releer al usuario de su base, aplicar el permiso por rol y el límite de peticiones, reenviar al servicio y devolver
la respuesta). Necesitan PERF_USUARIOS con una cuenta de ADMINISTRADOR y, para no medir el límite de peticiones en vez del Gateway
(100 por minuto y usuario, 10 inicios de sesión por minuto: RNF19), un Gateway con RATE_LIMIT_PER_MINUTE y
LOGIN_RATE_LIMIT_PER_MINUTE altos. Ver README.
"""
import random

from locust import between, task

import comun
from comun import UsuarioBase, clave, una_vez
from inventario import _datos


class UsuarioGateway(UsuarioBase):
    abstract = True
    host = comun.URLS["gateway"]

    def on_start(self):
        if not comun.CUENTAS:
            raise RuntimeError("Las pruebas del Gateway necesitan PERF_USUARIOS con al menos una cuenta de ADMINISTRADOR")
        self.prefijo = "/api"
        self.cabeceras = {"Authorization": f"Bearer {comun._iniciar_sesion(next(comun._cuentas))}"}
        una_vez("datos", _datos)

    def entrada(self, cantidad=1):
        return self.pedir(
            "POST", "/movimientos", "POST /api/movimientos", esperados=(201,), headers={"Idempotency-Key": clave()},
            json={"tipo": "ENTRADA", "id_producto": comun.ID_PRODUCTO, "id_bodega": comun.ID_BODEGA, "cantidad": cantidad},
        )


# ---------------- Consultas (RNF06) ----------------

class SaludDelGateway(UsuarioGateway):
    """G01: /health, sin sesión ni base de datos: lo mínimo que cuesta una petición al Gateway."""

    @task
    def salud(self):
        with self.client.get("/health", name="GET /health", catch_response=True) as r:
            r.success() if r.status_code == 200 else r.failure(f"{r.status_code}")


class UsuariosYRoles(UsuarioGateway):
    """G02: consultas que resuelve el propio Gateway con su base MySQL (usuarios y roles), sin llamar a ningún servicio."""

    @task(3)
    def usuarios(self):
        self.pedir("GET", f"/usuarios?pagina={random.randint(1, 2)}&por_pagina=20", "GET /api/usuarios")

    @task
    def roles(self):
        self.pedir("GET", "/roles", "GET /api/roles")


class ProxyACatalogo(UsuarioGateway):
    """G03: el Gateway reenvía a ms-catalogo (GET /productos y búsqueda por nombre)."""

    @task(3)
    def listado(self):
        self.pedir("GET", "/productos?por_pagina=20", "GET /api/productos")

    @task
    def busqueda(self):
        self.pedir("GET", f"/productos?nombre={random.choice(['Caf', 'Jug', 'Pan', 'Gal'])}&por_pagina=10", "GET /api/productos?nombre")

    @task
    def categorias(self):
        self.pedir("GET", "/categorias", "GET /api/categorias")


class ProxyAInventario(UsuarioGateway):
    """G04: el Gateway reenvía a ms-inventario (saldos y kardex)."""

    @task(2)
    def saldos(self):
        self.pedir("GET", "/saldos?por_pagina=20", "GET /api/saldos")

    @task(2)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /api/movimientos")

    @task
    def bodegas(self):
        self.pedir("GET", "/bodegas", "GET /api/bodegas")


# ---------------- Escritura ----------------

class EscrituraPorElGateway(UsuarioGateway):
    """G05: POST /movimientos por el Gateway: reenvía el cuerpo y la Idempotency-Key, y ms-inventario valida con ms-catalogo."""

    @task
    def registrar(self):
        self.entrada(random.randint(1, 10))


# ---------------- Estrés y pico ----------------

class EstresDelGateway(UsuarioGateway):
    """G06: de 0 a 200 usuarios, uno por segundo, con la mezcla de consultas por varios servicios, para hallar el punto de quiebre."""

    @task(3)
    def productos(self):
        self.pedir("GET", "/productos?por_pagina=20", "GET /api/productos")

    @task(3)
    def saldos(self):
        self.pedir("GET", "/saldos?por_pagina=20", "GET /api/saldos")

    @task(2)
    def usuarios(self):
        self.pedir("GET", "/usuarios?por_pagina=20", "GET /api/usuarios")

    @task
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /api/movimientos")


class PicoDelGateway(UsuarioGateway):
    """G07: 200 usuarios en 2 s con el uso típico de la interfaz: casi todo consultas y alguna entrada."""

    wait_time = between(1, 2)

    @task(6)
    def saldos(self):
        self.pedir("GET", "/saldos?por_pagina=20", "GET /api/saldos")

    @task(4)
    def productos(self):
        self.pedir("GET", "/productos?por_pagina=20", "GET /api/productos")

    @task(2)
    def kardex(self):
        self.pedir("GET", "/movimientos?por_pagina=20", "GET /api/movimientos")

    @task
    def registrar_entrada(self):
        self.entrada(random.randint(1, 5))
