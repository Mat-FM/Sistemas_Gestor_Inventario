# ms-inventario

Bodegas, saldos y umbrales de stock mínimo, movimientos (kardex), lotes con salida FEFO, traslados entre bodegas, conteos
físicos y carga inicial de saldos. Es el servicio más consultado.

- **Framework:** Express 5 (Node.js ≥ 22.9) con Knex y `pg` · **Base de datos:** PostgreSQL 16 · **Puerto en el clúster:** 3000
- **Requerimientos:** RF04, RF05, RF09, RF10, RF13, RF15, RF17, RF18 (y la carga inicial de stock de RF16)
- **Entidades:** `Bodega`, `Saldo`, `Movimiento`, `Lote`, `Traslado`, `Conteo`, `DetalleConteo`, `UmbralProducto`
- **Escalado:** pasa automáticamente de 1 a 4 copias cuando la CPU supera el 70 % (RNF05). No guarda sesión ni ningún otro
  dato de petición en memoria: lo único que cambia en el proceso entre peticiones es el estado de los cortacircuitos
  (ver «Resiliencia»).
- **Documentación de la API:** `GET /docs` (Swagger UI) y `GET /docs/openapi.yaml` (el documento `openapi.yaml`). Es la
  referencia completa, con esquemas, ejemplos y todos los códigos de error de cada ruta; este README no la repite.

## Qué hace

- **Bodegas** (RF05): alta, edición y baja lógica (`inactivar` / `activar`; no se borran). Una bodega inactiva rechaza
  movimientos, traslados (como origen o como destino) y conteos nuevos.
- **Saldos y umbrales** (RF09): existencias por producto y bodega, y el stock mínimo de cada producto. Tras cada movimiento se
  compara el total de todas las bodegas con el umbral y, si queda estrictamente por debajo, se avisa a ms-notificaciones.
- **Movimientos y kardex** (RF04, RF10, RF13, RF15): cada cambio de stock deja un movimiento con su autor y el saldo resultante.
  Tipos: `ENTRADA`, `SALIDA`, `AJUSTE`, `DEVOLUCION_CLIENTE`, `ENTRADA_COMPRA`, `DEVOLUCION_PROVEEDOR`, `TRASLADO_SALIDA`,
  `TRASLADO_ENTRADA` y `CARGA_INICIAL`. Las operaciones bloquean el saldo mientras lo actualizan (`SELECT … FOR UPDATE`):
  dos movimientos simultáneos nunca lo dejan negativo.
- **Lotes con FEFO** (RF17): los lotes nacen y cambian con los movimientos. Una salida sin lote consume primero los que vencen
  antes, y `GET /lotes/sugerencia-salida` calcula esa misma asignación sin reservar nada.
- **Traslados** (RF04): dos pasos, envío (`TRASLADO_SALIDA`) y recepción (`TRASLADO_ENTRADA`); entre ambos la mercancía está
  en tránsito. Un traslado nunca hace FEFO: con `id_lote` mueve ese lote y sin él solo stock sin lote.
- **Conteos físicos** (RF18): se programan, se registra lo contado y un administrador los aprueba; la aprobación aplica un
  `AJUSTE` por cada diferencia, todo en una transacción.
- **Carga inicial** (RF16): ruta interna que usa ms-reportes para importar el stock de arranque.

## Rutas

Las rutas no llevan el prefijo `/api`: el Gateway lo quita al reenviar (`GET /api/saldos` llega como `GET /saldos`). Roles:
ADM = `ADMINISTRADOR`, OPE = `OPERADOR_BODEGA`, CON = `CONTADOR`. Los permisos por rol los aplica el Gateway (matriz de las
Tablas 7 a 12 de la Entrega 2); este servicio solo aplica el alcance por bodega del operador. «Interno» es otro servicio del
clúster que llama directamente, sin pasar por el Gateway. El `operationId` es el de `openapi.yaml`.

| Método | Ruta | Qué hace | Quién la llama | `operationId` |
| --- | --- | --- | --- | --- |
| `GET` | `/bodegas` | Lista las bodegas (`?activa`, paginado) | Todos los roles; ms-reportes | `listarBodegas` |
| `GET` | `/bodegas/{id}` | Una bodega | Todos los roles | `obtenerBodega` |
| `POST` | `/bodegas` | Crea una bodega (el `codigo` es único sin distinguir mayúsculas) | ADM | `crearBodega` |
| `PUT` | `/bodegas/{id}` | Cambia nombre, ciudad y dirección | ADM | `actualizarBodega` |
| `POST` | `/bodegas/{id}/inactivar` | Da de baja la bodega | ADM | `inactivarBodega` |
| `POST` | `/bodegas/{id}/activar` | La reactiva | ADM | `activarBodega` |
| `GET` | `/saldos` | Saldos por producto y bodega; con `id_producto`, `meta.cantidad_total` | Todos los roles; ms-reportes | `listarSaldos` |
| `GET` | `/saldos/bajo-umbral` | Productos cuyo total está por debajo de su mínimo (arreglo plano, totales de todas las bodegas) | ADM; ms-notificaciones y ms-reportes | `listarSaldosBajoUmbral` |
| `GET` | `/umbrales` | Lista los umbrales de stock mínimo | ADM | `listarUmbrales` |
| `PUT` | `/umbrales/{id_producto}` | Crea o actualiza el umbral de un producto (consulta ms-catalogo) | ADM | `guardarUmbral` |
| `POST` | `/movimientos` | Registra un movimiento (`Idempotency-Key` obligatoria; consulta ms-catalogo) | ADM, OPE; ms-compras | `registrarMovimiento` |
| `GET` | `/movimientos` | Kardex, del más reciente al más antiguo (`tipo`, producto, bodega, `fecha_desde`, `fecha_hasta`) | ADM, CON, OPE; ms-reportes | `listarMovimientos` |
| `GET` | `/movimientos/{id}` | Un movimiento | ADM, CON, OPE | `obtenerMovimiento` |
| `GET` | `/lotes` | Lotes en orden FEFO (`vence_antes_de`, `con_existencia`, producto, bodega) | ADM, OPE; ms-notificaciones y ms-reportes | `listarLotes` |
| `GET` | `/lotes/sugerencia-salida` | De qué lotes sacar una cantidad, por FEFO (no reserva nada) | ADM, OPE | `sugerirSalidaDeLotes` |
| `POST` | `/traslados` | Envía mercancía de una bodega a otra (`Idempotency-Key`; consulta ms-catalogo) | ADM, OPE | `crearTraslado` |
| `GET` | `/traslados` | Lista los traslados (el operador ve los de su bodega, como origen o destino) | ADM, OPE | `listarTraslados` |
| `POST` | `/traslados/{id}/recepcion` | Recibe el traslado en la bodega de destino (`Idempotency-Key`) | ADM, OPE | `recibirTraslado` |
| `POST` | `/conteos` | Programa un conteo físico (máximo 1 000 líneas) | ADM | `programarConteo` |
| `GET` | `/conteos` | Lista los conteos, sin sus líneas | ADM, OPE | `listarConteos` |
| `GET` | `/conteos/{id}` | Un conteo con sus líneas | ADM, OPE | `obtenerConteo` |
| `PUT` | `/conteos/{id}/detalles` | Registra las cantidades contadas (máximo 1 000 líneas) | ADM, OPE | `registrarDetallesConteo` |
| `POST` | `/conteos/{id}/aprobacion` | Aprueba el conteo y ajusta el inventario (`Idempotency-Key`) | ADM | `aprobarConteo` |
| `POST` | `/internas/saldos/carga-inicial` | Importa el stock inicial, hasta 1 000 filas (`Idempotency-Key`) | Solo ms-reportes | `cargarSaldosIniciales` |
| `GET` | `/health` | Sonda de vida: 200 `{estado: ok, servicio}`; 503 si la configuración está incompleta | Kubernetes | `comprobarSalud` |
| `GET` | `/docs` y `/docs/openapi.yaml` | Swagger UI y el documento OpenAPI | Cualquiera que alcance el servicio | — |

