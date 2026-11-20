# Resultados de las pruebas de rendimiento — Brayan Collazos

Generado el 2026-11-16 22:44 · modo `directo`

Entorno: MacBook Pro Apple M5 Pro (24 GB), sin Gateway (modo directo): ms-inventario (Node) y PostgreSQL en contenedor locales; ms-catalogo es el servidor de desarrollo de PHP con SQLite. Es una medición local de desarrollo, no del despliegue en Kubernetes. Mientras corrían I01 a I03 el mismo equipo se usaba para otras tareas (instalaciones, pruebas), por eso el máximo de I03 (436 ms) sobresale; su percentil 95 no cambia el veredicto.

Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia (escritura, integración, contención,
estrés y pico) se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas.

| Prueba | Tipo | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |
|---|---|---|---|---|---|---|---|---|---|
| I01 ListadoSaldos | carga | 9808 | 0 (0.00%) | 4 | 6 | 8 | 34 | 32.7 | CUMPLE |
| I02 SaldosDeProducto | carga | 9798 | 0 (0.00%) | 4 | 6 | 8 | 33 | 32.7 | CUMPLE |
| I03 KardexConFiltros | carga | 9786 | 0 (0.00%) | 5 | 7 | 12 | 436 | 32.6 | CUMPLE |
| I04 LotesFefo | carga | 9821 | 0 (0.00%) | 4 | 6 | 9 | 29 | 32.8 | CUMPLE |
| I05 SugerenciaFefo | carga | 9788 | 0 (0.00%) | 3 | 5 | 6 | 84 | 32.6 | CUMPLE |
| I06 BodegasYUmbrales | carga | 9785 | 0 (0.00%) | 4 | 6 | 7 | 44 | 32.6 | CUMPLE |
| I07 BajoUmbral | carga | 9836 | 0 (0.00%) | 3 | 5 | 6 | 30 | 32.8 | CUMPLE |
| I08 TrasladosYConteos | carga | 9794 | 0 (0.00%) | 4 | 7 | 10 | 34 | 32.7 | CUMPLE |
| I09 RegistrarEntradas | escritura | 9758 | 0 (0.00%) | 15 | 22 | 28 | 229 | 32.6 | dentro del umbral |
| I10 SalidasConFefo | escritura | 19352 | 0 (0.00%) | 13 | 21 | 28 | 97 | 64.6 | dentro del umbral |
| I11 IdempotenciaReintentos | idempotencia | 28834 | 0 (0.00%) | 2 | 16 | 21 | 105 | 160.9 | dentro del umbral |
| I12 SalidasMismoSaldo | contencion | 14417 | 0 (0.00%) | 15 | 24 | 36 | 533 | 80.4 | dentro del umbral |
| I13 CicloTraslado | integracion | 7650 | 0 (0.00%) | 14 | 24 | 31 | 68 | 25.5 | dentro del umbral |
| I14 EstresConsultas | estres | 26592 | 0 (0.00%) | 5 | 11 | 13 | 50 | 88.8 | dentro del umbral |
| I15 PicoMixto | pico | 15584 | 0 (0.00%) | 4 | 17 | 91 | 157 | 130.8 | dentro del umbral |

## Detalle por operación

### I01 — Listado paginado de saldos por producto y bodega (GET /saldos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /saldos` | 9808 | 0 | 6 |

### I02 — Saldos de un producto con su total y de una bodega (?id_producto, ?id_bodega)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /saldos?id_bodega` | 4889 | 0 | 6 |
| `GET GET /saldos?id_producto` | 4909 | 0 | 6 |

### I03 — Kardex paginado y filtrado por tipo, bodega, producto y fechas (GET /movimientos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /movimientos` | 4204 | 0 | 7 |
| `GET GET /movimientos?fechas&id_producto` | 2727 | 0 | 7 |
| `GET GET /movimientos?tipo&id_bodega` | 2855 | 0 | 8 |

### I04 — Lotes con existencia en orden FEFO, por vencer y por producto (GET /lotes)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /lotes?id_producto&id_bodega` | 3256 | 0 | 6 |
| `GET GET /lotes?vence_antes_de` | 6565 | 0 | 6 |

### I05 — De qué lotes sacar una cantidad, por FEFO (GET /lotes/sugerencia-salida)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /lotes/sugerencia-salida` | 9788 | 0 | 5 |

### I06 — Bodegas y umbrales de stock mínimo (GET /bodegas, /bodegas/{id}, /umbrales)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /bodegas` | 3929 | 0 | 6 |
| `GET GET /bodegas/{id}` | 1936 | 0 | 5 |
| `GET GET /umbrales` | 3920 | 0 | 6 |

### I07 — Productos bajo su mínimo, sumados entre bodegas (GET /saldos/bajo-umbral)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /saldos/bajo-umbral` | 9836 | 0 | 5 |

### I08 — Listados de traslados (también en tránsito) y de conteos (GET /traslados, /conteos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /conteos` | 3861 | 0 | 6 |
| `GET GET /traslados` | 3915 | 0 | 7 |
| `GET GET /traslados?estado` | 2018 | 0 | 7 |

### I09 — Entradas de mercancía a la vez (POST /movimientos): una transacción por movimiento, con clave de idempotencia

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (ENTRADA)` | 9758 | 0 | 22 |

### I10 — Salidas que consumen el lote que vence primero, con su reposición (POST /movimientos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (ENTRADA de reposición)` | 9676 | 0 | 18 |
| `POST POST /movimientos (SALIDA)` | 9676 | 0 | 23 |

### I11 — El mismo movimiento reintentado con la misma clave devuelve el original sin duplicarse (RNF17)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (primer intento)` | 11532 | 0 | 19 |
| `POST POST /movimientos (reintento)` | 17302 | 0 | 2 |

### I12 — Salidas simultáneas sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (SALIDA mismo saldo)` | 14417 | 0 | 24 |

### I13 — Enviar un traslado y recibirlo: inventario valida el producto en catálogo en cada paso

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /traslados` | 3825 | 0 | 27 |
| `POST POST /traslados/{id}/recepcion` | 3825 | 0 | 11 |

### I14 — Estrés: de 0 a 200 usuarios, uno por segundo, sobre saldos, kardex y lotes, para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /lotes?vence_antes_de` | 3804 | 0 | 6 |
| `GET GET /movimientos` | 11374 | 0 | 12 |
| `GET GET /saldos` | 11414 | 0 | 6 |

### I15 — Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna entrada)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /bodegas` | 1936 | 0 | 6 |
| `GET GET /movimientos` | 3933 | 0 | 12 |
| `GET GET /saldos` | 7763 | 0 | 6 |
| `POST POST /movimientos (ENTRADA)` | 1952 | 0 | 22 |
