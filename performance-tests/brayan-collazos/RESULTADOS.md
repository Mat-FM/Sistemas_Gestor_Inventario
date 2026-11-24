# Resultados de las pruebas de rendimiento — Brayan Collazos (API Gateway y ms-inventario)

Generado el 2026-11-23 22:16 con Locust 2.32.5. · **resultados preliminares: duración reducida en M01 2m (definida: 10m), G05 2m (definida: 5m), G06 2m (definida: 3m), I04 2m (definida: 5m), I05 2m (definida: 3m), I06 2m (definida: 3m); el resto con la definida**

Entorno: sin declarar

Estado de la API: los listados del Gateway (usuarios) y de ms-inventario (saldos, kardex, lotes y bodegas) y de ms-catalogo **paginan** (`?pagina&por_pagina`, 20 por defecto, máximo 100); `/categorias` devuelve el árbol completo, sin paginar. Las pruebas G y la mezcla (M01, E01 y S01) van siempre por el Gateway, con una sola cuenta de administrador y los límites de peticiones del Gateway subidos (RNF19) para medir el Gateway y no el limitador.

Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas. Un estado inesperado o un cuerpo que no cumple lo esperado (un listado vacío o sin `meta`, un movimiento sin `id_movimiento`, un reintento que devuelve otro movimiento) cuenta como error.

| Prueba | Tipología | Qué ejercita | Vía | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G01 SaludDelGateway | carga | consulta | gateway | 9810 | 0 (0.00%) | 5 | 7 | 9 | 2103 | 32.7 | CUMPLE |
| G02 UsuariosYRoles | carga | consulta | gateway | 9822 | 9 (0.09%) | 7 | 12 | 15 | 754 | 32.8 | CUMPLE |
| G03 ProxyACatalogo | carga | consulta | gateway | 9763 | 4 (0.04%) | 11 | 16 | 20 | 56 | 32.6 | CUMPLE |
| G04 ProxyAInventario | carga | consulta | gateway | 9785 | 5 (0.05%) | 9 | 13 | 18 | 322 | 32.3 | CUMPLE |
| I01 ListadoSaldos | carga | consulta | directo | 9812 | 0 (0.00%) | 3 | 5 | 6 | 39 | 32.8 | CUMPLE |
| I02 KardexConFiltros | carga | consulta | directo | 9821 | 0 (0.00%) | 3 | 6 | 7 | 27 | 32.8 | CUMPLE |
| I03 LotesFefo | carga | consulta | directo | 9803 | 0 (0.00%) | 3 | 5 | 6 | 13 | 32.7 | CUMPLE |
| M01 CargaMixta | carga | mezcla | gateway | 3797 | 5 (0.13%) | 10 | 17 | 24 | 2393 | 31.8 | dentro del umbral |
| E01 EstresMixto | estres | mezcla | gateway | 26421 | 0 (0.00%) | 9 | 15 | 42 | 150775 | 86.2 | dentro del umbral |
| S01 CapacidadMixta | capacidad | mezcla | gateway | 257512 | 0 (0.00%) | 89 | 540 | 890 | 12806 | 71.6 | dentro del umbral |
| G05 EscrituraPorElGateway | carga | escritura | gateway | 3804 | 0 (0.00%) | 13 | 19 | 24 | 32 | 31.9 | dentro del umbral |
| G06 InicioDeSesion | carga | sesion | gateway | 696 | 0 (0.00%) | 180 | 200 | 210 | 209 | 5.8 | dentro del umbral |
| I04 RegistrarEntradas | carga | escritura | directo | 3807 | 0 (0.00%) | 8 | 13 | 17 | 22 | 31.9 | dentro del umbral |
| I05 IdempotenciaReintentos | carga | idempotencia | directo | 19343 | 0 (0.00%) | 1 | 8 | 12 | 3002 | 162.3 | dentro del umbral |
| I06 SalidasMismoSaldo | carga | contencion | directo | 9834 | 0 (0.00%) | 6 | 9 | 13 | 2440 | 82.5 | dentro del umbral |

## Parámetros de cada escenario