`GET /health`, `GET /docs` y `GET /docs/openapi.yaml` son del propio servicio: no pasan por el Gateway ni se escriben en el
registro de peticiones. `/health` no consulta la base de datos, para que una caída de PostgreSQL no reinicie el contenedor.
`/docs` carga Swagger UI desde un CDN (`cdn.jsdelivr.net`): el navegador necesita acceso a internet.

Formato común (Entrega 2, sección 4.1): errores `{"error": {"codigo", "mensaje", "detalles"}}` con los códigos
`PETICION_MAL_FORMADA` 400, `NO_AUTENTICADO` 401, `SIN_PERMISO` 403, `NO_EXISTE` 404, `CONFLICTO` 409,
`DATOS_NO_VALIDOS` 422, `SERVICIO_NO_DISPONIBLE` 503 (también si PostgreSQL no se puede alcanzar, D35) y `ERROR_INTERNO` 500 (sin traza ni mensaje), más los propios de este
servicio (`STOCK_INSUFICIENTE`, `CODIGO_DUPLICADO`, `BODEGA_INACTIVA`, `TRASLADO_YA_RECIBIDO`, `CONTEO_ESTADO_INVALIDO`, todos
409); listados `{"datos": [...], "meta": {"pagina", "por_pagina", "total"}}` con `?pagina=1&por_pagina=20` (máximo 100);
instantes en ISO 8601 UTC y fechas de un día como `AAAA-MM-DD`.

## Identidad y alcance por bodega

El servicio no tiene usuarios propios: confía en las cabeceras que el Gateway repone en cada petición (el Gateway descarta
las que mande el cliente).

| Cabecera | Contenido |
| --- | --- |
| `X-User-Id` | Entero positivo. **Obligatoria en toda escritura** (`POST`, `PUT`, también la carga inicial, D22): cada movimiento guarda su autor (RF10). Sin ella, 401 |
| `X-User-Rol` | `ADMINISTRADOR`, `OPERADOR_BODEGA`, `VENDEDOR` o `CONTADOR`. `X-User-Id` sin `X-User-Rol` es 401 |
| `X-User-Bodega` | Entero positivo; solo la lleva el operador de bodega |
| `X-Request-Id` | Identificador de la petición (1 a 128 caracteres: letras, dígitos, `.`, `_`, `:` y `-`). Si falta o no es válido, el servicio genera un UUID. Siempre se devuelve en la respuesta |

- Una cabecera de identidad presente pero inválida es **401** `NO_AUTENTICADO`; nunca se ignora en silencio.
- Las **lecturas** (`GET`) sin `X-User-Id` son válidas: son las llamadas internas de ms-notificaciones y ms-reportes.
- **Alcance por bodega.** El operador de bodega solo ve y opera su bodega (`X-User-Bodega`): sin bodega asignada, o con una
  consulta o un cuerpo que nombran otra, la respuesta es 403 `SIN_PERMISO`; si no pide ninguna, la consulta se limita a la
  suya. Los demás roles y las llamadas internas no tienen restricción. Aplica a saldos, movimientos, lotes, traslados y a la
  lectura y el registro de lo contado en los conteos; no aplica a bodegas, umbrales, `/saldos/bajo-umbral`, programar y
  aprobar conteos (solo ADM, lo aplica el Gateway) ni la carga inicial.

## Idempotencia (RNF17)

Registrar movimientos, crear y recibir traslados, aprobar un conteo y la carga inicial exigen la cabecera `Idempotency-Key`:
de 1 a 200 caracteres (se recortan los espacios de los extremos) y **sin el carácter `#`** (400 si falta, está vacía o no
cumple). El `#`
está prohibido porque las operaciones que generan varios movimientos derivan sus claves con `#` (`<clave>#<n>`) y la clave de
un usuario no puede coincidir con una derivada.

- La clave se guarda acotada **por usuario y por operación** (`<id_usuario>:<operación>:<clave>`): otro usuario, o el mismo
  usuario en otra operación (la misma clave sirve para un movimiento y para un traslado), no la reconoce como repetición.
