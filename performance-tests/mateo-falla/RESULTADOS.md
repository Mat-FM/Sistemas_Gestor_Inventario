# Resultados de las pruebas de rendimiento — Mateo Falla (ms-catalogo, ms-proveedores y ms-reportes)

Generado el 2026-11-22 02:51 con Locust 2.31.8. · **resultados preliminares: los usuarios de cada escenario, 2m por prueba**

Entorno: sin declarar

Estado de la API: los listados de ms-catalogo y ms-proveedores **paginan** (`?pagina&por_pagina`, 20 por defecto, máximo 100). ms-reportes no pagina sus reportes: los calcula recorriendo **todo** el catálogo y los saldos (de 100 en 100) en cada petición, y limita el kardex a `KARDEX_MAX_FILAS`.

Criterio RNF06: p95 < 2000 ms y errores < 1 %. Las pruebas de referencia se comparan con el mismo umbral, pero RNF06 solo obliga a las consultas. Un estado inesperado o un cuerpo que no cumple lo esperado (por ejemplo, una importación que no queda PROCESADA) cuenta como error.

| Prueba | Tipología | Qué ejercita | Vía | Peticiones | Errores | Mediana (ms) | p95 (ms) | p99 (ms) | Máx. (ms) | Peticiones/s | Resultado |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R01 ExistenciasYValorizacion | carga | consulta | gateway | 3618 | 0 (0.00%) | 27 | 35 | 2000 | 4803 | 30.4 | CUMPLE |
| R02 RotacionEIndicadores | carga | consulta | gateway | 3684 | 1 (0.03%) | 36 | 49 | 60 | 195 | 30.9 | CUMPLE |
| R03 KardexFiltrado | carga | consulta | gateway | 3721 | 0 (0.00%) | 29 | 35 | 43 | 107 | 31.2 | CUMPLE |
| R04 DescargasCsvYPdf | carga | exportacion | gateway | 2178 | 0 (0.00%) | 43 | 180 | 340 | 785 | 18.3 | dentro del umbral |
| R05 ImportacionStockInicial | carga | importacion | gateway | 736 | 0 (0.00%) | 61 | 74 | 140 | 150 | 6.2 | dentro del umbral |
| K01 ListadoYProducto | carga | consulta | gateway | 3750 | 0 (0.00%) | 20 | 26 | 36 | 2806 | 31.5 | CUMPLE |
| K02 BusquedaYCategorias | carga | consulta | gateway | 3771 | 0 (0.00%) | 20 | 26 | 30 | 49 | 31.7 | CUMPLE |
| K03 FiltroPorProveedor | carga | consulta | gateway | 3750 | 0 (0.00%) | 28 | 37 | 45 | 96 | 31.5 | CUMPLE |
| P01 ListadoProveedores | carga | consulta | gateway | 3732 | 0 (0.00%) | 20 | 25 | 32 | 83 | 31.3 | CUMPLE |
| P02 ProveedorConSusProductos | carga | consulta | gateway | 3758 | 0 (0.00%) | 19 | 25 | 30 | 82 | 31.6 | CUMPLE |
| M01 CargaMixta | carga | mezcla | gateway | 3624 | 0 (0.00%) | 21 | 93 | 110 | 660 | 30.4 | dentro del umbral |
| E01 EstresMixto | estres | mezcla | gateway | 8164 | 0 (0.00%) | 22 | 130 | 10000 | 49926 | 64.7 | dentro del umbral |
| S01 CapacidadMixta | capacidad | mezcla | gateway | 4347 | 0 (0.00%) | 21 | 130 | 150 | 259 | 36.5 | dentro del umbral |
| P03 AltaYAsociacion | carga | escritura | gateway | 14326 | 0 (0.00%) | 21 | 26 | 33 | 121 | 120.3 | dentro del umbral |
| K04 LoteInterno | carga | lote | directo (ruta interna) | 650 | 0 (0.00%) | 300 | 360 | 400 | 458 | 5.5 | dentro del umbral |

## Parámetros de cada escenario

