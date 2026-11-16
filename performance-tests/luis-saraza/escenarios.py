"""Las 15 pruebas de rendimiento de Luis Saraza (ms-compras y ms-notificaciones).

Cada escenario dice qué clase de Locust corre, con cuántos usuarios simulados, a qué ritmo entran y cuánto dura.
El criterio es el de RNF06 (Entrega 1): las consultas responden en menos de 2 s en el percentil 95 y con menos
de 1 % de errores, con 50 usuarios simulados durante 5 minutos. Las escrituras, el estrés y el pico se miden con
el mismo umbral, pero su resultado es de referencia: RNF06 solo obliga a las consultas.
"""

# tipo: carga (RNF06), escritura, integracion, contencion, estres o pico.
# obligatorio: True si el escenario verifica RNF06; False si es de referencia.
ESCENARIOS = [
    # ---------------- ms-compras ----------------
    {"id": "C01", "archivo": "compras.py", "clase": "ListadoOrdenes", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado paginado de órdenes de compra (GET /ordenes-compra)"},
    {"id": "C02", "archivo": "compras.py", "clase": "FiltrosOrdenes", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado de órdenes con filtros de estado, bodega y fechas"},
    {"id": "C03", "archivo": "compras.py", "clase": "DetalleOrden", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Detalle de una orden con sus líneas y recepciones (GET /ordenes-compra/{id})"},
    {"id": "C04", "archivo": "compras.py", "clase": "RecepcionesDeOrden", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Recepciones de una orden (GET /ordenes-compra/{id}/recepciones)"},
    {"id": "C05", "archivo": "compras.py", "clase": "ListadoDevoluciones", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Listado de devoluciones a proveedor (GET /devoluciones-proveedor)"},
    {"id": "C06", "archivo": "compras.py", "clase": "CrearOrdenes", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Creación de órdenes (POST /ordenes-compra): número consecutivo bajo concurrencia"},
    {"id": "C07", "archivo": "compras.py", "clase": "CicloCompleto", "tipo": "integracion", "obligatorio": False,
     "usuarios": 20, "tasa": 2, "duracion": "5m",
     "descripcion": "Crear → enviar → recibir con lote: compras llama a inventario (y este a catálogo) y avisa a notificaciones"},
    {"id": "C08", "archivo": "compras.py", "clase": "RecepcionesConcurrentes", "tipo": "contencion", "obligatorio": False,
     "usuarios": 30, "tasa": 10, "duracion": "3m",
     "descripcion": "Recepciones simultáneas sobre la MISMA orden (candado por orden en PostgreSQL)"},
    {"id": "C09", "archivo": "compras.py", "clase": "EstresListado", "tipo": "estres", "obligatorio": False,
     "usuarios": 200, "tasa": 1, "duracion": "5m",
     "descripcion": "Estrés: de 0 a 200 usuarios, uno por segundo, sobre consultas de órdenes, para hallar el punto de quiebre"},
    # ---------------- ms-notificaciones ----------------
    {"id": "N01", "archivo": "notificaciones.py", "clase": "ListadoNotificaciones", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Notificaciones del rol del usuario (GET /notificaciones)"},
    {"id": "N02", "archivo": "notificaciones.py", "clase": "FiltrosNotificaciones", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Notificaciones sin leer y por tipo, y marcar como leída (?leida, ?tipo, POST /leida)"},
    {"id": "N03", "archivo": "notificaciones.py", "clase": "PreferenciasYConfiguracion", "tipo": "carga", "obligatorio": True,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Preferencia de correo de cada usuario (GET/PUT /preferencias/mia) y configuración de alertas"},
    {"id": "N04", "archivo": "notificaciones.py", "clase": "AvisosInternos", "tipo": "escritura", "obligatorio": False,
     "usuarios": 50, "tasa": 5, "duracion": "5m",
     "descripcion": "Avisos de ms-inventario y ms-compras (POST /internas/notificaciones), siempre nuevos"},
    {"id": "N05", "archivo": "notificaciones.py", "clase": "AvisosDuplicados", "tipo": "contencion", "obligatorio": False,
     "usuarios": 50, "tasa": 10, "duracion": "3m",
     "descripcion": "Avisos repetidos de STOCK_BAJO para pocos productos: el índice único evita duplicados bajo concurrencia"},
    {"id": "N06", "archivo": "notificaciones.py", "clase": "PicoMixto", "tipo": "pico", "obligatorio": False,
     "usuarios": 200, "tasa": 100, "duracion": "2m",
     "descripcion": "Pico: 200 usuarios en 2 s con el uso típico (consultar, leer, avisos entrantes)"},
]