- **Repetición:** con la misma clave del mismo usuario y la misma operación, el servicio devuelve **200 con el resultado ya
  registrado, sin repetir la operación** (el primer éxito es 201). En movimientos, traslados y recepciones no mira el cuerpo,
  aunque sea otro, ni llama al catálogo. Repetir la creación de un traslado devuelve el traslado en su estado **actual** (por
  ejemplo `RECIBIDO`) y el movimiento de salida original. Repetir la aprobación de un conteo devuelve el conteo y sus
  movimientos originales, sin nuevos ajustes. Una clave que ya se usó en otro recurso del mismo tipo (la recepción de otro
  traslado, la aprobación de otro conteo) es 409 `CONFLICTO`.
- **Carga inicial:** es idempotente por fila (la fila `n` lleva la clave `<id_usuario>:ini:<clave>#<n>`). Con la misma clave,
  las filas ya aplicadas cuentan como `creados` sin volver a procesarse, pero reenviar las mismas filas con una clave
  **nueva** las suma otra vez (la idempotencia es por clave y posición, no por contenido).
- **Los errores no se guardan:** tras un 409 o un 422, reintentar con la misma clave vuelve a ejecutar la operación.
- **Una clave identifica un solo movimiento.** Como una repetición no mira el cuerpo, usar la misma clave para dos movimientos
  distintos hace que el segundo no se registre y reciba el 200 del primero, **sin ningún error**. Quien registre varios movimientos
  (por ejemplo, las líneas de una recepción) necesita una clave por movimiento.
- Quien llama debe reenviar siempre el mismo `X-User-Id` y derivar la clave de forma determinista de su propia operación.

## Resiliencia (RNF18) y llamadas entre servicios

Solo hace dos llamadas salientes, ambas por REST/JSON, con las cabeceras `X-Request-Id` y `X-User-*` de la petición que las
origina (ninguna otra cabecera del cliente viaja):

| Hacia | Llamada | La disparan | Si falla |
| --- | --- | --- | --- |
| ms-catalogo (con espera) | `GET /productos/{id}`, para confirmar que el producto existe | `PUT /umbrales/{id_producto}`, `POST /movimientos` y `POST /traslados` | **503** `SERVICIO_NO_DISPONIBLE` y no cambia nada. Un 404 del catálogo es 404 aquí. Una repetición de una clave ya registrada no llama al catálogo |
| ms-notificaciones (aviso) | `POST /internas/notificaciones` con `{tipo: STOCK_BAJO, mensaje, id_producto, id_bodega}` | Tras confirmar un movimiento (salvo traslados y carga inicial) y tras cada `AJUSTE` de la aprobación de un conteo, si el total de las bodegas queda **estrictamente** por debajo del umbral del producto | Solo se anota en el registro: no se espera la respuesta, no se reintenta y nunca cambia la respuesta del movimiento |

- **Plazo:** cada intento espera como máximo `CALL_TIMEOUT_MS` (3 s por defecto; entre 1 y 60 000 ms).
- **Reintentos:** solo en operaciones que no se duplican, es decir, la lectura al catálogo: hasta 3 reintentos con esperas de
  0,2, 0,4 y 0,8 s (peor caso: 4 intentos de 3 s más las esperas, unos 13,4 s). El aviso a ms-notificaciones nunca se
  reintenta, porque repetirlo crearía otra alerta.
- **Cortacircuitos:** tras **5 llamadas fallidas seguidas** (una llamada falla cuando agota sus reintentos: error de red, plazo,
  5xx, redirección o respuesta defectuosa; un 4xx es una respuesta, no un fallo) se deja de llamar durante **30 s** y cada
  intento recibe 503 sin salir. Pasado ese tiempo pasa una sola llamada de prueba, de un solo intento: si tiene éxito el
  circuito se cierra; si falla, se reabre. Hay un circuito por servicio destino: que ms-notificaciones esté caído no frena las
  llamadas a ms-catalogo, ni al revés.
- **El estado es por proceso.** Con 1 a 4 copias del servicio, cada una cuenta sus fallos y abre su propio circuito: no se
  comparten (no hay ningún almacén común, para no romper RNF05).
- **Plazos encadenados con el Gateway.** El Gateway espera como máximo 3 s por llamada a un servicio (`timeout_seconds` en
  `api-gateway/config/gateway.php`, que usa `ProxyService`), pero con el catálogo lento o caído este servicio puede tardar
  hasta unos 13,4 s en responder (4 intentos de 3 s más 1,4 s de esperas). El cliente puede recibir entonces un 503 **del
  Gateway** aunque la operación se confirme después aquí: la petición no se cancela cuando el Gateway deja de esperar. Al
  registrar movimientos, crear y recibir traslados y aprobar conteos hay que **reintentar con la misma `Idempotency-Key`**: si
  la operación ya se había confirmado, la repetición devuelve el resultado registrado (200) sin repetirla; si no, la ejecuta.
  `PUT /umbrales/{id_producto}` no lleva clave, pero repetirlo con el mismo cuerpo deja el mismo umbral.

## Estructura (RNF13)

`routes` → `controllers` → `services` (lógica de negocio) → `repositories` (acceso a datos). Cada operación que cambia stock
pasa por un único motor (`stockService.aplicarMovimiento`).