| Prueba | Usuarios | Spawn rate (usuarios/s) | Duración | Host |
|---|---|---|---|---|
| R01 | 50 | 5 | 2m | http://api-gateway:8000 |
| R02 | 50 | 5 | 2m | http://api-gateway:8000 |
| R03 | 50 | 5 | 2m | http://api-gateway:8000 |
| R04 | 30 | 5 | 2m | http://api-gateway:8000 |
| R05 | 10 | 2 | 2m | http://api-gateway:8000 |
| K01 | 50 | 5 | 2m | http://api-gateway:8000 |
| K02 | 50 | 5 | 2m | http://api-gateway:8000 |
| K03 | 50 | 5 | 2m | http://api-gateway:8000 |
| P01 | 50 | 5 | 2m | http://api-gateway:8000 |
| P02 | 50 | 5 | 2m | http://api-gateway:8000 |
| M01 | 50 | 5 | 2m | http://api-gateway:8000 |
| E01 | 300 | 2 | 2m | http://api-gateway:8000 |
| S01 | 60 | 5 | 2m | http://api-gateway:8000 |
| P03 | 50 | 5 | 2m | http://api-gateway:8000 |
| K04 | 10 | 2 | 2m | http://ms-catalogo:8000 |

## Estrés (E01): punto de quiebre

**No se quebró**: llegó a 238 usuarios y 98.6 peticiones/s sin salir del umbral de forma sostenida.

## Capacidad (S01): tendencia en el tiempo con 60 usuarios

| Tramo | p95 medio (ms) | Peticiones/s | Errores |
|---|---|---|---|
| Primer 10 % de la meseta | 132 | 24.0 | 0.00% |
| Último 10 % de la meseta | 126 | 38.9 | 0.00% |

Cambio del p95: -5% → **estable** (se toma como estable un cambio menor del 20 %).

## CPU y memoria de los contenedores

| Contenedor | CPU máx. (%) | Memoria en ese momento |
|---|---|---|
| gi-prueba-ms-catalogo-1 | 153.2 | 66.9MiB / 14.41GiB |
| gi-prueba-api-gateway-1 | 131.4 | 195.4MiB / 14.41GiB |
| gi-prueba-ms-reportes-1 | 115.3 | 231.8MiB / 14.41GiB |
| gi-prueba-ms-proveedores-1 | 96.2 | 55.3MiB / 14.41GiB |
| gi-prueba-db-ms-catalogo-1 | 55.8 | 443.5MiB / 14.41GiB |
| gi-prueba-ms-inventario-1 | 32.0 | 80.26MiB / 14.41GiB |
| gi-prueba-db-api-gateway-1 | 32.0 | 489.1MiB / 14.41GiB |
| gi-prueba-db-ms-inventario-1 | 26.4 | 41.62MiB / 14.41GiB |
| gi-prueba-ms-notificaciones-1 | 23.7 | 54.15MiB / 14.41GiB |
| gi-prueba-db-ms-proveedores-1 | 23.5 | 446.2MiB / 14.41GiB |
| gi-prueba-db-ms-notificaciones-1 | 5.8 | 23.83MiB / 14.41GiB |
| gi-prueba-ms-compras-1 | 5.7 | 22.79MiB / 14.41GiB |
| gi-prueba-db-ms-compras-1 | 5.4 | 25.16MiB / 14.41GiB |
| gi-prueba-db-ms-reportes-1 | 5.3 | 35.55MiB / 14.41GiB |
| gi-prueba-web-client-1 | 5.0 | 54.64MiB / 14.41GiB |

## Detalle por operación

### R01 — Existencias por producto y bodega, y valorización (GET /reportes/existencias y /reportes/valorizacion)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /reportes/existencias` | 1858 | 0 | 35 |
| `GET GET /reportes/valorizacion` | 1760 | 0 | 33 |

### R02 — Rotación de 30 días y panel de indicadores (GET /reportes/rotacion y /indicadores)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /indicadores` | 1822 | 1 | 51 |
| `GET GET /reportes/rotacion` | 1862 | 0 | 36 |

### R03 — Kardex de un producto, con y sin periodo (GET /reportes/kardex)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /reportes/kardex?id_producto` | 2767 | 0 | 35 |
| `GET GET /reportes/kardex?id_producto&fechas` | 954 | 0 | 35 |

### R04 — Los reportes como archivo: CSV de existencias y de kardex, y PDF de valorización

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /reportes/existencias?formato=csv` | 1107 | 0 | 160 |
| `GET GET /reportes/kardex?formato=csv` | 693 | 0 | 140 |
| `GET GET /reportes/valorizacion?formato=pdf` | 378 | 0 | 300 |

### R05 — Importación masiva de STOCK_INICIAL de 10 filas (POST /importaciones): lee, convierte con catálogo e inventario y envía

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /importaciones (STOCK_INICIAL)` | 736 | 0 | 74 |

