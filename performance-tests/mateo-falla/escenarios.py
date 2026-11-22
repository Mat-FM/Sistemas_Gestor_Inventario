"""Las 15 pruebas de rendimiento de Mateo Falla sobre ms-reportes (R01 a R05), ms-catalogo (K01 a K04) y ms-proveedores (P01 a P03), más
la mezcla de los tres con las tipologías de la guía del taller: carga (M01), estrés (E01) y capacidad (S01).

Cada escenario dice qué clase de Locust corre, con cuántos usuarios simulados, a qué ritmo entran (spawn rate) y cuánto dura.

- `tipologia`: la de la guía del taller (carga, estres o capacidad).
- `tipo`: qué ejercita (consulta, exportacion, importacion, lote, escritura, mezcla).
- `obligatorio`: True si verifica RNF06 (Entrega 1): las consultas responden en menos de 2 s en el percentil 95 y con menos de 1 % de
  errores, con 50 usuarios durante 5 minutos. Los demás se comparan con el mismo umbral, pero son de referencia.
- `historial`: guarda el historial segundo a segundo de Locust; resumen.py lo usa para el punto de quiebre (E01) y la tendencia (S01).

ORDEN: los reportes van primero y las escrituras al final. ms-reportes recorre TODOS los productos de ms-catalogo en cada petición, y K04 da de
alta miles de productos: después de K04, los reportes y la mezcla (que incluye reportes) medirían el tamaño del catálogo y no el servicio.
Si se corren por separado, respetar el mismo orden y preferir una pila nueva.
"""
import os

# S01 debe correr cerca del máximo ESTABLE (no del quiebre): por defecto 60 usuarios. Ajustarlo con PERF_CAPACIDAD_USUARIOS a ~70 % del
# número de usuarios en que E01 se quebró (ver RESULTADOS.md).
USUARIOS_CAPACIDAD = int(os.environ.get("PERF_CAPACIDAD_USUARIOS", "60"))

ESCENARIOS = [
    # ---------------- ms-reportes ----------------
    {"id": "R01", "archivo": "reportes.py", "clase": "ExistenciasYValorizacion", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Existencias por producto y bodega, y valorización (GET /reportes/existencias y /reportes/valorizacion)"},
    {"id": "R02", "archivo": "reportes.py", "clase": "RotacionEIndicadores", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Rotación de 30 días y panel de indicadores (GET /reportes/rotacion y /indicadores)"},
    {"id": "R03", "archivo": "reportes.py", "clase": "KardexFiltrado", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Kardex de un producto, con y sin periodo (GET /reportes/kardex)"},
    {"id": "R04", "archivo": "reportes.py", "clase": "DescargasCsvYPdf", "tipologia": "carga", "tipo": "exportacion", "obligatorio": False,
     "usuarios": 30, "tasa": 5, "duracion": "3m",
     "descripcion": "Los reportes como archivo: CSV de existencias y de kardex, y PDF de valorización"},
    {"id": "R05", "archivo": "reportes.py", "clase": "ImportacionStockInicial", "tipologia": "carga", "tipo": "importacion", "obligatorio": False,
     "usuarios": 10, "tasa": 2, "duracion": "3m",
     "descripcion": "Importación masiva de STOCK_INICIAL de 10 filas (POST /importaciones): lee, convierte con catálogo e inventario y envía"},
    # ---------------- ms-catalogo ----------------
    {"id": "K01", "archivo": "catalogo.py", "clase": "ListadoYProducto", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado paginado de productos y un producto (GET /productos y /productos/{id})"},
    {"id": "K02", "archivo": "catalogo.py", "clase": "BusquedaYCategorias", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Búsqueda por nombre, código y categoría (con subcategorías), árbol de categorías y una categoría"},
    {"id": "K03", "archivo": "catalogo.py", "clase": "FiltroPorProveedor", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Filtro por proveedor (GET /productos?id_proveedor): ms-catalogo consulta a ms-proveedores en cada petición (RNF18)"},
    # ---------------- ms-proveedores ----------------
    {"id": "P01", "archivo": "proveedores.py", "clase": "ListadoProveedores", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado, por razón social y por producto (GET /proveedores)"},
    {"id": "P02", "archivo": "proveedores.py", "clase": "ProveedorConSusProductos", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Un proveedor y sus productos asociados (GET /proveedores/{id} y /proveedores/{id}/productos)"},
    # ---------------- Mezcla de los tres servicios: tipologías de la guía del taller ----------------
    {"id": "M01", "archivo": "mixto.py", "clase": "CargaMixta", "tipologia": "carga", "tipo": "mezcla", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "10m", "historial": True,
     "descripcion": "Carga: ~85 % GET y ~15 % POST sobre los tres servicios, 50 usuarios en meseta"},
    {"id": "E01", "archivo": "mixto.py", "clase": "EstresMixto", "tipologia": "estres", "tipo": "mezcla", "obligatorio": False,
     "usuarios": 300, "tasa": 2, "duracion": "5m", "historial": True,
     "descripcion": "Estrés: la misma mezcla con una rampa hasta 300 usuarios (2 por segundo), para hallar el punto de quiebre"},
    {"id": "S01", "archivo": "mixto.py", "clase": "CapacidadMixta", "tipologia": "capacidad", "tipo": "mezcla", "obligatorio": False,
     "usuarios": USUARIOS_CAPACIDAD, "tasa": 5, "duracion": "60m", "historial": True,
     "descripcion": f"Capacidad (soak): la misma mezcla con {USUARIOS_CAPACIDAD} usuarios durante 60 min, para ver la tendencia en el tiempo"},
    # ---------------- Escrituras (agrandan los datos: van al final) ----------------
    {"id": "P03", "archivo": "proveedores.py", "clase": "AltaYAsociacion", "tipologia": "carga", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Alta de proveedores (NIT único) y asociación de 3 productos a cada uno"},
    {"id": "K04", "archivo": "catalogo.py", "clase": "LoteInterno", "tipologia": "carga", "tipo": "lote", "obligatorio": False,
     "usuarios": 10, "tasa": 2, "duracion": "3m", "interna": True,
     "descripcion": "Carga masiva interna de productos, 100 filas por petición (POST /internas/productos/lote, siempre directo)"},
]
