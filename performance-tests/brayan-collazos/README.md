# Pruebas de rendimiento — Brayan Collazos

15 pruebas con [Locust](https://locust.io) sobre **ms-inventario**, el servicio a cargo de Brayan (I01 a I15). Usan la misma
herramienta y la misma estructura que las de Luis Saraza (`../luis-saraza`): `escenarios.py` define las pruebas, `inventario.py`
tiene el código de cada una, `ejecutar.py` las corre y `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md).

## Criterio (RNF06, Entrega 1)

> Las consultas responden en menos de 2 s en el 95 % de los casos (percentil 95) y con menos de 1 % de errores, con
> 50 usuarios simulados al mismo tiempo durante 5 minutos.

Las pruebas de **carga** (consultas) verifican RNF06 con exactamente esa carga. Las demás (escritura, idempotencia,
contención, integración, estrés y pico) se comparan con el mismo umbral, pero son **de referencia**: buscan dónde se degrada el
servicio. Cada usuario simulado espera entre 1 y 2 s entre operaciones, como una persona usando la interfaz.

## Las 15 pruebas

| ID | Tipo | Usuarios | Duración | Qué mide |
|---|---|---|---|---|
| I01 | carga | 50 | 5 min | Listado paginado de saldos por producto y bodega (`GET /saldos`) |
| I02 | carga | 50 | 5 min | Saldos de un producto, con su total, y de una bodega (`?id_producto`, `?id_bodega`) |
| I03 | carga | 50 | 5 min | Kardex paginado y filtrado por tipo, bodega, producto y fechas (`GET /movimientos`) |
| I04 | carga | 50 | 5 min | Lotes con existencia en orden FEFO, por vencer y por producto (`GET /lotes`) |
| I05 | carga | 50 | 5 min | De qué lotes sacar una cantidad, por FEFO (`GET /lotes/sugerencia-salida`) |
| I06 | carga | 50 | 5 min | Bodegas y umbrales de stock mínimo (`GET /bodegas`, `/bodegas/{id}`, `/umbrales`) |
| I07 | carga | 50 | 5 min | Productos bajo su mínimo, sumados entre bodegas (`GET /saldos/bajo-umbral`) |
| I08 | carga | 50 | 5 min | Listados de traslados (también en tránsito) y de conteos |
| I09 | escritura | 50 | 5 min | Entradas de mercancía a la vez (`POST /movimientos`): una transacción por movimiento |
| I10 | escritura | 50 | 5 min | Salidas que consumen el lote que vence primero, con su reposición |
| I11 | idempotencia | 50 | 3 min | El mismo movimiento reintentado con la misma clave devuelve el original y no se duplica (RNF17) |
| I12 | contención | 30 | 3 min | Salidas simultáneas sobre la **misma** fila de saldo (`SELECT … FOR UPDATE`): se serializan sin errores |
| I13 | integración | 20 | 5 min | Enviar un traslado y recibirlo: inventario valida el producto en catálogo en cada paso |
| I14 | estrés | 0 → 200 | 5 min | Un usuario más por segundo sobre saldos, kardex y lotes, para hallar el punto de quiebre |
| I15 | pico | 200 en 2 s | 2 min | Llegada brusca de usuarios con el uso típico (consultas y alguna entrada) |

La definición exacta (clase, usuarios, ritmo de llegada y duración) está en [escenarios.py](escenarios.py) y el código de cada
una en [inventario.py](inventario.py). En I11 un reintento que no responde 200 con el mismo `id_movimiento` cuenta como error.

## Modos

| `PERF_MODO` | Cómo llega la petición | Para qué |
|---|---|---|
| `directo` (por defecto) | A ms-inventario, con las cabeceras `X-User-*` que pondría el Gateway | Medir el servicio aislado |
| `gateway` | `POST /api/auth/login` y luego `/api/<ruta>` con el token JWT | La medición de punta a punta: pasa por el Gateway, que valida el token y limita las peticiones |

**Límites del Gateway (RNF19).** El Gateway acepta 100 peticiones por minuto **por usuario** y 10 inicios de sesión por minuto
por IP: 50 usuarios simulados necesitan **al menos 25 cuentas** (`PERF_USUARIOS="correo:clave,correo:clave,..."`), o un Gateway de
pruebas con `RATE_LIMIT_PER_MINUTE` y `LOGIN_RATE_LIMIT_PER_MINUTE` altos, diciéndolo en el informe. Si no, los 429 cuentan como
errores y la prueba no cumple por el limitador, no por el servicio.

## Requisitos de datos

- ms-inventario debe tener dos bodegas activas (`PERF_ID_BODEGA`=1 y `PERF_ID_BODEGA_2`=2) y ms-catalogo dos productos activos
  (`PERF_ID_PRODUCTO`=1 y `PERF_ID_PRODUCTO_2`=2): ms-inventario valida el producto con ms-catalogo en cada movimiento.
- Cada prueba prepara lo que necesita al empezar (un millón de unidades de stock con un lote, un mínimo alto para que haya
  productos bajo el umbral y 200 movimientos de historia). La preparación no cuenta en las mediciones.
- **Las pruebas escriben en las bases de datos** (movimientos, saldos, traslados). Córralas en un entorno de pruebas, no sobre
  los datos de la demo.

## Ejecutar

Con Python 3.12 y los servicios arriba (ms-inventario y ms-catalogo), desde esta carpeta:

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
PERF_INVENTARIO_URL=http://127.0.0.1:<puerto> .venv/bin/python ejecutar.py
```

También sirve la imagen oficial de Locust en la red de docker compose, como en la carpeta de Luis:

```bash
docker run --rm --network gestor-inventario_default -v "$PWD":/mnt/locust -w /mnt/locust \
  --entrypoint python locustio/locust:2.31.8 ejecutar.py
```

- Solo algunas: `ejecutar.py I01 I09`. Comprobación rápida (10 usuarios, 30 s por prueba; no vale como resultado): `ejecutar.py --rapido`.
- Por el Gateway: agregar `PERF_MODO=gateway`, `PERF_GATEWAY_URL` y `PERF_USUARIOS`.
- Otros datos: `PERF_ID_PRODUCTO`, `PERF_ID_PRODUCTO_2`, `PERF_ID_BODEGA`, `PERF_ID_BODEGA_2`.

Las 15 con su duración completa tardan unos 70 minutos. Cada una deja en `results/` (no se versiona) sus CSV y un informe HTML de
Locust, y al final `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md) con la tabla de resultados y el veredicto frente a RNF06.