### K01 — Listado paginado de productos y un producto (GET /productos y /productos/{id})

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /productos` | 2289 | 0 | 26 |
| `GET GET /productos/{id}` | 1461 | 0 | 25 |

### K02 — Búsqueda por nombre, código y categoría (con subcategorías), árbol de categorías y una categoría

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /categorias/{id}` | 450 | 0 | 25 |
| `GET GET /categorias?arbol` | 392 | 0 | 26 |
| `GET GET /productos?codigo` | 821 | 0 | 25 |
| `GET GET /productos?id_categoria&estado` | 847 | 0 | 26 |
| `GET GET /productos?nombre` | 1261 | 0 | 26 |

### K03 — Filtro por proveedor (GET /productos?id_proveedor): ms-catalogo consulta a ms-proveedores en cada petición (RNF18)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /productos?id_proveedor` | 3750 | 0 | 37 |

### P01 — Listado, por razón social y por producto (GET /proveedores)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /proveedores` | 1860 | 0 | 25 |
| `GET GET /proveedores?id_producto` | 613 | 0 | 26 |
| `GET GET /proveedores?razon_social&estado` | 1259 | 0 | 25 |

### P02 — Un proveedor y sus productos asociados (GET /proveedores/{id} y /proveedores/{id}/productos)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /proveedores/{id}` | 1891 | 0 | 25 |
| `GET GET /proveedores/{id}/productos` | 1867 | 0 | 25 |

### M01 — Carga: ~85 % GET y ~15 % POST sobre los tres servicios, 50 usuarios en meseta

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /indicadores` | 164 | 0 | 110 |
| `GET GET /productos` | 710 | 0 | 26 |
| `GET GET /productos/{id}` | 547 | 0 | 25 |
| `GET GET /productos?id_proveedor` | 309 | 0 | 34 |
| `GET GET /productos?nombre` | 352 | 0 | 24 |
| `GET GET /proveedores` | 340 | 0 | 26 |
| `GET GET /proveedores/{id}/productos` | 334 | 0 | 25 |
| `GET GET /reportes/existencias` | 190 | 0 | 84 |
| `GET GET /reportes/kardex?id_producto` | 166 | 0 | 76 |
| `POST POST /importaciones (STOCK_INICIAL)` | 156 | 0 | 98 |
| `POST POST /proveedores` | 356 | 0 | 27 |

### E01 — Estrés: la misma mezcla con una rampa hasta 300 usuarios (2 por segundo), para hallar el punto de quiebre

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /indicadores` | 388 | 0 | 180 |
| `GET GET /productos` | 1539 | 0 | 27 |
| `GET GET /productos/{id}` | 1166 | 0 | 25 |
| `GET GET /productos?id_proveedor` | 785 | 0 | 38 |
| `GET GET /productos?nombre` | 748 | 0 | 27 |
| `GET GET /proveedores` | 777 | 0 | 27 |
| `GET GET /proveedores/{id}/productos` | 774 | 0 | 27 |
| `GET GET /reportes/existencias` | 420 | 0 | 130 |
| `GET GET /reportes/kardex?id_producto` | 377 | 0 | 110 |
| `POST POST /importaciones (STOCK_INICIAL)` | 401 | 0 | 150 |
| `POST POST /proveedores` | 789 | 0 | 29 |

### S01 — Capacidad (soak): la misma mezcla con 60 usuarios durante 60 min, para ver la tendencia en el tiempo

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `GET GET /indicadores` | 208 | 0 | 160 |
| `GET GET /productos` | 833 | 0 | 25 |
| `GET GET /productos/{id}` | 615 | 0 | 24 |
| `GET GET /productos?id_proveedor` | 374 | 0 | 34 |
| `GET GET /productos?nombre` | 425 | 0 | 25 |
| `GET GET /proveedores` | 387 | 0 | 25 |
| `GET GET /proveedores/{id}/productos` | 431 | 0 | 25 |
| `GET GET /reportes/existencias` | 210 | 0 | 110 |
| `GET GET /reportes/kardex?id_producto` | 205 | 0 | 100 |
| `POST POST /importaciones (STOCK_INICIAL)` | 204 | 0 | 130 |
| `POST POST /proveedores` | 455 | 0 | 27 |

### P03 — Alta de proveedores (NIT único) y asociación de 3 productos a cada uno

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /proveedores` | 3583 | 0 | 27 |
| `POST POST /proveedores/{id}/productos` | 10743 | 0 | 26 |

### K04 — Carga masiva interna de productos, 100 filas por petición (POST /internas/productos/lote, siempre directo)

| Operación | Peticiones | Errores | p95 (ms) |
|---|---|---|---|
| `POST POST /internas/productos/lote (100 filas)` | 650 | 0 | 360 |
