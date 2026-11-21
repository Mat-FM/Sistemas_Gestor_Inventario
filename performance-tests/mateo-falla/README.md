# Pruebas de rendimiento — Mateo Falla

15 pruebas con [Locust](https://locust.io) sobre los tres servicios a cargo de Mateo: **ms-catalogo** (K01 a K06), **ms-proveedores**
(P01 a P04) y **ms-reportes** (R01 a R05). Usan la misma herramienta y la misma estructura que las de Brayan (`../brayan-collazos`) y las de
Luis (`../luis-saraza`): `escenarios.py` define las pruebas, `catalogo.py`, `proveedores.py` y `reportes.py` tienen el código de cada una,
`ejecutar.py` las corre y `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md).

> **Borrador de Brayan para Mateo.** Estas pruebas las preparó Brayan (con Claude Code) para completar RNF11, porque `mateo-falla/` estaba
> vacía. Mateo debe revisarlas, ajustarlas con lo que conoce de sus servicios y adoptarlas como suyas (o reemplazarlas); el resultado de
> abajo es preliminar.

## Criterio (RNF06, Entrega 1)

> Las consultas responden en menos de 2 s en el 95 % de los casos (percentil 95) y con menos de 1 % de errores, con
> 50 usuarios simulados al mismo tiempo durante 5 minutos.

Las pruebas de **carga** (consultas) verifican RNF06 con exactamente esa carga. Las demás (escritura, exportación, estrés y pico) se
comparan con el mismo umbral, pero son **de referencia**: buscan dónde se degrada el servicio. Cada usuario simulado espera entre 1 y 2 s
entre operaciones, como una persona usando la interfaz.

## Las 15 pruebas

| ID | Servicio | Tipo | Usuarios | Duración | Qué mide |
|---|---|---|---|---|---|
| R01 | ms-reportes | carga | 50 | 5 min | Existencias por producto y bodega, y valorización (`GET /reportes/existencias` y `/reportes/valorizacion`) |
| R02 | ms-reportes | carga | 50 | 5 min | Rotación de 30 días y panel de indicadores (`GET /reportes/rotacion` y `/indicadores`) |
| R03 | ms-reportes | carga | 50 | 5 min | Kardex de un producto, con y sin periodo (`GET /reportes/kardex`) |
| R04 | ms-reportes | exportación | 30 | 3 min | Los reportes como archivo: CSV de existencias y de kardex, y PDF de valorización |
| R05 | ms-reportes | estrés | 0 → 200 | 5 min | Un usuario más por segundo sobre todos los reportes en JSON, para hallar el punto de quiebre |
| K01 | ms-catalogo | carga | 50 | 5 min | Listado paginado de productos (`GET /productos`) |
| K02 | ms-catalogo | carga | 50 | 5 min | Búsqueda por nombre, por código y por categoría (`GET /productos` con filtros) |
| K03 | ms-catalogo | carga | 50 | 5 min | Un producto, el árbol de categorías y una categoría (`GET /productos/{id}`, `/categorias`, `/categorias/{id}`) |
| K04 | ms-catalogo | escritura | 50 | 5 min | Altas de productos a la vez (`POST /productos`), con código único |
| K05 | ms-catalogo | estrés | 0 → 200 | 5 min | Un usuario más por segundo sobre el listado, la búsqueda y la consulta de productos |
| K06 | ms-catalogo | pico | 200 en 2 s | 2 min | Llegada brusca de usuarios con el uso típico (consultas y alguna alta) |
| P01 | ms-proveedores | carga | 50 | 5 min | Listado, por razón social y por producto (`GET /proveedores`) |
| P02 | ms-proveedores | carga | 50 | 5 min | Un proveedor y sus productos asociados (`GET /proveedores/{id}` y `/proveedores/{id}/productos`) |
| P03 | ms-proveedores | escritura | 50 | 5 min | Altas de proveedores a la vez (`POST /proveedores`), con NIT único |
| P04 | ms-proveedores | pico | 200 en 2 s | 2 min | Llegada brusca de usuarios con el uso típico (consultas y alguna alta) |

Las ocho de consulta (R01 a R03, K01 a K03, P01 y P02) son las que verifica RNF06. La definición exacta (clase, usuarios, ritmo de
llegada y duración) está en [escenarios.py](escenarios.py).

**El orden importa.** `ms-reportes` calcula sus reportes recorriendo **todos** los productos de `ms-catalogo` y todos los saldos de
`ms-inventario`. Las altas de K04 y K06 agrandan el catálogo (miles de productos en una corrida completa), y entonces R01 a R05 medirían el
catálogo y no el servicio de reportes. Por eso `escenarios.py` pone R01 a R05 primero y `ejecutar.py` las corre en ese orden: si las
corre por separado, hágalo igual. El kardex de R03 va siempre filtrado por producto: sin filtro, con muchos movimientos, `ms-reportes`
responde 422 a propósito (`KARDEX_MAX_FILAS`) y no sería una consulta del uso normal.

## Lo que mostraron (preliminar, 1 min por prueba)

Detalle en [RESULTADOS.md](RESULTADOS.md). Siete de las ocho consultas cumplen RNF06 con 0 % de errores; **R02 (rotación e indicadores) no**:
p95 de 2,3 s con 50 usuarios, porque cada petición hace varias llamadas seguidas a otros servicios (el panel tarda ~1,4 s él solo). Además:

- **Los reportes escalan con el catálogo.** `ms-reportes` trae todos los productos de `ms-catalogo` de 100 en 100 en cada petición. Con ~3 000
  productos, una sola petición de existencias tarda ~1 s y con 50 usuarios todo pasa de los 3 s que espera el Gateway (503). En una primera
  corrida, hecha sobre un catálogo ya agrandado por las altas de K04, R01 a R05 dieron entre 82 % y 100 % de errores; sobre una pila nueva dan
  0 %. Por eso las pruebas de reportes van primero y conviene correrlas sobre una pila nueva.
- **Gunicorn atendía de a dos.** Con 2 procesos síncronos, `ms-reportes` solo atendía 2 reportes a la vez aunque casi todo el tiempo espera a
  otros servicios. La imagen ahora usa hilos (`GUNICORN_THREADS`, 8 por proceso). No se midió la mejora de forma controlada (antes y después
  sobre el mismo catálogo): conviene hacerlo.
- **Estrés y pico.** K05 y R05 (200 usuarios) tienen 2 % de errores; en los picos (K06, P04) el percentil 99 llega a 6–8 s y el máximo a ~1 min:
  los 200 usuarios entran de golpe y se forma cola. Son pruebas de referencia.
- Posibles mejoras, para que Mateo decida: pedir en paralelo las páginas y los servicios que no dependen entre sí, o guardar unos segundos la
  lista de productos en `ms-reportes`.

## Modos

| `PERF_MODO` | Cómo llega la petición | Para qué |
|---|---|---|
| `directo` (por defecto) | A cada servicio, con las cabeceras `X-User-*` que pondría el Gateway | Medir el servicio aislado. Los servicios **no publican puertos** (RNF09): hay que correrlo dentro de la red de contenedores (`PERF_CATALOGO_URL`, `PERF_PROVEEDORES_URL`, `PERF_REPORTES_URL`) |
| `gateway` | `POST /api/auth/login` y luego `/api/<ruta>` con el token JWT | La medición de punta a punta, y la única que se puede correr desde fuera de la red: pasa por el Gateway, que valida el token y limita las peticiones |

Para preparar el stock que miran los reportes, R01 a R05 también escriben en `ms-inventario` (por el Gateway en modo `gateway`; en modo
directo, con `PERF_INVENTARIO_URL`).

**Límites del Gateway (RNF19).** Acepta 100 peticiones por minuto **por usuario** y 10 inicios de sesión por minuto por IP: con los
límites de siempre, los 429 contarían como errores y se mediría el limitador. Para medir el rendimiento se suben
(`GATEWAY_RATE_LIMIT_PER_MINUTE` y `GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE` en el compose) **y el informe lo dice**; así una sola cuenta atiende
a los 50 usuarios simulados. El límite en sí (429 con `Retry-After`) lo comprueban las pruebas de funcionamiento (`../../smoke-tests`).

## Requisitos de datos

- Dos bodegas activas (`PERF_ID_BODEGA`=1 y `PERF_ID_BODEGA_2`=2) para el stock de los reportes.
- Cada prueba prepara lo que necesita al empezar y no cuenta en las mediciones: K01 a K06, una categoría con una subcategoría y 60 productos;
  P01 a P04, 40 proveedores con 5 productos asociados cada uno; R01 a R05, 30 productos con stock en las dos bodegas, un lote y 4 movimientos
  cada uno.
- **Las pruebas escriben en las bases de datos** (productos, proveedores, movimientos). Córralas en un entorno de pruebas, no sobre los datos
  de la demo.

## Ejecutar

La forma más simple es levantar el sistema con el script de las pruebas de funcionamiento, que deja las bodegas creadas y la pila en pie
(sube los límites del Gateway con las dos variables):

```bash
GATEWAY_RATE_LIMIT_PER_MINUTE=100000 GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE=1000 ./smoke-tests/ejecutar.sh --conservar --sin-limites
# al final imprime el Gateway (http://127.0.0.1:18100), el administrador (admin@prueba.test / ClaveNueva2026A) y cómo apagarla
```

Con Python 3.12 y Locust (`requirements.txt`), desde esta carpeta:

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
export PERF_ENTORNO="describe aquí el equipo y cómo se levantó"
PERF_MODO=gateway PERF_GATEWAY_URL=http://127.0.0.1:18100 PERF_INVENTARIO_URL=http://127.0.0.1:18102 \
  PERF_USUARIOS="admin@prueba.test:ClaveNueva2026A" .venv/bin/python ejecutar.py
```

- Solo algunas: `ejecutar.py R01 K03`. Comprobación rápida (10 usuarios, 30 s por prueba; no vale como resultado): `ejecutar.py --rapido`.
- Preliminar: `ejecutar.py --duracion=1m` (los mismos usuarios, cada prueba dura como máximo 1 min).
- Otros datos: `PERF_ID_BODEGA`, `PERF_ID_BODEGA_2`.

Las 15 con su duración completa tardan unos 65 minutos. Cada una deja en `results/` (no se versiona) sus CSV y un informe HTML de Locust, y
al final `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md) con la tabla de resultados y el veredicto frente a RNF06.
