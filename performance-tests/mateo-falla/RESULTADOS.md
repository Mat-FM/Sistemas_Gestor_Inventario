# Resultados de las pruebas de rendimiento — Mateo Falla (ms-catalogo, ms-proveedores y ms-reportes)

Generado el 2026-11-21 17:47. La columna «Vía» dice cómo llegó cada prueba: `gateway` (por el API Gateway, con sesión) o `directo` (a cada servicio) · **resultados preliminares: los usuarios de cada escenario, 1m por prueba**

Entorno: MacBook Pro Apple M5 Pro (24 GB), sistema completo con Docker Compose (imágenes del repositorio, un contenedor por servicio y por base de datos), con el equipo en uso (otra aplicación consumía un núcleo). Todas las pruebas van por el API Gateway con una sola cuenta de administrador y con sus límites de peticiones subidos (RATE_LIMIT_PER_MINUTE=100000 y LOGIN_RATE_LIMIT_PER_MINUTE=1000), para medir los servicios y no el limitador (RNF19). Pila nueva (catálogo con unas decenas de productos) y las 15 seguidas en el orden de escenarios.py. Es una medición local de desarrollo, con el generador de carga en el mismo equipo; no es el despliegue en Kubernetes.

Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia (escritura, integración, contención,
estrés y pico) se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas.

| Prueba | Vía | Tipo | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |
|---|---|---|---|---|---|---|---|---|---|---|
| R01 ExistenciasYValorizacion | gateway | carga | 1282 | 0 (0.00%) | 120 | 590 | 6100 | 6371 | 21.7 | CUMPLE |
| R02 RotacionEIndicadores | gateway | carga | 1120 | 0 (0.00%) | 370 | 2300 | 2900 | 3409 | 18.6 | NO CUMPLE |
| R03 KardexFiltrado | gateway | carga | 1387 | 0 (0.00%) | 160 | 640 | 1200 | 1663 | 23.5 | CUMPLE |
| R04 DescargasCsvYPdf | gateway | exportacion | 675 | 1 (0.15%) | 470 | 1800 | 2500 | 3070 | 11.2 | dentro del umbral |
| R05 EstresReportes | gateway | estres | 693 | 15 (2.16%) | 850 | 2700 | 3400 | 3697 | 11.3 | fuera del umbral |
| K01 ListadoProductos | gateway | carga | 1726 | 0 (0.00%) | 60 | 190 | 280 | 384 | 29.3 | CUMPLE |
| K02 BusquedaDeProductos | gateway | carga | 1717 | 0 (0.00%) | 56 | 250 | 400 | 624 | 29.1 | CUMPLE |
| K03 ConsultaPuntual | gateway | carga | 1738 | 0 (0.00%) | 51 | 160 | 330 | 465 | 29.4 | CUMPLE |
| K04 AltaDeProductos | gateway | escritura | 1699 | 0 (0.00%) | 56 | 240 | 350 | 541 | 28.7 | dentro del umbral |
| K05 EstresCatalogo | gateway | estres | 1157 | 22 (1.90%) | 16 | 120 | 1300 | 1544 | 19.6 | fuera del umbral |
| K06 PicoCatalogo | gateway | pico | 4630 | 0 (0.00%) | 170 | 690 | 6700 | 62007 | 71.1 | dentro del umbral |
| P01 ListadoProveedores | gateway | carga | 1629 | 0 (0.00%) | 37 | 69 | 410 | 524 | 27.6 | CUMPLE |
| P02 ProveedorConSusProductos | gateway | carga | 1616 | 0 (0.00%) | 35 | 60 | 390 | 492 | 27.3 | CUMPLE |
| P03 AltaDeProveedores | gateway | escritura | 1602 | 0 (0.00%) | 40 | 89 | 720 | 831 | 27.1 | dentro del umbral |
| P04 PicoProveedores | gateway | pico | 3744 | 18 (0.48%) | 340 | 730 | 8200 | 50030 | 62.4 | dentro del umbral |

