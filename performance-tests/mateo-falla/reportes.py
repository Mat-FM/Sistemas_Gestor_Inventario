"""Pruebas R01 a R05: ms-reportes (Flask). No guarda reportes: los calcula llamando a ms-catalogo, ms-inventario y ms-compras, así que
lo que se mide es el servicio más lo que él espera de los demás. Los escenarios están en escenarios.py."""
import random
from datetime import date, timedelta

from locust import task

import comun
from comun import UsuarioBase, clave, host, preparar, sufijo, una_vez

PRODUCTOS_DE_PRUEBA = 30
MOVIMIENTOS_POR_PRODUCTO = 4


def _datos():
    """30 productos con stock en las dos bodegas (con un lote) y unos movimientos de entrada y salida, para que existencias, valorización,
    rotación y kardex devuelvan datos reales. No cuenta en las mediciones."""
    corrida = sufijo()
    categoria = preparar("catalogo", "POST", "/categorias", json={"nombre": f"PERF reportes {corrida}"})
    vence = (date.today() + timedelta(days=120)).isoformat()
    productos = []
    for i in range(PRODUCTOS_DE_PRUEBA):
        producto = preparar(
            "catalogo", "POST", "/productos",
            json={"codigo": f"REP-{corrida}-{i}", "nombre": f"Producto de reportes {i} {corrida}", "descripcion": "Para las pruebas de rendimiento",
                  "id_categoria": categoria["id_categoria"], "unidad_medida": "UNIDAD", "precio": 2000 + i},
        )
        idp = producto["id_producto"]
        productos.append(idp)
        for bodega in (comun.ID_BODEGA, comun.ID_BODEGA_2):
            preparar(
                "inventario", "POST", "/movimientos", headers={"Idempotency-Key": clave()},
                json={"tipo": "ENTRADA", "id_producto": idp, "id_bodega": bodega, "cantidad": 5000,
                      "lote": {"codigo_lote": f"REP-{corrida}-{i}-{bodega}", "fecha_vencimiento": vence}},
            )
        for m in range(MOVIMIENTOS_POR_PRODUCTO):
            preparar(
                "inventario", "POST", "/movimientos", headers={"Idempotency-Key": clave()},
                json={"tipo": "SALIDA" if m % 2 else "ENTRADA", "id_producto": idp, "id_bodega": comun.ID_BODEGA, "cantidad": 1 + m},
            )
    return {"corrida": corrida, "productos": productos}


class UsuarioReportes(UsuarioBase):
    abstract = True
    host = host("reportes")

    def on_start(self):
        super().on_start()
        self.datos = una_vez("reportes", _datos)

    def periodo(self):
        hoy = date.today()
        return f"fecha_desde={(hoy - timedelta(days=30)).isoformat()}&fecha_hasta={hoy.isoformat()}"

    def un_producto(self):
        return random.choice(self.datos["productos"])


# ---------------- Consultas (RNF06) ----------------

class ExistenciasYValorizacion(UsuarioReportes):
    """R01"""

    @task
    def existencias(self):
        self.pedir("GET", "/reportes/existencias", "GET /reportes/existencias")

    @task
    def valorizacion(self):
        self.pedir("GET", "/reportes/valorizacion", "GET /reportes/valorizacion")


class RotacionEIndicadores(UsuarioReportes):
    """R02"""

    @task
    def rotacion(self):
        self.pedir("GET", f"/reportes/rotacion?{self.periodo()}&limite=5", "GET /reportes/rotacion")

    @task
    def indicadores(self):
        self.pedir("GET", "/indicadores", "GET /indicadores")


class KardexFiltrado(UsuarioReportes):
    """R03: el kardex de un producto (filtrado: sin filtro pasaría de KARDEX_MAX_FILAS y respondería 422 a propósito)."""

    @task(3)
    def por_producto(self):
        self.pedir("GET", f"/reportes/kardex?id_producto={self.un_producto()}", "GET /reportes/kardex?id_producto")

    @task(1)
    def por_producto_y_fechas(self):
        self.pedir("GET", f"/reportes/kardex?id_producto={self.un_producto()}&{self.periodo()}", "GET /reportes/kardex?id_producto&fechas")


# ---------------- Referencia: exportación y estrés ----------------

class DescargasCsvYPdf(UsuarioReportes):
    """R04: los mismos reportes como archivo: CSV con BOM y PDF (generar el archivo cuesta más que el JSON)."""

    @task(3)
    def existencias_csv(self):
        self.pedir("GET", "/reportes/existencias?formato=csv", "GET /reportes/existencias?formato=csv")

    @task(2)
    def kardex_csv(self):
        self.pedir("GET", f"/reportes/kardex?id_producto={self.un_producto()}&formato=csv", "GET /reportes/kardex?formato=csv")

    @task(1)
    def valorizacion_pdf(self):
        self.pedir("GET", "/reportes/valorizacion?formato=pdf", "GET /reportes/valorizacion?formato=pdf")


class EstresReportes(UsuarioReportes):
    """R05: de 0 a 200 usuarios, uno por segundo, sobre todos los reportes en JSON."""

    @task(3)
    def existencias(self):
        self.pedir("GET", "/reportes/existencias", "GET /reportes/existencias")

    @task(2)
    def valorizacion(self):
        self.pedir("GET", "/reportes/valorizacion", "GET /reportes/valorizacion")

    @task(2)
    def indicadores(self):
        self.pedir("GET", "/indicadores", "GET /indicadores")

    @task(2)
    def kardex(self):
        self.pedir("GET", f"/reportes/kardex?id_producto={self.un_producto()}", "GET /reportes/kardex?id_producto")