| Carpeta | Contenido |
| --- | --- |
| `src/routes/` | Las rutas de cada recurso; `index.js` las reúne (`rutasDeclaradas`) y exige `X-User-Id` en las escrituras. `docs.js` sirve `/docs` |
| `src/controllers/` | Leen la petición, llaman al servicio y arman la respuesta HTTP |
| `src/services/` | Reglas de negocio: el motor de stock, la idempotencia (`idempotencia.js`), traslados, conteos, la carga inicial y el registro de fallos |
| `src/repositories/` | Consultas de Knex, un archivo por recurso |
| `src/clients/` | Las llamadas a ms-catalogo y ms-notificaciones: cliente HTTP resiliente (plazo, reintentos y cortacircuitos) y un cliente por servicio |
| `src/middleware/` | `identity` (cabeceras `X-User-*`), `requestLog` (un registro JSON por petición) y `errorHandler` |
| `src/http/` | Validación de entradas, paginación y la forma de los errores |
| `src/config/` | `env.js` (variables de entorno) y `db.js` (conexión de Knex) |
| `src/domain/` | Los tipos de movimiento y su efecto sobre el saldo |
| `src/docs/` | La página de Swagger UI. El documento está en `openapi.yaml` |
| `migrations/` | Migraciones de Knex; `knexfile.js` las configura |
| `tests/` | Pruebas de Jest y Supertest, con sus ayudas en `tests/helpers/` |

Las decisiones de diseño que citan los comentarios (`D1` a `D34`, `Ruling n`) están en [`DECISIONES.md`](DECISIONES.md).

## Datos

Base propia `inventario_db` en PostgreSQL 16 (RNF02): ningún otro servicio la ve. No hay claves foráneas hacia otros servicios:
de ellos solo se guarda el identificador (`id_producto`, `id_usuario`) y el del producto se confirma llamando al catálogo.

- **Tablas:** `bodegas`, `saldos`, `lotes`, `traslados`, `conteos`, `detalles_conteo`, `movimientos` y `umbrales_producto`.
  Las cantidades son enteros (`INTEGER`, techo de 2 147 483 647) y las restricciones `CHECK` de la base impiden saldos, lotes
  o resultados negativos aunque falle el código.
- **Migraciones:** `migrations/20261103000100_esquema_inventario.js` crea el esquema y
  `migrations/20261115000100_indice_kardex_por_fecha.js` añade el índice del kardex. **Una migración ya aplicada es inmutable:**
  todo cambio de esquema va en una migración nueva con su `down`, nunca editando una existente (Knex no reaplica la que ya
  figura como aplicada, y las bases del equipo y de la CI quedarían distintas).
- **Índices que importan:** únicos sobre `bodegas.codigo` y sobre `lower(codigo)` (`MZL` y `mzl` son la misma bodega),
  `saldos (id_producto, id_bodega)`, `lotes (id_bodega, id_producto, codigo_lote)`, `movimientos.clave_idempotencia` (sostiene
  la idempotencia), `conteos.clave_aprobacion` y `detalles_conteo (id_conteo, id_producto)`; y, para el kardex,
  `movimientos (id_producto, fecha DESC)`, `movimientos (id_bodega, fecha DESC)` y `movimientos (fecha DESC, id_movimiento DESC)`.
- **Concurrencia:** el saldo es el «candado maestro»: toda operación sobre un par producto-bodega lo bloquea primero
  (`SELECT … FOR UPDATE`) y solo después los lotes, en orden FEFO; con varios saldos, por `id_bodega` y luego `id_producto`.
  El motor supone el aislamiento `READ COMMITTED` (el de PostgreSQL por defecto) y lo comprueba en el traslado sin lote.
  `movimientos.fecha` se escribe con `clock_timestamp()` después de tomar el bloqueo, y el kardex se ordena por
  `fecha DESC, id_movimiento DESC`: por producto y bodega, su orden coincide con el de los `saldo_resultante`.
- **Conexiones:** cada copia abre hasta 10 (`pool.max`) y ninguna al arrancar; con 4 copias, hasta 40.

## Variables de entorno (RNF14)

Toda la configuración viene del entorno; ninguna dirección ni credencial está en el código. Los valores de ejemplo están en
`.env.example` (se versiona solo el ejemplo; el `.env` está ignorado y nunca debe subirse).

| Variable | Obligatoria | Por defecto | Uso |
| --- | --- | --- | --- |
| `SERVICE_NAME` | No | — | Está en `.env.example`, pero el servicio no la lee: su nombre (`ms-inventario`) es fijo |
| `PORT` | No | `3000` | Puerto HTTP, entero de 1 a 65 535 (el 0 no vale: no habría un puerto conocido). En la imagen Docker ya vale 3000 |
| `LOG_LEVEL` | No | — | Está en `.env.example`, pero el servicio no la lee: escribe siempre los registros `info` y `error` |
| `DB_HOST` | Sí | — | Servidor de PostgreSQL |
| `DB_PORT` | Sí | — | Puerto de PostgreSQL |
| `DB_NAME` | Sí | — | Base de datos del servicio (`inventario_db`) |
| `DB_USER` | Sí | — | Usuario de la base |
| `DB_PASSWORD` | No para `/health`; sí para conectar | — | Contraseña del usuario (en el ejemplo, `change_me`: cámbiela) |
| `MS_CATALOGO_URL` | Sí | — | Dirección de ms-catalogo, URL `http` o `https`. En el clúster, `http://ms-catalogo:8000` |
| `MS_NOTIFICACIONES_URL` | Sí | — | Dirección de ms-notificaciones, URL `http` o `https`. En el clúster, `http://ms-notificaciones:5000` |
| `CALL_TIMEOUT_MS` | No | `3000` | Plazo máximo de cada intento de llamada a otro servicio (RNF18), entero de 1 a 60 000 milisegundos |
| `TEST_DB_NAME` | Solo para las pruebas | — | Base de datos de las pruebas (`inventario_test`): debe terminar en `_test` y ser distinta de `DB_NAME` |

- Si falta una variable obligatoria o una URL no es válida, el servicio **arranca** igual y `GET /health` responde 503
  `SERVICIO_NO_DISPONIBLE`, sin decir qué falla. El registro nombra las variables que faltan (nunca sus valores) y lo hace en
  **cada** llamada a `/health`, no solo al arrancar. `/health` es una sonda de vida: no consulta la base de datos (D17, RNF10).
  Si los manifiestos de `k8s/` la usaran como sonda de disponibilidad (*readiness*), un contenedor mal configurado quedaría
  fuera de tráfico; esa elección es de los manifiestos, no del servicio.
