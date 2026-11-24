"""Pruebas G01 a G06: el API Gateway (Laravel). Los escenarios están en escenarios.py.

Van SIEMPRE por el Gateway (aunque PERF_MODO sea directo) y con usuarios con sesión: miden lo que el Gateway añade a cada petición
(validar el JWT, releer al usuario de su base, aplicar el permiso por rol y el límite de peticiones, reenviar al servicio y devolver
la respuesta). Necesitan PERF_USUARIOS con una cuenta de ADMINISTRADOR y, para no medir el límite de peticiones en vez del Gateway
(100 por minuto y usuario, 10 inicios de sesión por minuto: RNF19), un Gateway con RATE_LIMIT_PER_MINUTE y
LOGIN_RATE_LIMIT_PER_MINUTE altos. Ver README.
"""
import random

from locust import task

import comun
from comun import UsuarioBase, clave, lista, movimiento_registrado, paginado, paginado_de, una_vez
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
            validar=movimiento_registrado,
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
        pagina = random.randint(1, 2)
        self.pedir("GET", f"/usuarios?pagina={pagina}&por_pagina=20", "GET /api/usuarios", validar=paginado_de(pagina))

    @task
    def roles(self):
        self.pedir("GET", "/roles", "GET /api/roles", validar=paginado)


class ProxyACatalogo(UsuarioGateway):
    """G03: el Gateway reenvía a ms-catalogo (GET /productos y búsqueda por nombre)."""

    @task(3)
    def listado(self):
        self.pedir("GET", "/productos?por_pagina=20", "GET /api/productos", validar=paginado)

    @task
    def busqueda(self):
        # Puede no coincidir con ningún producto: aquí se mide el reenvío, no el contenido de la búsqueda.
        self.pedir("GET", f"/productos?nombre={random.choice(['Caf', 'Jug', 'Pan', 'Gal'])}&por_pagina=10", "GET /api/productos?nombre",
                   validar=lambda c: paginado(c, vacio_ok=True))

    @task
    def categorias(self):
        self.pedir("GET", "/categorias", "GET /api/categorias", validar=lista)


class ProxyAInventario(UsuarioGateway):
    """G04: el Gateway reenvía a ms-inventario (saldos y kardex)."""

    @task(2)
    def saldos(self):
        self.pedir("GET", "/saldos?por_pagina=20", "GET /api/saldos", validar=paginado)

    @task(2)
    def kardex(self):
        self.pedir("GET", f"/movimientos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /api/movimientos", validar=paginado)

    @task
    def bodegas(self):
        self.pedir("GET", "/bodegas", "GET /api/bodegas", validar=paginado)


# ---------------- Escritura e inicio de sesión ----------------

class EscrituraPorElGateway(UsuarioGateway):
    """G05: POST /movimientos por el Gateway: reenvía el cuerpo y la Idempotency-Key, y ms-inventario valida con ms-catalogo."""

    @task
    def registrar(self):
        self.entrada(random.randint(1, 10))


class InicioDeSesion(UsuarioGateway):
    """G06: POST /auth/login. Lo que cuesta emitir un token (verificar la contraseña con bcrypt a propósito lenta y firmar el JWT),
    que es lo único del Gateway que no reenvía nada ni se parece a las consultas. El límite de inicios de sesión (10 por minuto y por
    IP, RNF19) debe estar subido: si no, esta prueba mediría el limitador."""

    @task
    def iniciar(self):
        correo, contrasena = random.choice(comun.CUENTAS)
        with self.client.post("/api/auth/login", name="POST /api/auth/login", json={"correo": correo, "contrasena": contrasena},
                              catch_response=True) as r:
            if r.status_code != 200:
                r.failure(f"{r.status_code}: {r.text[:200]}")
            elif not (r.json() or {}).get("token"):
                r.failure("el inicio de sesión no devolvió un token")
            else:
                r.success()
