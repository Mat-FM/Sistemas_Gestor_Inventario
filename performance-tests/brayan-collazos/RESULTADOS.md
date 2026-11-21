# Resultados de las pruebas de rendimiento — Brayan Collazos (API Gateway y ms-inventario)

Generado el 2026-11-21 12:11. La columna «Vía» dice cómo llegó cada prueba: `gateway` (por el API Gateway, con sesión) o `directo` (a ms-inventario)

Entorno: MacBook Pro Apple M5 Pro (24 GB), sistema completo con Docker Compose (imágenes del repositorio, un contenedor por servicio y por base de datos). Las pruebas G van por el API Gateway con una sola cuenta de administrador y con sus límites de peticiones subidos (RATE_LIMIT_PER_MINUTE=100000 y LOGIN_RATE_LIMIT_PER_MINUTE=1000), para medir el Gateway y no el limitador (RNF19); las pruebas I van directo a ms-inventario. Es una medición local de desarrollo, con el generador de carga en el mismo equipo; no es el despliegue en Kubernetes.

Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia (escritura, integración, contención,
estrés y pico) se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas.

| Prueba | Vía | Tipo | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |
|---|---|---|---|---|---|---|---|---|---|---|
| G01 SaludDelGateway | gateway | carga | 9516 | 0 (0.00%) | 8 | 13 | 28 | 6190 | 31.7 | CUMPLE |
| G02 UsuariosYRoles | gateway | carga | 9535 | 0 (0.00%) | 21 | 38 | 110 | 2415 | 31.8 | CUMPLE |
| G03 ProxyACatalogo | gateway | carga | 9432 | 0 (0.00%) | 35 | 59 | 120 | 2579 | 31.5 | CUMPLE |
| G04 ProxyAInventario | gateway | carga | 9431 | 1 (0.01%) | 26 | 46 | 88 | 1787 | 31.5 | CUMPLE |
| G05 EscrituraPorElGateway | gateway | escritura | 9247 | 0 (0.00%) | 47 | 100 | 180 | 2369 | 30.8 | dentro del umbral |
| G06 EstresDelGateway | gateway | estres | 19478 | 46 (0.24%) | 130 | 840 | 1600 | 72139 | 64.9 | dentro del umbral |
| G07 PicoDelGateway | gateway | pico | 8969 | 9 (0.10%) | 270 | 780 | 1400 | 114138 | 71.6 | dentro del umbral |
| I01 ListadoSaldos | directo | carga | 9741 | 0 (0.00%) | 4 | 7 | 12 | 56 | 32.5 | CUMPLE |
| I02 KardexConFiltros | directo | carga | 9748 | 0 (0.00%) | 7 | 10 | 18 | 85 | 32.5 | CUMPLE |
| I03 LotesFefo | directo | carga | 9760 | 0 (0.00%) | 4 | 7 | 13 | 62 | 32.6 | CUMPLE |
| I04 RegistrarEntradas | directo | escritura | 9680 | 0 (0.00%) | 21 | 35 | 56 | 2510 | 32.3 | dentro del umbral |
| I05 IdempotenciaReintentos | directo | idempotencia | 27268 | 0 (0.00%) | 7 | 64 | 180 | 1731 | 152.0 | dentro del umbral |
| I06 SalidasMismoSaldo | directo | contencion | 12843 | 0 (0.00%) | 38 | 150 | 270 | 731 | 71.6 | dentro del umbral |
| I07 EstresConsultas | directo | estres | 26607 | 0 (0.00%) | 6 | 13 | 23 | 141 | 88.8 | dentro del umbral |
| I08 PicoMixto | directo | pico | 15115 | 0 (0.00%) | 6 | 34 | 350 | 978 | 126.7 | dentro del umbral |

## Detalle por operación

### G01 — GET /health: lo mínimo que cuesta una petición al Gateway (sin sesión ni base de datos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /health` | 9516 | 0 | 13 |

### G02 — Usuarios y roles, que resuelve el propio Gateway con su base MySQL (JWT, usuario releído en cada petición)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/roles` | 2428 | 0 | 35 |
| `GET GET /api/usuarios` | 7107 | 0 | 39 |

### G03 — Consultas de productos y categorías reenviadas a ms-catalogo

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/categorias` | 1924 | 0 | 57 |
| `GET GET /api/productos` | 5637 | 0 | 58 |
| `GET GET /api/productos?nombre` | 1871 | 0 | 61 |

### G04 — Saldos, kardex y bodegas reenviados a ms-inventario

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/bodegas` | 1890 | 0 | 46 |
| `GET GET /api/movimientos` | 3782 | 0 | 45 |
| `GET GET /api/saldos` | 3759 | 1 | 46 |

### G05 — POST /movimientos por el Gateway, con su Idempotency-Key, hacia ms-inventario (que valida con ms-catalogo)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /api/movimientos` | 9247 | 0 | 100 |

### G06 — Estrés: de 0 a 200 usuarios, uno por segundo, con consultas a catálogo, inventario y usuarios, para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/movimientos` | 2124 | 8 | 830 |
| `GET GET /api/productos` | 6571 | 16 | 870 |
| `GET GET /api/saldos` | 6403 | 15 | 810 |
| `GET GET /api/usuarios` | 4380 | 7 | 810 |

### G07 — Pico: 200 usuarios en 2 s con el uso típico de la interfaz (consultas y alguna entrada)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/movimientos` | 1374 | 1 | 770 |
| `GET GET /api/productos` | 2753 | 1 | 780 |
| `GET GET /api/saldos` | 4120 | 6 | 780 |
| `POST POST /api/movimientos` | 722 | 1 | 810 |

### I01 — Listado paginado de saldos por producto y bodega (GET /saldos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /saldos` | 9741 | 0 | 7 |

### I02 — Kardex paginado y filtrado por tipo, bodega, producto y fechas (GET /movimientos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /movimientos` | 4148 | 0 | 9 |
| `GET GET /movimientos?fechas&id_producto` | 2769 | 0 | 11 |
| `GET GET /movimientos?tipo&id_bodega` | 2831 | 0 | 10 |

### I03 — Lotes con existencia en orden FEFO, por vencer y por producto (GET /lotes)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /lotes?id_producto&id_bodega` | 3273 | 0 | 7 |
| `GET GET /lotes?vence_antes_de` | 6487 | 0 | 7 |

### I04 — Entradas de mercancía a la vez (POST /movimientos): una transacción por movimiento, con clave de idempotencia

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (ENTRADA)` | 9680 | 0 | 35 |

### I05 — El mismo movimiento reintentado con la misma clave devuelve el original sin duplicarse (RNF17)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (primer intento)` | 10930 | 0 | 110 |
| `POST POST /movimientos (reintento)` | 16338 | 0 | 13 |

### I06 — Salidas simultáneas sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (SALIDA mismo saldo)` | 12843 | 0 | 150 |

### I07 — Estrés: de 0 a 200 usuarios, uno por segundo, sobre saldos, kardex y lotes, para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /lotes?vence_antes_de` | 3855 | 0 | 10 |
| `GET GET /movimientos` | 11492 | 0 | 15 |
| `GET GET /saldos` | 11260 | 0 | 9 |

### I08 — Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna entrada)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /bodegas` | 1939 | 0 | 16 |
| `GET GET /movimientos` | 3801 | 0 | 22 |
| `GET GET /saldos` | 7509 | 0 | 18 |
| `POST POST /movimientos (ENTRADA)` | 1866 | 0 | 74 |