- Un `PORT` o un `CALL_TIMEOUT_MS` definido pero inválido (vacío, con decimales, en notación científica o hexadecimal, o fuera
  de rango) **impide arrancar**: el proceso escribe un registro `ErrorDeConfiguracion` y sale con código 1, sin pila. Si no
  están definidos, valen 3000 y 3000. `knexfile.js` lee la misma configuración: con un `PORT` inválido también falla
  `knex migrate:latest`.
- Un fallo al escuchar (puerto ocupado, `EADDRINUSE`; sin permiso, `EACCES`) recibe el mismo trato: un registro
  `No se pudo escuchar` con el puerto, el nombre y el mensaje del error, y salida con código 1.
- `NODE_ENV` no figura en `.env.example`. Jest lo fija en `test`, y con `NODE_ENV=test` el servicio usa `TEST_DB_NAME` en lugar
  de `DB_NAME`, para que ninguna prueba toque la base de desarrollo.

## Instalación y ejecución

Desde la raíz del repositorio:

```bash
cp .env.example .env                     # .env de la raíz, para docker compose; cambie las contraseñas
docker compose up -d db-ms-inventario    # PostgreSQL en 127.0.0.1:5433

cd services/ms-inventario
npm ci
cp .env.example .env                     # los valores por defecto ya apuntan a esa base
node --env-file=.env ./node_modules/.bin/knex migrate:latest   # crea las tablas en inventario_db
npm start                                # http://127.0.0.1:3000/docs
```

- Si cambia `INVENTARIO_DB_PASSWORD` o `INVENTARIO_DB_PORT` en el `.env` de la raíz, cambie también `DB_PASSWORD` o
  `DB_PORT` en el del servicio. Para usar otro puerto HTTP: `PORT=3055 npm start`.
- La migración necesita `--env-file=.env` porque `knexfile.js` lee `DB_*` del entorno y `knex` no carga el `.env`. Sin ese
  parámetro no ve las variables y falla al conectar. **Se aplica solo a la base real (`inventario_db`):** la de pruebas se
  migra sola (ver «Pruebas»). El servicio no migra al arrancar; con varias copias, migre una sola vez antes de arrancarlas.
- `npm start` lee el `.env` si existe (`--env-file-if-exists`); en un contenedor, las variables llegan por el entorno.
- Para que las llamadas al catálogo y a notificaciones funcionen en local, ms-catalogo y ms-notificaciones deben estar
  corriendo y sus `MS_*_URL` apuntar a ellos. Sin ellos el servicio arranca y lo que no los necesita funciona
  (las consultas, las bodegas, los conteos, la carga inicial, la recepción de un traslado); lo que los consulta
  (umbrales, movimientos y traslados nuevos) responde 503.
- Al recibir `SIGTERM` o `SIGINT` (Kubernetes al escalar hacia abajo) atiende las peticiones en curso, cierra las conexiones
  a la base y termina.

## Docker (RNF03)

La imagen parte de `node:22-slim` y arranca con `node src/server.js`, con un usuario sin privilegios (UID 10001). Lleva `src/`
(con la página de `/docs`), `migrations/`, `knexfile.js`, `openapi.yaml` y solo las dependencias de producción; no lleva el
`.env` (ni uno suelto en otra carpeta), las pruebas ni la cobertura (`.dockerignore`): toda la configuración llega por
variables de entorno (RNF14). Pesa unos 366 MB.

Desde la raíz del repositorio, con la base del compose levantada:

```bash
docker compose up -d db-ms-inventario
docker build -t ms-inventario services/ms-inventario
```

Dentro de la red del compose (`gestor-inventario_default`) la base se llama `db-ms-inventario` y escucha en el 5432 (no en el
5433, que es el puerto publicado en el equipo). Las migraciones no se aplican solas al arrancar: se ejecutan una vez, antes de
arrancar el servicio (con varias copias, una sola vez para todas).

Antes de ejecutar los comandos, dos datos que dependen de su equipo y que **no van escritos en ellos**:

- **El puerto del equipo.** El 3000 puede estar ocupado por otro proyecto, así que el comando no lo usa: elija un puerto libre y
  guárdelo en `PUERTO_LIBRE` (por ejemplo, `export PUERTO_LIBRE=3055`). El servicio se publica solo en `127.0.0.1`, nunca en
  todas las interfaces, porque no autentica a quien le llama (ver «Seguridad de red»); dentro del contenedor sigue en el 3000. Si
  ese puerto estuviera ocupado, `docker run` falla pero deja el contenedor creado: bórrelo con `docker rm ms-inventario` antes de
  repetir el comando con otro puerto.
- **La contraseña de la base.** No se fija en el comando: guárdela en la variable `DB_PASSWORD` del shell (la misma que
  `INVENTARIO_DB_PASSWORD` en el `.env` de la raíz) con `read -rs DB_PASSWORD && export DB_PASSWORD`, que la pide sin mostrarla
  ni dejarla en el historial, y el `-e DB_PASSWORD` sin valor la toma de ahí. Con un archivo local, fuera del repositorio, que
  defina esa variable, `--env-file <archivo>` hace lo mismo (y entonces se quita el `-e DB_PASSWORD`).

```bash
docker run --rm --network gestor-inventario_default \
  -e DB_HOST=db-ms-inventario -e DB_PORT=5432 -e DB_NAME=inventario_db -e DB_USER=inventario -e DB_PASSWORD \
  ms-inventario node_modules/.bin/knex migrate:latest

docker run -d --name ms-inventario --network gestor-inventario_default -p 127.0.0.1:$PUERTO_LIBRE:3000 \
  -e DB_HOST=db-ms-inventario -e DB_PORT=5432 -e DB_NAME=inventario_db -e DB_USER=inventario -e DB_PASSWORD \
  -e MS_CATALOGO_URL=http://ms-catalogo:8000 -e MS_NOTIFICACIONES_URL=http://ms-notificaciones:5000 \
  ms-inventario
```

El servicio queda en `http://127.0.0.1:$PUERTO_LIBRE/docs` (documentación) y en `/health` del mismo puerto.

