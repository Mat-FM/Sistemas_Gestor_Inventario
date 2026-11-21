# Pruebas de rendimiento — Brayan Collazos

15 pruebas con [Locust](https://locust.io) sobre los dos servicios a cargo de Brayan: el **API Gateway** (G01 a G07) y **ms-inventario**
(I01 a I08). Usan la misma herramienta y la misma estructura que las de Luis Saraza (`../luis-saraza`): `escenarios.py` define las
pruebas, `gateway.py` e `inventario.py` tienen el código de cada una, `ejecutar.py` las corre y `resumen.py` escribe
[RESULTADOS.md](RESULTADOS.md).

## Criterio (RNF06, Entrega 1)

> Las consultas responden en menos de 2 s en el 95 % de los casos (percentil 95) y con menos de 1 % de errores, con
> 50 usuarios simulados al mismo tiempo durante 5 minutos.

Las pruebas de **carga** (consultas) verifican RNF06 con exactamente esa carga. Las demás (escritura, idempotencia,
contención, estrés y pico) se comparan con el mismo umbral, pero son **de referencia**: buscan dónde se degrada el
servicio. Cada usuario simulado espera entre 1 y 2 s entre operaciones, como una persona usando la interfaz.

## Las 15 pruebas

| ID | Servicio | Tipo | Usuarios | Duración | Qué mide |
|---|---|---|---|---|---|
| G01 | Gateway | carga | 50 | 5 min | `GET /health`: lo mínimo que cuesta una petición al Gateway (sin sesión ni base de datos) |
| G02 | Gateway | carga | 50 | 5 min | Usuarios y roles, que resuelve el propio Gateway con su base MySQL (valida el JWT y relee al usuario en cada petición) |
| G03 | Gateway | carga | 50 | 5 min | Productos y categorías reenviados a ms-catalogo |
| G04 | Gateway | carga | 50 | 5 min | Saldos, kardex y bodegas reenviados a ms-inventario |
| G05 | Gateway | escritura | 50 | 5 min | `POST /movimientos` por el Gateway, con su `Idempotency-Key`, hacia ms-inventario |
| G06 | Gateway | estrés | 0 → 200 | 5 min | Un usuario más por segundo con consultas a catálogo, inventario y usuarios, para hallar el punto de quiebre |
| G07 | Gateway | pico | 200 en 2 s | 2 min | Llegada brusca de usuarios con el uso típico de la interfaz |
| I01 | ms-inventario | carga | 50 | 5 min | Listado paginado de saldos por producto y bodega (`GET /saldos`) |
| I02 | ms-inventario | carga | 50 | 5 min | Kardex paginado y filtrado por tipo, bodega, producto y fechas (`GET /movimientos`) |
| I03 | ms-inventario | carga | 50 | 5 min | Lotes con existencia en orden FEFO, por vencer y por producto (`GET /lotes`) |
| I04 | ms-inventario | escritura | 50 | 5 min | Entradas de mercancía a la vez (`POST /movimientos`): una transacción por movimiento |
| I05 | ms-inventario | idempotencia | 50 | 3 min | El mismo movimiento reintentado con la misma clave devuelve el original y no se duplica (RNF17) |
| I06 | ms-inventario | contención | 30 | 3 min | Salidas simultáneas sobre la **misma** fila de saldo (`SELECT … FOR UPDATE`): se serializan sin errores |
| I07 | ms-inventario | estrés | 0 → 200 | 5 min | Un usuario más por segundo sobre saldos, kardex y lotes, para hallar el punto de quiebre |
| I08 | ms-inventario | pico | 200 en 2 s | 2 min | Llegada brusca de usuarios con el uso típico (consultas y alguna entrada) |

La definición exacta (clase, usuarios, ritmo de llegada y duración) está en [escenarios.py](escenarios.py) y el código en
[gateway.py](gateway.py) e [inventario.py](inventario.py). En I05 un reintento que no responde 200 con el mismo `id_movimiento`
cuenta como error.

## Modos

| `PERF_MODO` | Cómo llega la petición | Para qué |
|---|---|---|
| `directo` (por defecto) | A ms-inventario, con las cabeceras `X-User-*` que pondría el Gateway | Medir el servicio aislado (solo las pruebas I) |
| `gateway` | `POST /api/auth/login` y luego `/api/<ruta>` con el token JWT | La medición de punta a punta: pasa por el Gateway, que valida el token y limita las peticiones |

**Las pruebas G van siempre por el Gateway** y necesitan `PERF_USUARIOS` con una cuenta de ADMINISTRADOR.

**Límites del Gateway (RNF19).** Acepta 100 peticiones por minuto **por usuario** y 10 inicios de sesión por minuto por IP: con los
límites de siempre, los 429 contarían como errores y se mediría el limitador, no el Gateway. Para medir el rendimiento se suben
(`RATE_LIMIT_PER_MINUTE` y `LOGIN_RATE_LIMIT_PER_MINUTE` del Gateway, o `GATEWAY_RATE_LIMIT_PER_MINUTE` y
`GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE` en el compose) **y el informe lo dice**; así una sola cuenta atiende a los 50 usuarios simulados.
El comportamiento del propio límite (429 con `Retry-After`) lo comprueban las pruebas de funcionamiento (`../../smoke-tests`).

## Requisitos de datos

- Dos bodegas activas (`PERF_ID_BODEGA`=1 y `PERF_ID_BODEGA_2`=2) y dos productos activos (`PERF_ID_PRODUCTO`=1 y
  `PERF_ID_PRODUCTO_2`=2): ms-inventario valida el producto con ms-catalogo en cada movimiento.
- Cada prueba prepara lo que necesita al empezar (un millón de unidades de stock con un lote, un mínimo alto para que haya
  productos bajo el umbral y 200 movimientos de historia). La preparación no cuenta en las mediciones.
- **Las pruebas escriben en las bases de datos** (movimientos, saldos). Córralas en un entorno de pruebas, no sobre los datos de la demo.

## Ejecutar

La forma más simple es levantar el sistema con el script de las pruebas de funcionamiento, que deja las dos bodegas y los productos
creados y la pila en pie (sube los límites del Gateway con las dos variables):

```bash
GATEWAY_RATE_LIMIT_PER_MINUTE=100000 GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE=1000 ./smoke-tests/ejecutar.sh --conservar --sin-limites
# al final imprime el Gateway (http://127.0.0.1:18100), el administrador (admin@prueba.test / ClaveNueva2026A) y cómo apagarla
```

Con Python 3.12 y Locust (`requirements.txt`), desde esta carpeta (las pruebas G van por el Gateway y las I directo a ms-inventario, que
el compose publica en `127.0.0.1:18102`; `resumen.py` junta las dos en el mismo `RESULTADOS.md` y su columna «Vía» dice cómo llegó cada una):

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
export PERF_ENTORNO="describe aquí el equipo y cómo se levantó"
PERF_MODO=gateway PERF_GATEWAY_URL=http://127.0.0.1:18100 PERF_USUARIOS="admin@prueba.test:ClaveNueva2026A" \
  .venv/bin/python ejecutar.py G01 G02 G03 G04 G05 G06 G07
PERF_MODO=directo PERF_INVENTARIO_URL=http://127.0.0.1:18102 .venv/bin/python ejecutar.py I01 I02 I03 I04 I05 I06 I07 I08
```

- Solo algunas: `ejecutar.py G01 I05`. Comprobación rápida (10 usuarios, 30 s por prueba; no vale como resultado): `ejecutar.py --rapido`.
- Las de ms-inventario también se pueden medir por el Gateway (`PERF_MODO=gateway`): entonces incluyen lo que el Gateway añade.
- Otros datos: `PERF_ID_PRODUCTO`, `PERF_ID_PRODUCTO_2`, `PERF_ID_BODEGA`, `PERF_ID_BODEGA_2`.

Las 15 con su duración completa tardan una hora y cuarto. Cada una deja en `results/` (no se versiona) sus CSV y un informe HTML de
Locust, y al final `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md) con la tabla de resultados y el veredicto frente a RNF06.
