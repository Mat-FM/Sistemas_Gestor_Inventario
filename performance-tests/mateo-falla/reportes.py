"""Pruebas R01 a R05: ms-reportes (Flask). No guarda reportes: los calcula llamando a ms-catalogo, ms-inventario y ms-compras, así que
lo que se mide es el servicio más lo que él espera de los demás. R05 mide la importación masiva (RF16). Los escenarios están en escenarios.py."""
import io
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
    codigos = []
    for i in range(PRODUCTOS_DE_PRUEBA):
        producto = preparar(
            "catalogo", "POST", "/productos",
            json={"codigo": f"REP-{corrida}-{i}", "nombre": f"Producto de reportes {i} {corrida}", "descripcion": "Para las pruebas de rendimiento",
                  "id_categoria": categoria["id_categoria"], "unidad_medida": "UNIDAD", "precio": 2000 + i},
        )
        idp = producto["id_producto"]
        productos.append(idp)
        codigos.append(producto["codigo"])
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
    # La importación de R05 escribe las bodegas por su código, como lo haría un usuario en el archivo.
    bodegas = [preparar("inventario", "GET", f"/bodegas/{b}")["codigo"] for b in (comun.ID_BODEGA, comun.ID_BODEGA_2)]
    return {"corrida": corrida, "productos": productos, "codigos": codigos, "bodegas": bodegas}


FILAS_POR_IMPORTACION = 10


def archivo_stock_inicial(datos):
    """Un CSV de STOCK_INICIAL con 10 filas válidas. Las cantidades son al azar: ms-reportes deriva la clave de idempotencia del
    contenido, y un archivo idéntico se tomaría como repetición y no sumaría nada (no se mediría la carga real)."""
    lineas = ["codigo_producto,codigo_bodega,cantidad,codigo_lote,fecha_vencimiento"]
    for _ in range(FILAS_POR_IMPORTACION):
        lineas.append(f"{random.choice(datos['codigos'])},{random.choice(datos['bodegas'])},{random.randint(1, 50)},,")
    return ("\n".join(lineas) + "\n").encode("utf-8")


def importacion_procesada(cuerpo):
    """Una importación cuenta como éxito solo si quedó PROCESADA con todas sus filas: un 201 FALLIDA o CON_ERRORES es un error."""
    if not isinstance(cuerpo, dict):
        return "respuesta sin JSON"
    if cuerpo.get("estado") != "PROCESADA" or cuerpo.get("filas_validas") != FILAS_POR_IMPORTACION:
        return f"importación {cuerpo.get('estado')} con {cuerpo.get('filas_validas')} filas válidas: {str(cuerpo.get('errores'))[:150]}"
    return None


def lista(cuerpo):
    return None if isinstance(cuerpo, list) else "se esperaba una lista"


def con_valor_total(cuerpo):
    return None if isinstance(cuerpo, dict) and "valor_total" in cuerpo else "falta valor_total"


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
        self.pedir("GET", "/reportes/existencias", "GET /reportes/existencias", validar=lista)

    @task
    def valorizacion(self):
        self.pedir("GET", "/reportes/valorizacion", "GET /reportes/valorizacion", validar=con_valor_total)


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


class ImportacionStockInicial(UsuarioReportes):
    """R05: importación masiva de STOCK_INICIAL (RF16) con un archivo pequeño: ms-reportes lee el CSV, valida cada fila, pide a ms-catalogo
    todos los productos y a ms-inventario todas las bodegas para convertir los códigos, envía las filas a la carga inicial de ms-inventario
    y guarda la importación. Es la operación más pesada del servicio. Solo cuenta como éxito una importación PROCESADA."""

    @task
    def importar(self):
        self.pedir(
            "POST", "/importaciones", "POST /importaciones (STOCK_INICIAL)", esperados=(201,), validar=importacion_procesada,
            data={"tipo": "STOCK_INICIAL"},
            files={"archivo": ("stock-inicial.csv", io.BytesIO(archivo_stock_inicial(self.datos)), "text/csv")},
        )