- **`PORT` dentro del contenedor.** Con `-e PORT=3055` el servicio escucha en el 3055 en vez del 3000, y entonces es el número de
  la derecha del `-p` el que cambia (`-p 127.0.0.1:$PUERTO_LIBRE:3055`); el `HEALTHCHECK` sigue al `PORT`.
- **ms-catalogo y ms-notificaciones** todavía no están en el compose. Con esas direcciones sin servicio detrás, `/health`
  responde 200 (solo comprueba que las variables estén bien escritas) y lo que consulta al catálogo o avisa a notificaciones
  responde 503; ver «Variables de entorno».
- **`HEALTHCHECK`:** cada 30 s la imagen consulta `/health` con el propio Node (la imagen slim no trae `curl`) y marca el
  contenedor como no sano (`docker inspect -f '{{.State.Health.Status}}' ms-inventario`) si responde 503. `/health` es una sonda
  de vida: no consulta la base de datos, así que PostgreSQL caído no lo pone en `unhealthy`.
- **Apagado ordenado:** `docker stop` envía `SIGTERM` y Node es el proceso principal de la imagen: atiende las peticiones en
  curso, cierra las conexiones a la base y sale con código 0 (`docker inspect -f '{{.State.ExitCode}}' ms-inventario`).
- **Si falta `openapi.yaml` o `src/docs/swagger-ui.html`**, el servicio no arranca: se leen al construirse la aplicación. Con el
  `Dockerfile` del repositorio la falta se nota antes, porque `docker build` falla en el `COPY` («"/openapi.yaml": not found»); en
  una imagen que se construyó sin ellos, el contenedor sale con código 1 y el registro `No se pudo iniciar el servicio` con la
  ruta que falta, y el orquestador lo reiniciaría sin parar. No los excluya del `.dockerignore`: `tests/dockerfile.test.js`
  comprueba que sigan dentro de la imagen.

## Registros (RNF10)

Cada petición a las rutas de negocio deja una línea JSON con `servicio`, `nivel`, `request_id`, `metodo`, `ruta` (sin la
consulta), `estado`, `id_usuario` (de `X-User-Id`) y `duracion_ms`. El `request_id` es el `X-Request-Id` del Gateway (o del
servicio que llama), para seguir una misma operación en todos los componentes, y también lo llevan los errores y los avisos
de las llamadas salientes, que además lo propagan. `/health` y `/docs` no se registran. Los errores 5xx se registran con su
causa y se responden como `ERROR_INTERNO` genérico, sin traza ni mensaje.

## Pruebas (RNF20)

```bash
npm test                          # todas las pruebas
npm test -- tests/health.test.js  # un archivo
npm run test:cov                  # con cobertura; falla si algún porcentaje global baja del 60 %
```

Las pruebas usan **PostgreSQL de verdad** (el motor de stock bloquea saldos y hay pruebas de concurrencia), así que la base
de `docker compose up -d db-ms-inventario` debe estar arriba. Los clientes de ms-catalogo y ms-notificaciones se simulan:
no hace falta ningún otro servicio.

- **Use siempre `npm test`, nunca `jest` ni `npx jest`.** `npm test` carga el `.env` (si existe) y corre un solo proceso de
  Jest (`--runInBand`): las suites comparten una base y se truncan entre sí si corren a la vez. Jest directo no carga el
  `.env`, y la guardia del arnés (D21) se niega a ejecutar sin `TEST_DB_NAME`.
- **`TEST_DB_NAME`** (en `.env.example`, `inventario_test`) debe terminar en `_test`, ser distinta de `DB_NAME` y llevar solo
  minúsculas, dígitos y guion bajo. Si no, la guardia se niega a ejecutar: así ninguna prueba vacía la base de desarrollo ni la
  de otro proyecto.
- **`inventario_test` se crea y se migra sola** (`globalSetup`, antes de todas las suites), y se vuelve a migrar sola cuando
  hay una migración nueva. No hay que crearla ni correr `migrate:latest` para ella. Si PostgreSQL no responde, el error lo dice.
- **El rol de la base necesita `CREATEDB`:** `globalSetup` crea `inventario_test` y algunas suites crean y borran bases
  temporales `*_test`. No hace falta ser superusuario: se comprobó la suite completa con un rol `LOGIN CREATEDB`, y sin
  `CREATEDB` falla con «permission denied to create database».
- **El huso horario del equipo no importa:** la suite pasa igual con `TZ=UTC`, `America/Bogota`, `Pacific/Auckland` y
  `America/Los_Angeles`. Las pruebas que dependen del huso del proceso (el día UTC de un conteo, las fechas de vencimiento) lo
  fijan en un proceso hijo y no leen el de la máquina.
- Una corrida completa tarda de uno a tres minutos según el disco de la base de datos; con un PostgreSQL desechable sin volumen,
  unas tres veces menos. La cobertura medida al escribir este README es de más del 99 % de sentencias, funciones y líneas y del
  95 % de ramas, muy por encima del 60 % que exige RNF20.

### Integración continua

[`.github/workflows/ci-ms-inventario.yml`](../../.github/workflows/ci-ms-inventario.yml) corre en cada pull request que toque
`services/ms-inventario/` o el propio flujo. En un ejecutor limpio levanta un servicio `postgres:16` desechable, instala Node 22
y ejecuta `npm ci` y `npm run test:cov`; el paso falla si alguna prueba falla o si la cobertura global baja del 60 % en
sentencias, funciones, líneas o ramas (`coverageThreshold` de `jest.config.js`). Como la CI no tiene `.env`, el workflow da
por `env:` todas las variables del servicio y de las pruebas (con la contraseña de ejemplo, que no protege nada), y no fija
ningún huso: el ejecutor corre en UTC. `tests/ci.test.js` comprueba el workflow sin ejecutarlo, y `tests/readme.test.js` que este
README no se desfase de las rutas, las variables y los scripts.

## Límites y limitaciones conocidas

