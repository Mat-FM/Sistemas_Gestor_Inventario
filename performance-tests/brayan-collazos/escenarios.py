"""Las 15 pruebas de rendimiento de Brayan Collazos (ms-inventario).

Cada escenario dice qué clase de Locust corre, con cuántos usuarios simulados, a qué ritmo entran y cuánto dura.
El criterio es el de RNF06 (Entrega 1): las consultas responden en menos de 2 s en el percentil 95 y con menos
de 1 % de errores, con 50 usuarios simulados durante 5 minutos. Las escrituras, la idempotencia, la contención, el
estrés y el pico se miden con el mismo umbral, pero su resultado es de referencia: RNF06 solo obliga a las consultas.
"""

# tipo: carga (RNF06), escritura, idempotencia, contencion, integracion, estres o pico.
# obligatorio: True si el escenario verifica RNF06; False si es de referencia.
ESCENARIOS = [
    {"id": "I01", "archivo": "inventario.py", "clase": "ListadoSaldos", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado paginado de saldos por producto y bodega (GET /saldos)"},
    {"id": "I02", "archivo": "inventario.py", "clase": "SaldosDeProducto", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Saldos de un producto con su total y de una bodega (?id_producto, ?id_bodega)"},
    {"id": "I03", "archivo": "inventario.py", "clase": "KardexConFiltros", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Kardex paginado y filtrado por tipo, bodega, producto y fechas (GET /movimientos)"},
    {"id": "I04", "archivo": "inventario.py", "clase": "LotesFefo", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Lotes con existencia en orden FEFO, por vencer y por producto (GET /lotes)"},
    {"id": "I05", "archivo": "inventario.py", "clase": "SugerenciaFefo", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "De qué lotes sacar una cantidad, por FEFO (GET /lotes/sugerencia-salida)"},
    {"id": "I06", "archivo": "inventario.py", "clase": "BodegasYUmbrales", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Bodegas y umbrales de stock mínimo (GET /bodegas, /bodegas/{id}, /umbrales)"},
    {"id": "I07", "archivo": "inventario.py", "clase": "BajoUmbral", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Productos bajo su mínimo, sumados entre bodegas (GET /saldos/bajo-umbral)"},
    {"id": "I08", "archivo": "inventario.py", "clase": "TrasladosYConteos", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listados de traslados (también en tránsito) y de conteos (GET /traslados, /conteos)"},
    {"id": "I09", "archivo": "inventario.py", "clase": "RegistrarEntradas", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Entradas de mercancía a la vez (POST /movimientos): una transacción por movimiento, con clave de idempotencia"},
    {"id": "I10", "archivo": "inventario.py", "clase": "SalidasConFefo", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Salidas que consumen el lote que vence primero, con su reposición (POST /movimientos)"},
    {"id": "I11", "archivo": "inventario.py", "clase": "IdempotenciaReintentos", "tipo": "idempotencia", "obligatorio": False,
     "usuarios": 50, "tasa": 10, "duracion": "3m",
     "descripcion": "El mismo movimiento reintentado con la misma clave devuelve el original sin duplicarse (RNF17)"},
    {"id": "I12", "archivo": "inventario.py", "clase": "SalidasMismoSaldo", "tipo": "contencion", "obligatorio": False,
     "usuarios": 30, "tasa": 10, "duracion": "3m",
     "descripcion": "Salidas simultáneas sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores"},
    {"id": "I13", "archivo": "inventario.py", "clase": "CicloTraslado", "tipo": "integracion", "obligatorio": False,
     "usuarios": 20, "tasa": 2, "duracion": "5m",
     "descripcion": "Enviar un traslado y recibirlo: inventario valida el producto en catálogo en cada paso"},
    {"id": "I14", "archivo": "inventario.py", "clase": "EstresConsultas", "tipo": "estres", "obligatorio": False,
     "usuarios": 200, "tasa": 1, "duracion": "5m",
     "descripcion": "Estrés: de 0 a 200 usuarios, uno por segundo, sobre saldos, kardex y lotes, para hallar el punto de quiebre"},
    {"id": "I15", "archivo": "inventario.py", "clase": "PicoMixto", "tipo": "pico", "obligatorio": False,
     "usuarios": 200, "tasa": 100, "duracion": "2m",
     "descripcion": "Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna entrada)"},
]
