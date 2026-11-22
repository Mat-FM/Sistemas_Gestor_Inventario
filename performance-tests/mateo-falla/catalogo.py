"""Pruebas K01 a K04: ms-catalogo (Laravel + MySQL). Los escenarios están en escenarios.py.

K03 mide la única llamada entre mis servicios: el filtro ?id_proveedor hace que ms-catalogo consulte a ms-proveedores (llamada 8, con
RNF18). K04 mide la carga masiva interna que usa ms-reportes en las importaciones (no pasa por el Gateway).
"""
import random

from locust import task

from comun import UsuarioBase, host, preparar, sufijo, una_vez

PRODUCTOS_DE_PRUEBA = 60
PROVEEDORES_DE_PRUEBA = 3
PRODUCTOS_POR_PROVEEDOR = 20
FILAS_POR_LOTE = 100
FRAGMENTOS = ["Prueba", "Café", "Lote", "PERF", "Producto"]


def _datos():
    """Una categoría con una subcategoría y 60 productos para que los listados, las búsquedas y los filtros devuelvan datos reales
    (el listado pagina de 20 en 20), y 3 proveedores en ms-proveedores con 20 de esos productos asociados cada uno, para que el filtro
    por proveedor devuelva productos reales. No cuenta en las mediciones."""
    corrida = sufijo()
    categoria = preparar("catalogo", "POST", "/categorias", json={"nombre": f"PERF {corrida}"})
    sub = preparar("catalogo", "POST", "/categorias", json={"nombre": f"PERF {corrida} sub", "id_categoria_padre": categoria["id_categoria"]})
    productos = []
    for i in range(PRODUCTOS_DE_PRUEBA):
        # La mitad en la subcategoría: el filtro por categoría principal incluye sus subcategorías (RF12).
        producto = preparar(
            "catalogo", "POST", "/productos",
            json={"codigo": f"PERF-{corrida}-{i}", "nombre": f"Producto de prueba {i} {corrida}", "descripcion": "Para las pruebas de rendimiento",
                  "id_categoria": (sub if i % 2 else categoria)["id_categoria"], "unidad_medida": "UNIDAD", "precio": 1000 + i},
        )
        productos.append({"id": producto["id_producto"], "codigo": producto["codigo"]})
    proveedores = []
    for p in range(PROVEEDORES_DE_PRUEBA):
        proveedor = preparar(
            "proveedores", "POST", "/proveedores",
            json={"nit": f"K-{corrida}-{p}", "razon_social": f"Proveedor del filtro {corrida} {p}", "nombre_contacto": "Contacto de prueba",
                  "telefono": "3000000000", "correo": f"filtro{p}.{corrida}@prueba.test", "direccion": "Calle 1 # 2-3"},
        )
        for producto in random.sample(productos, PRODUCTOS_POR_PROVEEDOR):
            preparar("proveedores", "POST", f"/proveedores/{proveedor['id_proveedor']}/productos", json={"id_producto": producto["id"]})
        proveedores.append(proveedor["id_proveedor"])
    return {"corrida": corrida, "categoria": categoria["id_categoria"], "productos": productos, "proveedores": proveedores}


def paginado(cuerpo):
    if not isinstance(cuerpo, dict) or not isinstance(cuerpo.get("datos"), list) or "meta" not in cuerpo:
        return "se esperaba un listado {datos, meta}"
    return None


def productos_del_proveedor(cuerpo):
    """El filtro debe devolver los 20 productos asociados: si ms-proveedores no respondió, ms-catalogo daría 503 (no 200), pero si la
    llamada devolviera otra cosa, el total no coincidiría."""
    problema = paginado(cuerpo)
    if problema:
        return problema
    total = cuerpo["meta"].get("total")
    return None if total == PRODUCTOS_POR_PROVEEDOR else f"el proveedor debía tener {PRODUCTOS_POR_PROVEEDOR} productos y llegaron {total}"


def lote_completo(cuerpo):
    if not isinstance(cuerpo, dict) or cuerpo.get("creados") != FILAS_POR_LOTE:
        return f"el lote debía crear {FILAS_POR_LOTE} productos: {str(cuerpo)[:150]}"
    return None


class UsuarioCatalogo(UsuarioBase):
    abstract = True
    host = host("catalogo")

    def on_start(self):
        super().on_start()
        self.datos = una_vez("catalogo", _datos)

    def un_producto(self):
        return random.choice(self.datos["productos"])


# ---------------- Consultas (RNF06) ----------------

class ListadoYProducto(UsuarioCatalogo):
    """K01: el listado paginado y la consulta de un producto (también la usa ms-inventario en cada movimiento, llamada 1)."""

    @task(3)
    def listado(self):
        self.pedir("GET", f"/productos?pagina={random.randint(1, 3)}&por_pagina=20", "GET /productos", validar=paginado)

    @task(2)
    def producto(self):
        self.pedir("GET", f"/productos/{self.un_producto()['id']}", "GET /productos/{id}")


class BusquedaYCategorias(UsuarioCatalogo):
    """K02: búsqueda por nombre y código (parcial), por categoría (incluye las subcategorías) y el árbol de categorías."""

    @task(3)
    def por_nombre(self):
        self.pedir("GET", f"/productos?nombre={random.choice(FRAGMENTOS)}&por_pagina=20", "GET /productos?nombre", validar=paginado)

    @task(2)
    def por_codigo(self):
        self.pedir("GET", f"/productos?codigo={self.un_producto()['codigo']}", "GET /productos?codigo", validar=paginado)

    @task(2)
    def por_categoria(self):
        self.pedir("GET", f"/productos?id_categoria={self.datos['categoria']}&estado=ACTIVO&por_pagina=20", "GET /productos?id_categoria&estado",
                   validar=paginado)

    @task(1)
    def arbol(self):
        self.pedir("GET", "/categorias?arbol=true", "GET /categorias?arbol")

    @task(1)
    def categoria(self):
        self.pedir("GET", f"/categorias/{self.datos['categoria']}", "GET /categorias/{id}")


class FiltroPorProveedor(UsuarioCatalogo):
    """K03: GET /productos?id_proveedor. Cada petición hace que ms-catalogo consulte a ms-proveedores (llamada 8), con el tiempo de espera,
    los reintentos y el cortacircuitos de RNF18: mide los dos servicios trabajando juntos."""

    @task
    def por_proveedor(self):
        self.pedir("GET", f"/productos?id_proveedor={random.choice(self.datos['proveedores'])}&por_pagina=20", "GET /productos?id_proveedor",
                   validar=productos_del_proveedor)


# ---------------- Referencia: escritura por lotes ----------------

class LoteInterno(UsuarioCatalogo):
    """K04: la carga masiva interna (POST /internas/productos/lote) con 100 filas por petición, como la envía ms-reportes al importar
    productos. Va siempre directo a ms-catalogo: el Gateway no publica las rutas internas."""

    @task
    def lote(self):
        corrida = sufijo()
        filas = [{"codigo": f"LOTE-{corrida}-{i}", "nombre": f"Producto del lote {i}", "descripcion": None, "id_categoria": self.datos["categoria"],
                  "unidad_medida": "UNIDAD", "precio": 1000 + i} for i in range(FILAS_POR_LOTE)]
        self.pedir("POST", "/internas/productos/lote", "POST /internas/productos/lote (100 filas)", servicio="catalogo", interna=True,
                   validar=lote_completo, json={"filas": filas})