- **Tamaño del cuerpo:** 100 kB (102 400 bytes) en todas las rutas; un cuerpo mayor es 413 `PETICION_MAL_FORMADA`. Solo la
  carga inicial admite 1 MB (1 048 576 bytes). Un JSON mal formado es 400 y un charset que no sea UTF-8, 415.
- **Filas y líneas:** la carga inicial admite como máximo 1 000 filas (422 si hay más o ninguna); un conteo, como máximo
  1 000 líneas, al programarlo (`ids_producto`, o los productos con existencia de la bodega) y al registrar lo contado
  (`detalles`). Aprobar un conteo bloquea a la vez los saldos de todas sus líneas: aprobar uno de 1 000 líneas con 666 ajustes
  tardó entre 2,6 y 2,9 s en una medición local.
- **Paginación:** `por_pagina` de 1 a 100 (20 por defecto); fuera de rango, repetido o vacío es 422. La sintaxis `pagina[]=1`
  se lee como otro parámetro y se ignora. La paginación es por desplazamiento, con el conteo y la página en dos consultas sin una
  instantánea común: un movimiento confirmado entre dos páginas de un recorrido que incluya hoy puede repetir o saltar una fila.
- **Fechas por día (D29):** `fecha_desde` y `fecha_hasta` del kardex son **días UTC**: `fecha_desde` incluye desde las 00:00 UTC de
  ese día y `fecha_hasta` todo ese día UTC. No dependen del huso de la base. Un movimiento de las 22:00 en Colombia (UTC−5) ya
  es del día UTC siguiente. `fecha_desde` posterior a `fecha_hasta` es 422. La fecha de un conteo tampoco puede ser anterior al
  día UTC de hoy.
- **Mayúsculas:** el `codigo` de una bodega es único sin distinguir mayúsculas (se guarda sin espacios en los extremos), pero
  `codigo_lote` **sí las distingue**: es un texto libre del proveedor y `L1` y `l1` son dos lotes.
- **Rendimiento (mediciones locales, no garantías):** el costo de una página del kardex crece con su número. Recorrer 60 000
  movimientos de 100 en 100, sin filtros, tardó unos 15 s (29 s antes del índice `movimientos_fecha_id_idx`; cada página
  paga unos 7 ms de conteo y unos 13 ms de desplazamiento a mitad de tabla): para rangos grandes, filtre por fecha, producto
  o bodega. `GET /lotes` con 60 000 lotes tardó de 7 a 13 ms por página (no hay índice por `fecha_vencimiento`). Cargar
  1 000 filas iniciales tardó unos 5 s (unas 9 sentencias por fila): depende de la latencia a la base, así que conviene medirlo
  en el clúster.
- **`/saldos/bajo-umbral`** es solo para ADM y los servicios internos, y no aplica el alcance por bodega: devuelve totales de todas
  las bodegas. Es un arreglo plano, sin paginar.
- **Recepción de un traslado:** puede fallar y dejar el traslado `EN_TRANSITO` con la mercancía fuera de todo saldo. Los errores
  no se guardan: reintentar con la misma clave vuelve a ejecutar la recepción. Hay tres casos:
  - 409 `BODEGA_INACTIVA`, si la bodega de destino está inactiva: se resuelve reactivándola y repitiendo la recepción con la
    misma clave.
  - 422, si el saldo del destino superaría 2 147 483 647 unidades: se resuelve bajando ese saldo.
  - 409 `CONFLICTO`, si en el destino existe, o se creó después del envío, un lote con ese código y otra fecha de vencimiento.
    **Ninguna operación de la API lo resuelve**: el código y la fecha de un lote no se pueden cambiar, los lotes no se borran y
    vaciar el del destino no quita el conflicto. El traslado queda `EN_TRANSITO` y sus unidades fuera de todo saldo hasta que
    alguien intervenga directamente en la base de datos. Se evita no creando en la bodega de destino un lote con el mismo código y
    otra fecha (la creación del traslado ya rechaza el caso en que ese lote existe antes del envío).
- **Sin devolución al origen:** no hay ninguna operación para devolver un traslado `EN_TRANSITO` a su bodega de origen. Es una
  limitación conocida; la salida natural sería `POST /traslados/{id}/devolucion`, pendiente de decisión.
- **Bodega inactivada en pleno movimiento:** la comprobación de que la bodega está activa se hace sin bloquear su fila, así que
  puede inactivarse entre la comprobación y el movimiento: uno que ya empezó (por ejemplo, esperando el saldo que tiene otra
  transacción) puede completarse sobre una bodega que acaba de inactivarse. No rompe ninguna invariante de saldos: equivale a que
  el movimiento hubiera ocurrido justo antes de inactivarla. Se decidió no bloquear la bodega (`FOR SHARE`) porque podría cerrar un
  ciclo de esperas con el orden de bloqueo de los traslados (saldo y luego bodega); véase `D12` en
  [`DECISIONES.md`](DECISIONES.md).
- **Conteos:** la aprobación ajusta con la diferencia guardada al registrar lo contado, no contra el saldo del momento de
  aprobar: si hubo movimientos entre ambos, el saldo queda en el actual más la diferencia. Las líneas que nunca se contaron se
  ignoran.

## Seguridad de red

El servicio **no autentica a quien le llama**: confía en `X-User-Id`, `X-User-Rol` y `X-User-Bodega` porque el Gateway es lo
único alcanzable desde fuera del clúster (RNF09) y las repone en cada petición (D20). Quien alcance el puerto 3000 puede
hacerse pasar por cualquier usuario y rol con solo enviar esas cabeceras.

- **Lo que hace el servicio:** valida el formato de las cabeceras (una inválida es 401, nunca un 500 ni se ignora), no tiene
  usuarios propios y deja el permiso por rol al Gateway. Las rutas `/internas/*` las llaman solo otros servicios: el Gateway
  no las publica, y el servicio no las distingue de las demás.
