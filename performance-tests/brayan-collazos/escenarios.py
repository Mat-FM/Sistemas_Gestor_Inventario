"""Las 15 pruebas de rendimiento de Brayan Collazos: 7 del API Gateway (G01 a G07) y 8 de ms-inventario (I01 a I08).

Cada escenario dice qué clase de Locust corre, con cuántos usuarios simulados, a qué ritmo entran y cuánto dura.
El criterio es el de RNF06 (Entrega 1): las consultas responden en menos de 2 s en el percentil 95 y con menos
de 1 % de errores, con 50 usuarios simulados durante 5 minutos. Las escrituras, la idempotencia, la contención, el
estrés y el pico se miden con el mismo umbral, pero su resultado es de referencia: RNF06 solo obliga a las consultas.
"""

# tipo: carga (RNF06), escritura, idempotencia, contencion, estres o pico.
# obligatorio: True si el escenario verifica RNF06; False si es de referencia.
ESCENARIOS = [
    # ---------------- API Gateway ----------------
    {"id": "G01", "archivo": "gateway.py", "clase": "SaludDelGateway", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "GET /health: lo mínimo que cuesta una petición al Gateway (sin sesión ni base de datos)"},
    {"id": "G02", "archivo": "gateway.py", "clase": "UsuariosYRoles", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Usuarios y roles, que resuelve el propio Gateway con su base MySQL (JWT, usuario releído en cada petición)"},
    {"id": "G03", "archivo": "gateway.py", "clase": "ProxyACatalogo", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Consultas de productos y categorías reenviadas a ms-catalogo"},
    {"id": "G04", "archivo": "gateway.py", "clase": "ProxyAInventario", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Saldos, kardex y bodegas reenviados a ms-inventario"},
    {"id": "G05", "archivo": "gateway.py", "clase": "EscrituraPorElGateway", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "POST /movimientos por el Gateway, con su Idempotency-Key, hacia ms-inventario (que valida con ms-catalogo)"},
    {"id": "G06", "archivo": "gateway.py", "clase": "EstresDelGateway", "tipo": "estres", "obligatorio": False,
     "usuarios": 200, "tasa": 1, "duracion": "5m",
     "descripcion": "Estrés: de 0 a 200 usuarios, uno por segundo, con consultas a catálogo, inventario y usuarios, para hallar el punto de quiebre"},
    {"id": "G07", "archivo": "gateway.py", "clase": "PicoDelGateway", "tipo": "pico", "obligatorio": False,
     "usuarios": 200, "tasa": 100, "duracion": "2m",
     "descripcion": "Pico: 200 usuarios en 2 s con el uso típico de la interfaz (consultas y alguna entrada)"},
    # ---------------- ms-inventario ----------------
    {"id": "I01", "archivo": "inventario.py", "clase": "ListadoSaldos", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado paginado de saldos por producto y bodega (GET /saldos)"},
    {"id": "I02", "archivo": "inventario.py", "clase": "KardexConFiltros", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Kardex paginado y filtrado por tipo, bodega, producto y fechas (GET /movimientos)"},
    {"id": "I03", "archivo": "inventario.py", "clase": "LotesFefo", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Lotes con existencia en orden FEFO, por vencer y por producto (GET /lotes)"},
    {"id": "I04", "archivo": "inventario.py", "clase": "RegistrarEntradas", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Entradas de mercancía a la vez (POST /movimientos): una transacción por movimiento, con clave de idempotencia"},
    {"id": "I05", "archivo": "inventario.py", "clase": "IdempotenciaReintentos", "tipo": "idempotencia", "obligatorio": False,
     "usuarios": 50, "tasa": 10, "duracion": "3m",
     "descripcion": "El mismo movimiento reintentado con la misma clave devuelve el original sin duplicarse (RNF17)"},
    {"id": "I06", "archivo": "inventario.py", "clase": "SalidasMismoSaldo", "tipo": "contencion", "obligatorio": False,
     "usuarios": 30, "tasa": 10, "duracion": "3m",
     "descripcion": "Salidas simultáneas sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores"},
    {"id": "I07", "archivo": "inventario.py", "clase": "EstresConsultas", "tipo": "estres", "obligatorio": False,
     "usuarios": 200, "tasa": 1, "duracion": "5m",
     "descripcion": "Estrés: de 0 a 200 usuarios, uno por segundo, sobre saldos, kardex y lotes, para hallar el punto de quiebre"},
    {"id": "I08", "archivo": "inventario.py", "clase": "PicoMixto", "tipo": "pico", "obligatorio": False,
     "usuarios": 200, "tasa": 100, "duracion": "2m",
     "descripcion": "Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna entrada)"},
]
