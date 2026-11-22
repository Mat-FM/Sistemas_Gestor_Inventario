# Pruebas de rendimiento — Mateo Falla

15 pruebas con [Locust](https://locust.io) 2.31.8 sobre los tres servicios a cargo de Mateo: **ms-reportes** (R01 a R05), **ms-catalogo**
(K01 a K04) y **ms-proveedores** (P01 a P03), más tres sobre la mezcla de los tres con las tipologías de la guía del taller de Locust
(docente Albeiro Montes): **carga** (M01), **estrés** (E01) y **capacidad** (S01). Usan la misma estructura que las de Brayan
(`../brayan-collazos`) y las de Luis (`../luis-saraza`): `escenarios.py` define las pruebas; `reportes.py`, `catalogo.py`, `proveedores.py` y
`mixto.py` tienen su código; `ejecutar.py` las corre y `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md).

> Parten del borrador que preparó Brayan (PR #20) para completar RNF11. Mateo las ajustó a la guía del taller y a lo que conoce de sus
> servicios: agregó la importación masiva, el filtro por proveedor, la carga masiva interna y las asociaciones, y cambió los estrés y picos
> por servicio por las tres tipologías de la guía sobre una misma mezcla.

## Criterio (RNF06, Entrega 1)

> Las consultas responden en menos de 2 s en el 95 % de los casos (percentil 95) y con menos de 1 % de errores, con
> 50 usuarios simulados al mismo tiempo durante 5 minutos.

Las nueve pruebas de **consulta** por operación verifican RNF06 con exactamente esa carga. Las demás se comparan con el mismo umbral, pero
son **de referencia**. Cada usuario simulado espera entre 1 y 2 s entre operaciones, como una persona usando la interfaz: por eso el número de
usuarios **no** es el de peticiones por segundo (el informe da los dos).

**Qué cuenta como error** (la guía advierte no contar como éxito lo que no lo es): un estado inesperado (por ejemplo, un 409 o un 422 por un
NIT o un código repetido) y un cuerpo que no cumple lo esperado. Por ejemplo, una importación que responde 201 pero no queda `PROCESADA`,
un filtro por proveedor que no devuelve sus 20 productos o un lote que no crea sus 100 productos.

## Las 15 pruebas

| ID | Tipología (guía) | Servicio | Usuarios | Spawn rate | Duración | Qué mide |
|---|---|---|---|---|---|---|
| R01 | carga (RNF06) | ms-reportes | 50 | 5/s | 5 min | Existencias y valorización (`GET /reportes/existencias` y `/reportes/valorizacion`) |
| R02 | carga (RNF06) | ms-reportes | 50 | 5/s | 5 min | Rotación de 30 días e indicadores (`GET /reportes/rotacion` y `/indicadores`) |
| R03 | carga (RNF06) | ms-reportes | 50 | 5/s | 5 min | Kardex de un producto, con y sin periodo (`GET /reportes/kardex`) |
| R04 | carga | ms-reportes | 30 | 5/s | 3 min | Reportes como archivo: CSV de existencias y de kardex, PDF de valorización |
| R05 | carga | ms-reportes | 10 | 2/s | 3 min | **Importación STOCK_INICIAL** de 10 filas (`POST /importaciones`, RF16) |
| K01 | carga (RNF06) | ms-catalogo | 50 | 5/s | 5 min | Listado paginado y un producto (`GET /productos`, `/productos/{id}`) |
| K02 | carga (RNF06) | ms-catalogo | 50 | 5/s | 5 min | Búsqueda por nombre, código y categoría (con subcategorías) y categorías |
| K03 | carga (RNF06) | ms-catalogo → ms-proveedores | 50 | 5/s | 5 min | **Filtro por proveedor** (`GET /productos?id_proveedor`): llamada 8 con RNF18 |
| P01 | carga (RNF06) | ms-proveedores | 50 | 5/s | 5 min | Listado, por razón social y por producto (`GET /proveedores`) |
| P02 | carga (RNF06) | ms-proveedores | 50 | 5/s | 5 min | Un proveedor y sus productos (`GET /proveedores/{id}` y `/productos`) |
| M01 | **carga** | los tres | 50 | 5/s | 10 min | Mezcla: ~85 % GET y ~15 % POST, en meseta (comportamiento nominal) |
| E01 | **estrés** | los tres | 0 → 300 | 2/s | 5 min | La misma mezcla con una rampa agresiva: **punto de quiebre** (usuarios y RPS) |
| S01 | **capacidad** | los tres | 60 (ajustable) | 5/s | 60 min | La misma mezcla, sostenida cerca del máximo estable: **tendencia en el tiempo** |
| P03 | carga | ms-proveedores | 50 | 5/s | 5 min | **Alta de proveedores y asociación** de 3 productos a cada uno |
| K04 | carga | ms-catalogo | 10 | 2/s | 3 min | **Carga masiva interna** de 100 productos por petición (`/internas/productos/lote`) |

La definición exacta (clase, usuarios, spawn rate y duración) está en [escenarios.py](escenarios.py).

### La mezcla (M01, E01 y S01)

La guía pide que carga, estrés y capacidad usen **la misma mezcla** con GET predominante y POST minoritario, y que solo cambie la forma de la
carga. [mixto.py](mixto.py) la define, con el peso de cada operación:

| Operación | Peso |
|---|---|
| `GET /productos` (listado) | 4 |
| `GET /productos/{id}` | 3 |
| `GET /productos?nombre` y `GET /productos?id_proveedor` | 2 + 2 |
| `GET /proveedores` y `GET /proveedores/{id}/productos` | 2 + 2 |
| `GET /reportes/existencias`, `GET /reportes/kardex` y `GET /indicadores` | 1 + 1 + 1 |
| **POST** `/proveedores` (alta) | 2 |
| **POST** `/importaciones` (STOCK_INICIAL de 10 filas) | 1 |

Son 18 de 21 en GET (~86 %) y 3 en POST (~14 %). Las escrituras de la mezcla **no dan de alta productos**: así el catálogo no crece durante la
prueba (los reportes lo recorren entero) y, en S01, una degradación con el tiempo sería del sistema y no de tener más datos.

- **E01 (estrés)**: `resumen.py` busca en el historial segundo a segundo el primer momento en que el p95 pasa de 2 s o los errores de 1 % y
  siguen así 5 s seguidos, y anota **con cuántos usuarios y a cuántas peticiones por segundo** ocurrió.
- **S01 (capacidad)**: la guía pide una carga **cercana al máximo estable, no al quiebre**. Corra E01 primero y ajuste
  `PERF_CAPACIDAD_USUARIOS` a ~70 % de los usuarios del quiebre (por defecto 60). `resumen.py` compara el p95, las peticiones por segundo y
  los errores del primer y el último 10 % de la meseta.

## Orden y datos

- **El orden importa.** ms-reportes recorre todos los productos de ms-catalogo en cada petición, y K04 da de alta miles (en la comprobación
  rápida, ~14 000 en 30 s): por eso las pruebas de reportes van primero, la mezcla (que incluye reportes) después, y las escrituras P03 y K04
  al final. Una primera comprobación con la mezcla después de K04 dio p95 de 2,5 s y 503 en los reportes: medía el tamaño del catálogo, no el
  sistema. `ejecutar.py` las corre en el orden de `escenarios.py` (el de la tabla); si las corre por separado, respete ese orden y prefiera una
  pila nueva.
- **Cada prueba prepara sus datos** al empezar, y eso no cuenta en la medición:
  - catálogo: una categoría con una subcategoría, 60 productos y 3 proveedores con 20 de esos productos cada uno;
  - proveedores: 40 proveedores con 5 productos asociados;
  - reportes: 30 productos con stock en las dos bodegas, un lote y 4 movimientos.
- **Las pruebas escriben en las bases de datos** (productos, proveedores, movimientos e importaciones). Córralas en un entorno de pruebas,
  no sobre los datos de la demo.

## Lo que mostraron (preliminar, 2 min por prueba)

Detalle en [RESULTADOS.md](RESULTADOS.md): pila nueva, los usuarios reales de cada escenario y 2 minutos por prueba.

- **Las nueve consultas cumplen RNF06** con 50 usuarios: p95 entre 25 y 49 ms y 0 % de errores (un solo error en R02 entre 3 684 peticiones).
  R02 (rotación e indicadores), que en el borrador no cumplía (p95 de 2,3 s), ahora da 49 ms: el borrador midió sobre un catálogo ya
  agrandado por las altas y antes de que ms-reportes atendiera con hilos.
- **La mezcla** se mantiene en p95 de 93 a 130 ms en carga (M01), estrés (E01) y capacidad (S01), sin errores.
- **Estrés (E01): no se quebró** en 2 min, que alcanzan para llegar a 238 usuarios y 98,6 peticiones/s. Pero la cola se alarga: el
  percentil 99 llega a 10 s y el máximo a 50 s, porque con tantos usuarios algunas peticiones esperan turno. La corrida completa (5 min, hasta
  300 usuarios) debe confirmar dónde se quiebra.
- **Capacidad (S01)**: estable en 2 min con 60 usuarios (p95 de 132 a 126 ms). La tendencia real exige los 60 minutos.
- **CPU**: el que más usa es ms-catalogo (hasta 153 %), seguido del Gateway (131 %) y ms-reportes (115 %); la memoria no pasa de 500 MB
  por contenedor.
- **Hallazgo: ms-reportes no escala con el tamaño del catálogo.** Una primera corrida se hizo por error sobre una pila con ~15 000
  productos (los de la K04 de una comprobación anterior). Ahí R01 a R05 dieron entre 68 % y 100 % de errores: cada reporte recorría ~150
  páginas de ms-catalogo, las llamadas pasaban de 3 s, el cortacircuitos de ms-reportes se abría (89 veces) y respondía 503. ms-catalogo, en
  cambio, seguía respondiendo cada página en 23 ms (p95). Es el candidato para la comparación antes/después de una optimización (Entrega 4):
  por ejemplo, guardar unos segundos la lista de productos en ms-reportes o pedir las páginas en paralelo.

## Ejecutar

Las pruebas se corren **dentro de la red de contenedores**, porque ms-catalogo, ms-proveedores y ms-reportes no publican puertos (RNF09) y
la carga masiva interna (K04) no pasa por el Gateway. Se usa la imagen oficial de Locust, sin instalar nada.

**1. Levantar la pila de pruebas** (desde la raíz del repositorio), con los límites del Gateway subidos para medir los servicios y no el
limitador (RNF19). El informe lo dice en «Entorno»:

```bash
GATEWAY_RATE_LIMIT_PER_MINUTE=100000 GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE=1000 ./smoke-tests/ejecutar.sh --conservar --sin-limites
```

Al final imprime el Gateway (`http://127.0.0.1:18100`), el administrador (`admin@prueba.test` / `ClaveNueva2026A`) y cómo apagarla.

**2. Registrar CPU y memoria** (opcional, en otra terminal, desde esta carpeta): `./recursos.sh`, y Ctrl+C al terminar.

**3. Correr las pruebas** (desde esta carpeta):

```bash
docker run --rm --network gi-prueba_default -v "$PWD":/mnt/locust -w /mnt/locust \
  -e PERF_MODO=gateway -e PERF_GATEWAY_URL=http://api-gateway:8000 -e PERF_USUARIOS="admin@prueba.test:ClaveNueva2026A" \
  -e PERF_ENTORNO="describa aquí el equipo (CPU, RAM) y cómo se levantó la pila" \
  --entrypoint python locustio/locust:2.31.8 ejecutar.py
```

- Comprobación rápida (10 usuarios, 30 s por prueba; no vale como resultado): agregar `--rapido` al final.
- Preliminar: `ejecutar.py --duracion=2m` (los mismos usuarios, cada prueba dura 2 min).
- Solo algunas: `ejecutar.py R01 K03`. Medir cada servicio aislado: `-e PERF_MODO=directo` (sin `PERF_USUARIOS`).
- Otros datos: `PERF_ID_BODEGA`, `PERF_ID_BODEGA_2`, `PERF_CAPACIDAD_USUARIOS`.

Las 15 con su duración completa tardan unas **2 h 10 min** (S01 sola, 60 min). Cada una deja en `results/` (no se versiona) sus CSV, el
historial y un informe HTML de Locust; al final `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md) con la tabla frente a RNF06, los
parámetros de cada escenario, la versión de Locust, el punto de quiebre de E01, la tendencia de S01 y el CPU y la memoria de los contenedores.