| Prueba | Usuarios | Spawn rate (usuarios/s) | Duración | Host |
|---|---|---|---|---|
| G01 | 50 | 5 | 5m | http://api-gateway:8000 |
| G02 | 50 | 5 | 5m | http://api-gateway:8000 |
| G03 | 50 | 5 | 5m | http://api-gateway:8000 |
| G04 | 50 | 5 | 5m | http://api-gateway:8000 |
| I01 | 50 | 5 | 5m | http://ms-inventario:3000 |
| I02 | 50 | 5 | 5m | http://ms-inventario:3000 |
| I03 | 50 | 5 | 5m | http://ms-inventario:3000 |
| M01 | 50 | 5 | 2m | http://api-gateway:8000 |
| E01 | 300 | 2 | 5m | http://api-gateway:8000 |
| S01 | 120 | 5 | 60m | http://api-gateway:8000 |
| G05 | 50 | 5 | 2m | http://api-gateway:8000 |
| G06 | 10 | 2 | 2m | http://api-gateway:8000 |
| I04 | 50 | 5 | 2m | http://ms-inventario:3000 |
| I05 | 50 | 10 | 2m | http://ms-inventario:3000 |
| I06 | 30 | 10 | 2m | http://ms-inventario:3000 |

## Estrés (E01): punto de quiebre

**No se quebró**: llegó a 300 usuarios y 103.7 peticiones/s sin salir del umbral de forma sostenida.

**Meseta de rendimiento a los 81 s, con 172 usuarios y 97.5 peticiones/s**: desde ahí las peticiones por segundo no crecen aunque lleguen hasta 300 usuarios. Los 128 de más esperan turno sin completar peticiones (no cuentan en el p95 ni en los errores); la petición más lenta tardó 151 s.

## Capacidad (S01): tendencia en el tiempo con 120 usuarios

| Tramo | p95 medio (ms) | Peticiones/s | Errores |
|---|---|---|---|
| Primer 10 % de la meseta | 704 | 70.5 | 0.00% |
| Último 10 % de la meseta | 350 | 74.1 | 0.00% |

Cambio del p95: -50% → **mejora con el tiempo** (se toma como estable un cambio menor del 20 %).

## CPU y memoria de los contenedores

| Contenedor | CPU mediana (%) | CPU máx. (%) | Memoria en el pico |
|---|---|---|---|
| gi-prueba-api-gateway-1 | 155.3 | 751.8 | 313.7MiB / 7.748GiB |
| gi-prueba-ms-catalogo-1 | 36.0 | 93.2 | 57.83MiB / 7.748GiB |
| gi-prueba-db-api-gateway-1 | 35.2 | 108.1 | 599.5MiB / 7.748GiB |
| gi-prueba-ms-inventario-1 | 23.8 | 82.8 | 92.68MiB / 7.748GiB |
| gi-prueba-db-ms-inventario-1 | 12.6 | 102.6 | 75.63MiB / 7.748GiB |
| gi-prueba-db-ms-catalogo-1 | 4.4 | 43.0 | 468MiB / 7.748GiB |
| gi-prueba-db-ms-proveedores-1 | 0.5 | 20.6 | 452.8MiB / 7.748GiB |
| gi-prueba-ms-reportes-1 | 0.0 | 86.5 | 220.3MiB / 7.748GiB |
| gi-prueba-ms-notificaciones-1 | 0.0 | 168.6 | 90.64MiB / 7.748GiB |
| gi-prueba-web-client-1 | 0.0 | 26.2 | 40.93MiB / 7.748GiB |
| gi-prueba-ms-proveedores-1 | 0.0 | 66.2 | 56.65MiB / 7.748GiB |
| gi-prueba-ms-compras-1 | 0.0 | 23.0 | 28.54MiB / 7.748GiB |
| gi-prueba-db-ms-notificaciones-1 | 0.0 | 75.1 | 25.65MiB / 7.748GiB |
| gi-prueba-db-ms-reportes-1 | 0.0 | 91.1 | 28.42MiB / 7.748GiB |
| gi-prueba-db-ms-compras-1 | 0.0 | 103.8 | 47.55MiB / 7.748GiB |

## Detalle por operación

### G01 — GET /health: lo mínimo que cuesta una petición al Gateway (sin sesión ni base de datos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /health` | 9810 | 0 | 7 |

### G02 — Usuarios y roles, que resuelve el propio Gateway con su base MySQL (JWT, usuario releído en cada petición)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/roles` | 2431 | 1 | 11 |
| `GET GET /api/usuarios` | 7391 | 8 | 12 |

