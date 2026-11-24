# Pruebas de rendimiento — Brayan Collazos

15 pruebas con [Locust](https://locust.io) 2.31.8 sobre los dos servicios a cargo de Brayan: el **API Gateway** (G01 a G06) y
**ms-inventario** (I01 a I06), más tres sobre la mezcla de ambos con las tipologías de la guía del taller de Locust (docente Albeiro
Montes): **carga** (M01), **estrés** (E01) y **capacidad** (S01). Usan la misma estructura que las de Mateo (`../mateo-falla`) y las de Luis
(`../luis-saraza`): `escenarios.py` define las pruebas; `gateway.py`, `inventario.py` y `mixto.py` tienen su código; `ejecutar.py` las corre
y `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md).

> **Sobre la guía del taller.** El texto de la guía no está en el repositorio: esta adaptación sigue la lectura que de ella hizo Mateo en
> `../mateo-falla` (las tres tipologías sobre una misma mezcla, spawn rate, qué cuenta como error, registro de CPU y memoria y qué documentar
> por escenario). Conviene contrastarla con el documento original.

## Criterio (RNF06, Entrega 1)

> Las consultas responden en menos de 2 s en el 95 % de los casos (percentil 95) y con menos de 1 % de errores, con
> 50 usuarios simulados al mismo tiempo durante 5 minutos.

Las siete pruebas de **consulta** (G01 a G04 e I01 a I03) verifican RNF06 con exactamente esa carga. Las demás se comparan con el mismo
umbral, pero son **de referencia**. Cada usuario simulado espera entre 1 y 2 s entre operaciones, como una persona usando la interfaz: por eso
el número de usuarios **no** es el de peticiones por segundo (el informe da los dos).

**Qué cuenta como error** (la guía advierte no contar como éxito lo que no lo es): un estado inesperado (un 409 por stock insuficiente, un
429 por el límite de peticiones…) y un cuerpo que no cumple lo esperado: un listado vacío o sin `meta`, un movimiento sin `id_movimiento`
o un reintento idempotente que devuelve otro movimiento.

## Las 15 pruebas

| ID | Tipología (guía) | Servicio | Usuarios | Spawn rate | Duración | Qué mide |
|---|---|---|---|---|---|---|
| G01 | carga (RNF06) | Gateway | 50 | 5/s | 5 min | `GET /health`: lo mínimo que cuesta una petición al Gateway (sin sesión ni base de datos) |
| G02 | carga (RNF06) | Gateway | 50 | 5/s | 5 min | Usuarios y roles, que resuelve el propio Gateway con su base MySQL (valida el JWT y relee al usuario en cada petición) |
| G03 | carga (RNF06) | Gateway → ms-catalogo | 50 | 5/s | 5 min | Productos y categorías reenviados a ms-catalogo |
| G04 | carga (RNF06) | Gateway → ms-inventario | 50 | 5/s | 5 min | Saldos, kardex y bodegas reenviados a ms-inventario |
| I01 | carga (RNF06) | ms-inventario | 50 | 5/s | 5 min | Listado paginado de saldos por producto y bodega (`GET /saldos`) |
| I02 | carga (RNF06) | ms-inventario | 50 | 5/s | 5 min | Kardex paginado y filtrado por tipo, bodega, producto y fechas (`GET /movimientos`) |
| I03 | carga (RNF06) | ms-inventario | 50 | 5/s | 5 min | Lotes con existencia en orden FEFO, por vencer y por producto (`GET /lotes`) |
| M01 | **carga** | los dos | 50 | 5/s | 10 min | Mezcla: ~85 % GET y ~15 % POST por el Gateway, en meseta (comportamiento nominal) |
| E01 | **estrés** | los dos | 0 → 300 | 2/s | 5 min | La misma mezcla con una rampa agresiva: **punto de quiebre** (usuarios y RPS) |
| S01 | **capacidad** | los dos | 60 (ajustable) | 5/s | 60 min | La misma mezcla, sostenida cerca del máximo estable: **tendencia en el tiempo** |
| G05 | carga | Gateway → ms-inventario | 50 | 5/s | 5 min | `POST /movimientos` por el Gateway, con su `Idempotency-Key` |
| G06 | carga | Gateway | 10 | 2/s | 3 min | **Inicio de sesión** (`POST /auth/login`): contraseña con bcrypt y firma del JWT |
| I04 | carga | ms-inventario | 50 | 5/s | 5 min | Entradas de mercancía a la vez (`POST /movimientos`): una transacción por movimiento |
| I05 | carga | ms-inventario | 50 | 10/s | 3 min | El mismo movimiento reintentado con la misma clave devuelve el original y no se duplica (RNF17) |
| I06 | carga | ms-inventario | 30 | 10/s | 3 min | Salidas simultáneas sobre la **misma** fila de saldo (`SELECT … FOR UPDATE`): se serializan sin errores |

La definición exacta (clase, usuarios, spawn rate y duración) está en [escenarios.py](escenarios.py). Respecto a la versión anterior, el estrés
y el pico por servicio (G06, G07, I07 e I08) pasaron a ser las tres tipologías sobre la mezcla, y se agregó G06 (inicio de sesión).

### La mezcla (M01, E01 y S01)

La guía pide que carga, estrés y capacidad usen **la misma mezcla** con GET predominante y POST minoritario, y que solo cambie la forma de la
carga. [mixto.py](mixto.py) la define, siempre por el Gateway (como las pruebas G):

| Operación | Peso |
|---|---|
| `GET /saldos` | 5 |
| `GET /movimientos` (kardex) | 4 |
| `GET /productos` (ms-catalogo) | 3 |
| `GET /lotes?vence_antes_de` | 2 |
| `GET /productos?nombre`, `GET /usuarios` y `GET /bodegas` | 1 + 1 + 1 |
| **POST** `/movimientos` ENTRADA | 2 |
| **POST** `/movimientos` SALIDA | 1 |

Son 17 de 20 en GET (85 %) y 3 en POST (15 %). El stock de preparación (1 000 000 de unidades por producto y bodega) no se agota ni en los
60 minutos de S01 (unas 7 000 salidas de 1 a 3 unidades), así que un 409 `STOCK_INSUFICIENTE` sería un defecto y no el fin de las existencias.

- **E01 (estrés)**: `resumen.py` busca en el historial segundo a segundo el primer momento en que el p95 pasa de 2 s o los errores de 1 % y
  siguen así 5 s seguidos, y anota **con cuántos usuarios y a cuántas peticiones por segundo** ocurrió.
- **S01 (capacidad)**: la guía pide una carga **cercana al máximo estable, no al quiebre**. Corra E01 primero y ajuste
  `PERF_CAPACIDAD_USUARIOS` a ~70 % de los usuarios del quiebre. **El valor por defecto (60) no está calibrado**: se eligió antes de tener
  un quiebre medido, porque en la comprobación preliminar E01 no llegó a quebrarse. `resumen.py` compara el p95, las peticiones por segundo y
  los errores del primer y el último 10 % de la meseta.

## Orden y datos

- **El orden importa.** `escenarios.py` pone las consultas primero, luego la mezcla y al final las escrituras (G05, G06 e I04 a I06):
  las escrituras agregan miles de movimientos y cambian lo que leen las pruebas siguientes (el kardex, los saldos), y S01 tiene que medir el
  sistema y no un kardex que crece. `ejecutar.py` las corre en ese orden; si las corre por separado, respételo y prefiera una pila nueva.
- Dos bodegas activas (`PERF_ID_BODEGA`=1 y `PERF_ID_BODEGA_2`=2) y dos productos activos (`PERF_ID_PRODUCTO`=1 y `PERF_ID_PRODUCTO_2`=2):
  ms-inventario valida el producto con ms-catalogo en cada movimiento.
- **Cada prueba prepara sus datos** al empezar, y eso no cuenta en la medición: un millón de unidades de stock por producto y bodega con un
  lote, un mínimo alto para que haya productos bajo el umbral y 200 movimientos de historia.
- **Las pruebas escriben en las bases de datos** (movimientos, saldos). Córralas en un entorno de pruebas, no sobre los datos de la demo.

## Lo que mostraron (preliminar)

Detalle en [RESULTADOS.md](RESULTADOS.md): pila nueva con el código de `develop` y los límites del Gateway subidos; **las siete consultas con
su duración completa (5 min, 50 usuarios)** y las otras ocho con los usuarios de su escenario y un tope de 2 min (la tabla de parámetros
dice la duración real de cada una).

- **Las siete consultas cumplen RNF06**: p95 entre 5 y 16 ms y entre 0 % y 0,09 % de errores con 50 usuarios, por el Gateway (G01 a G04) y
  directo a ms-inventario (I01 a I03, 0 % de errores).
- **Defecto hallado en el Gateway: un *deadlock* de MySQL se vuelve un 500.** Los 23 errores de la corrida (de 122 800
  peticiones, en G02, G03, G04 y M01) son el mismo: `SQLSTATE[40001] 1213 Deadlock found` en `insert ignore into cache … :timer`, y el
  registro del Gateway tiene exactamente 23 respuestas 500 en ese rato. El límite de peticiones guarda su contador en la tabla `cache` de
  MySQL (`CACHE_STORE=database`, para que las réplicas lo compartan: RNF05); cuando arranca una prueba o se renueva la ventana de un minuto,
  varias peticiones intentan crear a la vez la misma clave y MySQL aborta una. El Gateway responde `500 ERROR_INTERNO` a una petición válida. Estaba dentro de RNF06 (< 1 %), pero crece con la concurrencia y con las réplicas.
  **Corregido después de esta corrida (PR #33)**: `DatabaseStoreConReintento` reintenta el contador ante un *deadlock*. La tabla de
  `RESULTADOS.md` es de antes del arreglo; con él, G02, G03, G04, M01 y E01 (2 min, 50 usuarios y estrés hasta unos 240) dieron 0 errores en
  23 568 peticiones y 0 respuestas 500, con 36 *deadlocks* reales resueltos todos en el primer reintento.
- **Mezcla (M01, E01 y S01)**, 2 min cada una: M01 con p95 de 17 ms y 0,13 % de errores (los mismos *deadlocks*); E01 **no se quebró**: en
  2 min alcanzó 238 usuarios y 101 peticiones/s con p99 de 32 ms, aunque una petición tardó 50 s; S01 estable (p95 de 17 a 15 ms), pero 2
  minutos no dicen nada sobre la tendencia de una hora. **El quiebre y la tendencia reales exigen E01 completa (5 min, 300 usuarios) y
  S01 completa (60 min)**: no se corrieron.
- **Las escrituras y la idempotencia** (G05, I04 e I05): 0 % de errores y p95 de 8 a 19 ms. En I05, ningún reintento con la misma clave
  duplicó un movimiento (0 errores en 19 343 peticiones). **La contención** (I06, 30 usuarios sobre la misma fila de saldo): 0 % de errores y p95 de 9 ms.
- **Inicio de sesión** (G06): 200 ms de p95 con 10 usuarios, que es lo que cuesta verificar la
  contraseña (hash lento a propósito) y firmar el JWT.
- **CPU**: el Gateway es el que más usa (hasta 151 %), seguido de ms-catalogo (53 %) y ms-inventario (40 %); la memoria no pasa de 500 MB
  por contenedor (las bases de datos).
- **El equipo se suspendió** en dos pruebas de una primera pasada (I01 e I06 mostraban 16,9 y 13,8 peticiones/s con las mismas peticiones
  que las demás): se repitieron con `caffeinate` y el equipo despierto. Si corre las pruebas en un portátil, evite que se duerma.

## Modos

| `PERF_MODO` | Cómo llega la petición | Para qué |
|---|---|---|
| `directo` (por defecto) | A ms-inventario, con las cabeceras `X-User-*` que pondría el Gateway | Medir el servicio aislado (solo las pruebas I) |
| `gateway` | `POST /api/auth/login` y luego `/api/<ruta>` con el token JWT | La medición de punta a punta: pasa por el Gateway, que valida el token y limita las peticiones |

**Las pruebas G y la mezcla (M01, E01 y S01) van siempre por el Gateway** y necesitan `PERF_USUARIOS` con una cuenta de ADMINISTRADOR. La
columna «Vía» de `RESULTADOS.md` dice cómo llegó cada prueba.

**Límites del Gateway (RNF19).** Acepta 100 peticiones por minuto **por usuario** y 10 inicios de sesión por minuto por IP: con los
límites de siempre, los 429 contarían como errores y se mediría el limitador, no el Gateway. Para medir el rendimiento se suben
(`RATE_LIMIT_PER_MINUTE` y `LOGIN_RATE_LIMIT_PER_MINUTE` del Gateway, o `GATEWAY_RATE_LIMIT_PER_MINUTE` y
`GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE` en el compose) **y el informe lo dice**; así una sola cuenta atiende a los 50 usuarios simulados.
El comportamiento del propio límite (429 con `Retry-After`) lo comprueban las pruebas de funcionamiento (`../../smoke-tests`).

## Ejecutar

Se usa la imagen oficial de Locust, sin instalar nada, dentro de la red del compose.

**1. Levantar la pila de pruebas** (desde la raíz del repositorio), con los límites del Gateway subidos. Deja las dos bodegas y los
productos creados y la pila en pie:

```bash
GATEWAY_RATE_LIMIT_PER_MINUTE=100000 GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE=1000 ./smoke-tests/ejecutar.sh --conservar --sin-limites
# al final imprime el Gateway (http://127.0.0.1:18100), el administrador (admin@prueba.test / ClaveNueva2026A) y cómo apagarla
```

**2. Registrar CPU y memoria** (opcional, en otra terminal, desde esta carpeta): `./recursos.sh`, y Ctrl+C al terminar.

**3. Correr las pruebas** (desde esta carpeta):

```bash
docker run --rm --network gi-prueba_default -v "$PWD":/mnt/locust -w /mnt/locust \
  -e PERF_MODO=directo -e PERF_GATEWAY_URL=http://api-gateway:8000 -e PERF_INVENTARIO_URL=http://ms-inventario:3000 \
  -e PERF_USUARIOS="admin@prueba.test:ClaveNueva2026A" \
  -e PERF_ENTORNO="describa aquí el equipo (CPU, RAM) y cómo se levantó la pila" \
  --entrypoint python locustio/locust:2.31.8 ejecutar.py
```

- Comprobación rápida (10 usuarios, 30 s por prueba; no vale como resultado): agregar `--rapido` al final.
- Preliminar: `ejecutar.py --duracion=2m` (los mismos usuarios; `--duracion` es un tope: cada prueba dura como máximo ese tiempo).
- Solo algunas: `ejecutar.py G01 I03` (respete el orden de la tabla). Las de ms-inventario también se pueden medir por el Gateway con
  `PERF_MODO=gateway`.
- Otros datos: `PERF_ID_PRODUCTO`, `PERF_ID_PRODUCTO_2`, `PERF_ID_BODEGA`, `PERF_ID_BODEGA_2`, `PERF_CAPACIDAD_USUARIOS`.

Las 15 con su duración completa tardan unas **2 h 20 min** (S01 sola, 60 min). Cada una deja en `results/` (no se versiona) sus CSV, el
historial y un informe HTML de Locust; al final `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md) con la tabla frente a RNF06, los
parámetros de cada escenario, la versión de Locust, el punto de quiebre de E01, la tendencia de S01 y el CPU y la memoria de los contenedores.
