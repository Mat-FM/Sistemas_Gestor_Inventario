"""Las 15 pruebas de rendimiento de Brayan Collazos sobre el API Gateway (G01 a G06) y ms-inventario (I01 a I06), más la mezcla de ambos
con las tipologías de la guía del taller: carga (M01), estrés (E01) y capacidad (S01).

Cada escenario dice qué clase de Locust corre, con cuántos usuarios simulados, a qué ritmo entran (spawn rate) y cuánto dura.

- `tipologia`: la de la guía del taller (carga, estres o capacidad).
- `tipo`: qué ejercita (consulta, escritura, idempotencia, contencion, sesion, mezcla).
- `obligatorio`: True si verifica RNF06 (Entrega 1): las consultas responden en menos de 2 s en el percentil 95 y con menos de 1 % de
  errores, con 50 usuarios durante 5 minutos. Los demás se comparan con el mismo umbral, pero son de referencia.
- `historial`: guarda el historial segundo a segundo de Locust; resumen.py lo usa para el punto de quiebre (E01) y la tendencia (S01).

ORDEN: consultas, luego la mezcla y las escrituras al final. Las escrituras agregan miles de movimientos y cambian lo que leen las pruebas
siguientes; la mezcla (que también escribe un poco) va antes de ellas para que S01 mida el sistema y no un kardex que ya creció.
Si se corren por separado, respetar el mismo orden y preferir una pila nueva.
"""
import os

# S01 debe correr cerca del máximo ESTABLE (no del quiebre): ~70 % de los usuarios en que E01 llegó a su meseta de rendimiento. En la medición
# local, E01 se estancó en ~97 peticiones/s con ~172 usuarios (ver RESULTADOS.md): 70 % = 120. Se ajusta con PERF_CAPACIDAD_USUARIOS.
USUARIOS_CAPACIDAD = int(os.environ.get("PERF_CAPACIDAD_USUARIOS", "120"))

ESCENARIOS = [
    # ---------------- API Gateway: consultas ----------------
    {"id": "G01", "archivo": "gateway.py", "clase": "SaludDelGateway", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "GET /health: lo mínimo que cuesta una petición al Gateway (sin sesión ni base de datos)"},
    {"id": "G02", "archivo": "gateway.py", "clase": "UsuariosYRoles", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Usuarios y roles, que resuelve el propio Gateway con su base MySQL (JWT, usuario releído en cada petición)"},
    {"id": "G03", "archivo": "gateway.py", "clase": "ProxyACatalogo", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Consultas de productos y categorías reenviadas a ms-catalogo"},
    {"id": "G04", "archivo": "gateway.py", "clase": "ProxyAInventario", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Saldos, kardex y bodegas reenviados a ms-inventario"},
    # ---------------- ms-inventario: consultas ----------------
    {"id": "I01", "archivo": "inventario.py", "clase": "ListadoSaldos", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado paginado de saldos por producto y bodega (GET /saldos)"},
    {"id": "I02", "archivo": "inventario.py", "clase": "KardexConFiltros", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Kardex paginado y filtrado por tipo, bodega, producto y fechas (GET /movimientos)"},
    {"id": "I03", "archivo": "inventario.py", "clase": "LotesFefo", "tipologia": "carga", "tipo": "consulta", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Lotes con existencia en orden FEFO, por vencer y por producto (GET /lotes)"},
    # ---------------- Mezcla: tipologías de la guía del taller ----------------
    {"id": "M01", "archivo": "mixto.py", "clase": "CargaMixta", "tipologia": "carga", "tipo": "mezcla", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "10m", "historial": True,
     "descripcion": "Carga: ~85 % GET y ~15 % POST por el Gateway hacia ms-inventario y ms-catalogo, 50 usuarios en meseta"},
    {"id": "E01", "archivo": "mixto.py", "clase": "EstresMixto", "tipologia": "estres", "tipo": "mezcla", "obligatorio": False,
     "usuarios": 300, "tasa": 2, "duracion": "5m", "historial": True,
     "descripcion": "Estrés: la misma mezcla con una rampa hasta 300 usuarios (2 por segundo), para hallar el punto de quiebre"},
    {"id": "S01", "archivo": "mixto.py", "clase": "CapacidadMixta", "tipologia": "capacidad", "tipo": "mezcla", "obligatorio": False,
     "usuarios": USUARIOS_CAPACIDAD, "tasa": 5, "duracion": "60m", "historial": True,
     "descripcion": f"Capacidad (soak): la misma mezcla con {USUARIOS_CAPACIDAD} usuarios durante 60 min, para ver la tendencia en el tiempo"},
    # ---------------- Escrituras e inicio de sesión (agrandan los datos: van al final) ----------------
    {"id": "G05", "archivo": "gateway.py", "clase": "EscrituraPorElGateway", "tipologia": "carga", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "POST /movimientos por el Gateway, con su Idempotency-Key, hacia ms-inventario (que valida con ms-catalogo)"},
    {"id": "G06", "archivo": "gateway.py", "clase": "InicioDeSesion", "tipologia": "carga", "tipo": "sesion", "obligatorio": False,
     "usuarios": 10, "tasa": 2, "duracion": "3m",
     "descripcion": "POST /auth/login: lo que cuesta emitir un token (contraseña con bcrypt y firma del JWT)"},
    {"id": "I04", "archivo": "inventario.py", "clase": "RegistrarEntradas", "tipologia": "carga", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Entradas de mercancía a la vez (POST /movimientos): una transacción por movimiento, con clave de idempotencia"},
    {"id": "I05", "archivo": "inventario.py", "clase": "IdempotenciaReintentos", "tipologia": "carga", "tipo": "idempotencia", "obligatorio": False,
     "usuarios": 50, "tasa": 10, "duracion": "3m",
     "descripcion": "El mismo movimiento reintentado con la misma clave devuelve el original sin duplicarse (RNF17)"},
    {"id": "I06", "archivo": "inventario.py", "clase": "SalidasMismoSaldo", "tipologia": "carga", "tipo": "contencion", "obligatorio": False,
     "usuarios": 30, "tasa": 10, "duracion": "3m",
     "descripcion": "Salidas simultáneas sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores"},
]