### G03 — Consultas de productos y categorías reenviadas a ms-catalogo

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/categorias` | 1862 | 0 | 15 |
| `GET GET /api/productos` | 5928 | 3 | 16 |
| `GET GET /api/productos?nombre` | 1973 | 1 | 16 |

### G04 — Saldos, kardex y bodegas reenviados a ms-inventario

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/bodegas` | 1906 | 1 | 13 |
| `GET GET /api/movimientos` | 3907 | 2 | 14 |
| `GET GET /api/saldos` | 3972 | 2 | 13 |

### I01 — Listado paginado de saldos por producto y bodega (GET /saldos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /saldos` | 9812 | 0 | 5 |

### I02 — Kardex paginado y filtrado por tipo, bodega, producto y fechas (GET /movimientos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /movimientos` | 4235 | 0 | 6 |
| `GET GET /movimientos?fechas&id_producto` | 2802 | 0 | 7 |
| `GET GET /movimientos?tipo&id_bodega` | 2784 | 0 | 6 |

### I03 — Lotes con existencia en orden FEFO, por vencer y por producto (GET /lotes)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /lotes?id_producto&id_bodega` | 3289 | 0 | 5 |
| `GET GET /lotes?vence_antes_de` | 6514 | 0 | 5 |

### M01 — Carga: ~85 % GET y ~15 % POST por el Gateway hacia ms-inventario y ms-catalogo, 50 usuarios en meseta

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/bodegas` | 189 | 0 | 12 |
| `GET GET /api/lotes?vence_antes_de` | 364 | 0 | 13 |
| `GET GET /api/movimientos` | 736 | 0 | 13 |
| `GET GET /api/productos` | 590 | 1 | 17 |
| `GET GET /api/productos?nombre` | 200 | 0 | 19 |
| `GET GET /api/saldos` | 968 | 2 | 13 |
| `GET GET /api/usuarios` | 179 | 0 | 13 |
| `POST POST /api/movimientos (ENTRADA)` | 381 | 0 | 20 |
| `POST POST /api/movimientos (SALIDA)` | 190 | 2 | 21 |

### E01 — Estrés: la misma mezcla con una rampa hasta 300 usuarios (2 por segundo), para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/bodegas` | 1283 | 0 | 12 |
| `GET GET /api/lotes?vence_antes_de` | 2581 | 0 | 12 |
| `GET GET /api/movimientos` | 5192 | 0 | 12 |
| `GET GET /api/productos` | 3994 | 0 | 15 |
| `GET GET /api/productos?nombre` | 1303 | 0 | 15 |
| `GET GET /api/saldos` | 6781 | 0 | 11 |
| `GET GET /api/usuarios` | 1293 | 0 | 11 |
| `POST POST /api/movimientos (ENTRADA)` | 2652 | 0 | 19 |
| `POST POST /api/movimientos (SALIDA)` | 1342 | 0 | 19 |

### S01 — Capacidad (soak): la misma mezcla con 120 usuarios durante 60 min, para ver la tendencia en el tiempo

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /api/bodegas` | 12980 | 0 | 540 |
| `GET GET /api/lotes?vence_antes_de` | 25848 | 0 | 530 |
| `GET GET /api/movimientos` | 51387 | 0 | 530 |
| `GET GET /api/productos` | 38705 | 0 | 550 |
| `GET GET /api/productos?nombre` | 12822 | 0 | 540 |
| `GET GET /api/saldos` | 64085 | 0 | 520 |
| `GET GET /api/usuarios` | 12937 | 0 | 520 |
| `POST POST /api/movimientos (ENTRADA)` | 25854 | 0 | 570 |
| `POST POST /api/movimientos (SALIDA)` | 12894 | 0 | 590 |

### G05 — POST /movimientos por el Gateway, con su Idempotency-Key, hacia ms-inventario (que valida con ms-catalogo)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /api/movimientos` | 3804 | 0 | 19 |

### G06 — POST /auth/login: lo que cuesta emitir un token (contraseña con bcrypt y firma del JWT)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /api/auth/login` | 696 | 0 | 200 |

### I04 — Entradas de mercancía a la vez (POST /movimientos): una transacción por movimiento, con clave de idempotencia

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (ENTRADA)` | 3807 | 0 | 13 |

### I05 — El mismo movimiento reintentado con la misma clave devuelve el original sin duplicarse (RNF17)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (primer intento)` | 7723 | 0 | 9 |
| `POST POST /movimientos (reintento)` | 11620 | 0 | 1 |

### I06 — Salidas simultáneas sobre la MISMA fila de saldo (SELECT … FOR UPDATE): deben serializarse sin errores

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /movimientos (SALIDA mismo saldo)` | 9834 | 0 | 9 |