- **Lo que no hace:** no comprueba quién envía las cabeceras ni filtra por origen (IP o token entre servicios): cualquiera que
  alcance el puerto puede llamar a `/internas/*` (la carga inicial exige `X-User-Id` y `X-User-Rol`, pero no verifica que
  vengan de ms-reportes), y `/health` y `/docs` no piden identidad.
- **Obligación de los manifiestos de `k8s/`** (todavía sin escribir): este servicio debe quedar sin exposición externa (sin
  Ingress ni NodePort; solo el Gateway se publica) y con una `NetworkPolicy` que permita entrar al puerto 3000 únicamente desde
  el Gateway y desde los servicios que lo llaman (ms-compras, ms-notificaciones y ms-reportes), y salir únicamente hacia
  ms-catalogo, ms-notificaciones, su propia base de datos y el DNS del clúster (kube-dns, puerto 53 UDP y TCP): si la política de
  salida lo olvida, no se resuelve el nombre de ms-catalogo y todo lo que lo consulta responde 503. La base de datos, a su vez,
  solo debe ser alcanzable desde este servicio (RNF02).

## Notas para los servicios que lo consumen

**ms-reportes**
- La carga inicial (`POST /internas/saldos/carga-inicial`) exige `X-User-Id` **y** `X-User-Rol`: debe reenviar los dos, o recibe
  401 y la importación queda fallida. En el momento de escribir este README, el cliente de ms-reportes envía solo
  `Idempotency-Key` y `X-Request-Id`.
- Si la petición está bien formada, responde **siempre 200** `{creados, rechazados: [{fila, motivo}]}` (`fila` empieza en 1),
  aunque todas las filas se rechacen. Sin `Idempotency-Key` es 400; sin identidad, 401; por encima de 1 MB, 413. El `motivo` es
  un texto libre en español que puede cambiar: no debe interpretarse por programa. La carga no consulta ms-catalogo ni evalúa
  umbrales.
- Debe trocear las importaciones en lotes de **1 000 filas como máximo**: con más, o con ninguna, 422 y la importación fallida
  (un 4xx no se reintenta).
- 1 000 filas tardan unos 5 s en local, más que los 3 s que ms-reportes espera por intento: conviene darle a esa llamada un
  plazo mayor o proporcional a las filas. Mientras tanto converge con reintentos con la misma `Idempotency-Key`, sin duplicar
  nada.
- Genera un `uuid4` nuevo por importación: si vuelve a subir un archivo que ya se aplicó (por ejemplo, tras una importación
  marcada como fallida que sí se aplicó), la clave nueva suma otra vez las mismas filas y **duplica los saldos**.
- `GET /bodegas` pagina: con `?pagina=1&por_pagina=100` llega solo la primera página; si hay más de 100 bodegas debe seguir
  hasta `pagina * por_pagina >= meta.total`, como hace con los demás listados. En el momento de escribir este README, su
  cliente lee solo la primera página.
- Los listados llevan `meta.total` exacto y los recorre pidiendo `por_pagina=100`; para el kardex, filtrar por fecha.

**ms-compras**
- Registra sus entradas y devoluciones con `POST /movimientos` (`ENTRADA_COMPRA` y `DEVOLUCION_PROVEEDOR`), **un movimiento por
  cada línea** de la recepción o de la devolución. Cada línea necesita **su propia `Idempotency-Key`**, derivada de forma
  determinista de la recepción y de la posición de la línea (por ejemplo `rec-<id_recepcion>-<n>`: `rec-77-1`, `rec-77-2`…; sin
  `#` y de 200 caracteres como máximo), y debe reenviar **siempre el `X-User-Id` original**: con otro usuario, la clave no se
  reconoce como repetición y se duplicaría el movimiento.
- **No use una sola clave para toda la recepción.** Una repetición no mira el cuerpo: con la clave `recepcion-77` en tres líneas,
  la primera da 201 y las otras dos dan 200 con el movimiento de la primera. Esas dos líneas **no se registran y no hay ningún
  error**.
- Distinga el 201 (movimiento nuevo) del 200 (repetición). Un 200 cuyo `id_producto` o `cantidad` no son los de la línea enviada
  significa que la clave ya se usó para otra línea: debe tratarlo como un error propio, no como un éxito.
- Las líneas **no son atómicas entre sí**: cada una es su propia petición. Si la tercera falla con 409 (por ejemplo
  `STOCK_INSUFICIENTE` en una devolución), la primera y la segunda ya están aplicadas. Se reintenta la recepción completa con las
  **mismas claves**: las líneas ya aplicadas responden 200 y solo se ejecutan las pendientes.
- Además de los códigos de la Tabla 9, `POST /movimientos` puede responder 404 `NO_EXISTE` si el `id_lote` es de otra bodega o
  producto, y 409 `CONFLICTO` si el lote ya existe con otra `fecha_vencimiento`; con `lote`, `codigo_lote` y
  `fecha_vencimiento` son obligatorios.

**ms-notificaciones**
- `GET /lotes?vence_antes_de=<fecha>&con_existencia=true`, paginado (`pagina`, `por_pagina`, hasta 100): `vence_antes_de` es
  estricto (un lote que vence ese día no entra) y los lotes sin fecha nunca entran. Los parámetros que el servicio no conoce se
  ignoran.
- `GET /saldos/bajo-umbral`, sin paginar.
- Recibe de este servicio `POST /internas/notificaciones` (`STOCK_BAJO`, con `id_producto` e `id_bodega`) **tras cada movimiento
  mientras el total del producto siga por debajo del mínimo** (`D13`): también tras una `ENTRADA` que sube el stock sin alcanzar
  el mínimo y tras cada `AJUSTE` de la aprobación de un conteo. No avisa tras un traslado ni en la carga inicial, ni en la
  repetición (200) de un movimiento. El aviso se envía sin reintentos y sin esperar respuesta, así que puede perderse. **Debe
  deduplicar** (por ejemplo, por `id_producto` e `id_bodega` mientras la alerta siga abierta): este servicio no recuerda qué avisó
  antes.

## Pendiente

- Manifiestos de Kubernetes, incluida la `NetworkPolicy`.