## Detalle por operación

### R01 — Existencias por producto y bodega, y valorización (GET /reportes/existencias y /reportes/valorizacion)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /reportes/existencias` | 625 | 0 | 600 |
| `GET GET /reportes/valorizacion` | 657 | 0 | 580 |

### R02 — Rotación de 30 días y panel de indicadores (GET /reportes/rotacion y /indicadores)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /indicadores` | 563 | 0 | 2400 |
| `GET GET /reportes/rotacion` | 557 | 0 | 2000 |

### R03 — Kardex de un producto, con y sin periodo (GET /reportes/kardex)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /reportes/kardex?id_producto` | 1019 | 0 | 650 |
| `GET GET /reportes/kardex?id_producto&fechas` | 368 | 0 | 600 |

### R04 — Los reportes como archivo: CSV de existencias y de kardex, y PDF de valorización

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /reportes/existencias?formato=csv` | 324 | 0 | 1200 |
| `GET GET /reportes/kardex?formato=csv` | 245 | 0 | 1000 |
| `GET GET /reportes/valorizacion?formato=pdf` | 106 | 1 | 2600 |

### R05 — Estrés: de 0 a 200 usuarios, uno por segundo, sobre todos los reportes en JSON, para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /indicadores` | 146 | 14 | 3300 |
| `GET GET /reportes/existencias` | 255 | 0 | 2600 |
| `GET GET /reportes/kardex?id_producto` | 144 | 1 | 2400 |
| `GET GET /reportes/valorizacion` | 148 | 0 | 2500 |

### K01 — Listado paginado de productos (GET /productos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /productos` | 1726 | 0 | 190 |

### K02 — Búsqueda de productos por nombre, por código y por categoría (GET /productos con filtros)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /productos?codigo` | 489 | 0 | 230 |
| `GET GET /productos?id_categoria&estado` | 501 | 0 | 230 |
| `GET GET /productos?nombre` | 727 | 0 | 270 |

### K03 — Un producto, el árbol de categorías y una categoría (GET /productos/{id}, /categorias, /categorias/{id})

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /categorias/{id}` | 242 | 0 | 230 |
| `GET GET /categorias?arbol` | 522 | 0 | 210 |
| `GET GET /productos/{id}` | 974 | 0 | 140 |

### K04 — Altas de productos a la vez (POST /productos), con código único

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /productos` | 1699 | 0 | 240 |

### K05 — Estrés: de 0 a 200 usuarios, uno por segundo, sobre el listado, la búsqueda y la consulta de productos

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /productos` | 585 | 11 | 120 |
| `GET GET /productos/{id}` | 351 | 8 | 330 |
| `GET GET /productos?nombre` | 221 | 3 | 77 |

### K06 — Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna alta)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /productos` | 2094 | 0 | 670 |
| `GET GET /productos/{id}` | 1264 | 0 | 680 |
| `GET GET /productos?nombre` | 857 | 0 | 730 |
| `POST POST /productos` | 415 | 0 | 670 |

### P01 — Listado de proveedores, por razón social y por producto (GET /proveedores)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /proveedores` | 801 | 0 | 67 |
| `GET GET /proveedores?id_producto` | 267 | 0 | 71 |
| `GET GET /proveedores?razon_social&estado` | 561 | 0 | 77 |

### P02 — Un proveedor y sus productos asociados (GET /proveedores/{id} y /proveedores/{id}/productos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /proveedores/{id}` | 808 | 0 | 60 |
| `GET GET /proveedores/{id}/productos` | 808 | 0 | 56 |

### P03 — Altas de proveedores a la vez (POST /proveedores), con NIT único

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /proveedores` | 1602 | 0 | 89 |

### P04 — Pico: 200 usuarios en 2 s con el uso típico (consultas y alguna alta)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /proveedores` | 2058 | 12 | 720 |
| `GET GET /proveedores/{id}/productos` | 1260 | 2 | 740 |
| `POST POST /proveedores` | 426 | 4 | 740 |
