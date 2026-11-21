"""Las 15 pruebas de rendimiento de Mateo Falla: 6 de ms-catalogo (K01 a K06), 4 de ms-proveedores (P01 a P04) y 5 de ms-reportes (R01 a R05).

Cada escenario dice qué clase de Locust corre, con cuántos usuarios simulados, a qué ritmo entran y cuánto dura.
El criterio es el de RNF06 (Entrega 1): las consultas responden en menos de 2 s en el percentil 95 y con menos
de 1 % de errores, con 50 usuarios simulados durante 5 minutos. Las escrituras, la exportación, el estrés y el pico se miden con el mismo
umbral, pero su resultado es de referencia: RNF06 solo obliga a las consultas.

ORDEN: las de ms-reportes van primero a propósito. Las altas de K04 y K06 agrandan el catálogo, y los reportes recorren TODOS los productos:
con miles de productos nuevos medirían el catálogo y no el servicio de reportes.
"""

# tipo: carga (RNF06), escritura, exportacion, estres o pico.
# obligatorio: True si el escenario verifica RNF06; False si es de referencia.
ESCENARIOS = [
    # ---------------- ms-reportes ----------------
    {"id": "R01", "archivo": "reportes.py", "clase": "ExistenciasYValorizacion", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Existencias por producto y bodega, y valorización (GET /reportes/existencias y /reportes/valorizacion)"},
    {"id": "R02", "archivo": "reportes.py", "clase": "RotacionEIndicadores", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Rotación de 30 días y panel de indicadores (GET /reportes/rotacion y /indicadores)"},
    {"id": "R03", "archivo": "reportes.py", "clase": "KardexFiltrado", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Kardex de un producto, con y sin periodo (GET /reportes/kardex)"},
    {"id": "R04", "archivo": "reportes.py", "clase": "DescargasCsvYPdf", "tipo": "exportacion", "obligatorio": False,
     "usuarios": 30, "tasa": 5, "duracion": "3m",
     "descripcion": "Los reportes como archivo: CSV de existencias y de kardex, y PDF de valorización"},
    {"id": "R05", "archivo": "reportes.py", "clase": "EstresReportes", "tipo": "estres", "obligatorio": False,
     "usuarios": 200, "tasa": 1, "duracion": "5m",
     "descripcion": "Estrés: de 0 a 200 usuarios, uno por segundo, sobre todos los reportes en JSON, para hallar el punto de quiebre"},
    # ---------------- ms-catalogo ----------------
    {"id": "K01", "archivo": "catalogo.py", "clase": "ListadoProductos", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado paginado de productos (GET /productos)"},
    {"id": "K02", "archivo": "catalogo.py", "clase": "BusquedaDeProductos", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Búsqueda de productos por nombre, por código y por categoría (GET /productos con filtros)"},
    {"id": "K03", "archivo": "catalogo.py", "clase": "ConsultaPuntual", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Un producto, el árbol de categorías y una categoría (GET /productos/{id}, /categorias, /categorias/{id})"},
    {"id": "K04", "archivo": "catalogo.py", "clase": "AltaDeProductos", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Altas de productos a la vez (POST /productos), con código único"},
    {"id": "K05", "archivo": "catalogo.py", "clase": "EstresCatalogo", "tipo": "estres", "obligatorio": False,
     "usuarios": 200, "tasa": 1, "duracion": "5m",
     "descripcion": "Estrés: de 0 a 200 usuarios, uno por segundo, sobre el listado, la búsqueda y la consulta de productos"},
    {"id": "K06", "archivo": "catalogo.py", "clase": "PicoCatalogo", "tipo": "pico", "obligatorio": False,
     "usuarios": 200, "tasa": 100, "duracion": "2m",
     "descripcion": "Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna alta)"},
    # ---------------- ms-proveedores ----------------
    {"id": "P01", "archivo": "proveedores.py", "clase": "ListadoProveedores", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado de proveedores, por razón social y por producto (GET /proveedores)"},
    {"id": "P02", "archivo": "proveedores.py", "clase": "ProveedorConSusProductos", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Un proveedor y sus productos asociados (GET /proveedores/{id} y /proveedores/{id}/productos)"},
    {"id": "P03", "archivo": "proveedores.py", "clase": "AltaDeProveedores", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Altas de proveedores a la vez (POST /proveedores), con NIT único"},
    {"id": "P04", "archivo": "proveedores.py", "clase": "PicoProveedores", "tipo": "pico", "obligatorio": False,
     "usuarios": 200, "tasa": 100, "duracion": "2m",
     "descripcion": "Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna alta)"},
]
