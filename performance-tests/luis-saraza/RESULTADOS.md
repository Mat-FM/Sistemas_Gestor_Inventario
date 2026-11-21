# Resultados de las pruebas de rendimiento — Luis Saraza

Generado el 2026-11-21 16:03 · modo `directo` · **resultados preliminares: los usuarios de cada escenario, 1m por prueba**

Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia (escritura, integración, contención,
estrés y pico) se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas.

| Prueba | Tipo | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |
|---|---|---|---|---|---|---|---|---|---|
| C01 ListadoOrdenes | carga | 1846 | 0 (0.00%) | 6 | 10 | 26 | 43 | 31.3 | CUMPLE |
| C02 FiltrosOrdenes | carga | 1819 | 0 (0.00%) | 7 | 11 | 18 | 78 | 30.8 | CUMPLE |
| C03 DetalleOrden | carga | 1832 | 0 (0.00%) | 6 | 10 | 21 | 80 | 31.0 | CUMPLE |
| C04 RecepcionesDeOrden | carga | 1823 | 0 (0.00%) | 6 | 9 | 16 | 52 | 30.9 | CUMPLE |
| C05 ListadoDevoluciones | carga | 1838 | 0 (0.00%) | 6 | 10 | 15 | 39 | 31.1 | CUMPLE |
| C06 CrearOrdenes | escritura | 1837 | 0 (0.00%) | 11 | 16 | 21 | 61 | 31.1 | dentro del umbral |
| C07 CicloCompleto | integracion | 2775 | 0 (0.00%) | 12 | 77 | 93 | 120 | 47.0 | dentro del umbral |
| C08 RecepcionesConcurrentes | contencion | 1048 | 0 (0.00%) | 180 | 380 | 450 | 519 | 17.7 | dentro del umbral |
| C09 EstresListado | estres | 1203 | 0 (0.00%) | 7 | 10 | 13 | 35 | 20.4 | dentro del umbral |
| N01 ListadoNotificaciones | carga | 1840 | 1 (0.05%) | 9 | 13 | 28 | 73 | 31.2 | CUMPLE |
| N02 FiltrosNotificaciones | carga | 2145 | 1 (0.05%) | 9 | 15 | 28 | 75 | 36.3 | CUMPLE |
| N03 PreferenciasYConfiguracion | carga | 1823 | 0 (0.00%) | 6 | 12 | 25 | 50 | 30.9 | CUMPLE |
| N04 AvisosInternos | escritura | 1824 | 1 (0.05%) | 8 | 13 | 25 | 79 | 30.9 | dentro del umbral |
| N05 AvisosDuplicados | contencion | 1911 | 0 (0.00%) | 6 | 11 | 60 | 81 | 32.3 | dentro del umbral |
| N06 PicoMixto | pico | 7594 | 11 (0.14%) | 9 | 22 | 440 | 662 | 128.4 | dentro del umbral |

## Detalle por operación

### C01 — Listado paginado de órdenes de compra (GET /ordenes-compra)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /ordenes-compra` | 1846 | 0 | 10 |

### C02 — Listado de órdenes con filtros de estado, bodega y fechas

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /ordenes-compra?estado` | 930 | 0 | 10 |
| `GET /ordenes-compra?fecha_desde&fecha_hasta` | 274 | 0 | 11 |
| `GET /ordenes-compra?id_bodega_destino&id_proveedor` | 615 | 0 | 11 |

### C03 — Detalle de una orden con sus líneas y recepciones (GET /ordenes-compra/{id})

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /ordenes-compra/{id}` | 1832 | 0 | 10 |

### C04 — Recepciones de una orden (GET /ordenes-compra/{id}/recepciones)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /ordenes-compra/{id}/recepciones` | 1823 | 0 | 9 |

### C05 — Listado de devoluciones a proveedor (GET /devoluciones-proveedor)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /devoluciones-proveedor` | 1222 | 0 | 9 |
| `GET /devoluciones-proveedor?id_proveedor` | 616 | 0 | 10 |

### C06 — Creación de órdenes (POST /ordenes-compra): número consecutivo bajo concurrencia

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST /ordenes-compra` | 1837 | 0 | 16 |

### C07 — Crear → enviar → recibir con lote: compras llama a inventario (y este a catálogo) y avisa a notificaciones

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `C07 1. POST /ordenes-compra` | 695 | 0 | 22 |
| `C07 2. PATCH /ordenes-compra/{id}/estado` | 694 | 0 | 21 |
| `C07 3. POST /ordenes-compra/{id}/recepciones` | 693 | 0 | 91 |
| `C07 4. GET /ordenes-compra/{id}` | 693 | 0 | 12 |

### C08 — Recepciones simultáneas sobre la MISMA orden (candado por orden en PostgreSQL)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST /ordenes-compra/{id}/recepciones (misma orden)` | 1048 | 0 | 380 |

### C09 — Estrés: de 0 a 200 usuarios, uno por segundo, sobre consultas de órdenes, para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /ordenes-compra` | 583 | 0 | 10 |
| `GET /ordenes-compra/{id}` | 431 | 0 | 10 |
| `GET /ordenes-compra?estado` | 189 | 0 | 11 |

### N01 — Notificaciones del rol del usuario (GET /notificaciones)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /notificaciones` | 1426 | 1 | 14 |
| `GET /notificaciones?pagina` | 414 | 0 | 13 |

### N02 — Notificaciones sin leer y por tipo, y marcar como leída (?leida, ?tipo, POST /leida)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /notificaciones?leida=false` | 1104 | 1 | 15 |
| `GET /notificaciones?tipo` | 716 | 0 | 16 |
| `POST /notificaciones/{id}/leida` | 325 | 0 | 13 |

### N03 — Preferencia de correo de cada usuario (GET/PUT /preferencias/mia) y configuración de alertas

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /configuracion-alertas` | 497 | 0 | 11 |
| `GET /preferencias/mia` | 898 | 0 | 10 |
| `PUT /preferencias/mia` | 428 | 0 | 13 |

### N04 — Avisos de ms-inventario y ms-compras (POST /internas/notificaciones), siempre nuevos

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST /internas/notificaciones` | 1824 | 1 | 13 |

### N05 — Avisos repetidos de STOCK_BAJO para pocos productos: el índice único evita duplicados bajo concurrencia

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST /internas/notificaciones (repetido)` | 1911 | 0 | 11 |

### N06 — Pico: 200 usuarios en 2 s con el uso típico (consultar, leer, avisos entrantes)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET /notificaciones` | 4168 | 7 | 22 |
| `GET /notificaciones?leida=false` | 1730 | 2 | 22 |
| `GET /preferencias/mia` | 854 | 1 | 16 |
| `POST /internas/notificaciones` | 842 | 1 | 22 |
