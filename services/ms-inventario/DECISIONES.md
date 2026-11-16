# Decisiones de diseño de ms-inventario

Los comentarios del código, las migraciones, el README y el OpenAPI de este servicio citan decisiones por su identificador
(`D27`, `D31(f)`, `Ruling 21`). Este libro las define. Hay dos clases:

- **`D1` a `D34`:** decisiones de diseño sobre lo que el contrato de la Entrega 2 no cubre o deja abierto. Las que tienen letra
  (`D25b`) refinan a otra; las que tienen apartados (`D27(c)`) los numeran con letras.
- **`Ruling n`:** decisiones puntuales de implementación (cómo se escribe o se comporta una pieza concreta) que el código cita y que
  conviene poder consultar.

Cada entrada dice qué se decidió, por qué y qué requerimiento atiende (RF y RNF son los de la Entrega 1). Describe lo que el
servicio hace hoy: si una entrada y el código discrepan, manda el código y la entrada está desactualizada. Una prueba
(`tests/decisiones.test.js`) exige que toda decisión citada en `src/`, `migrations/`, el README y `openapi.yaml` tenga su entrada
aquí. Las tablas y los números de página que se nombran (Tabla 9, Figura 5) son los de la Entrega 2.

## D1. Los lotes llevan `id_producto`

La Figura 5 no dibuja `id_producto` en `Lote`, pero `GET /lotes?id_producto` y la sugerencia de salida por FEFO lo necesitan, y
ms-notificaciones lo exige para sus alertas de vencimiento. `GET /lotes` devuelve `id_lote`, `id_producto`, `id_bodega`,
`codigo_lote`, `fecha_vencimiento` y `cantidad_disponible`. Es un campo aditivo respecto al modelo (RF17).

## D2. Las cantidades son enteros

Los productos son empacados, así que toda cantidad (`cantidad`, `cantidad_disponible`, `cantidad_minima`…) es un entero y la
columna es `INTEGER` de PostgreSQL (máximo 2 147 483 647). Un decimal, un texto o un valor por encima del máximo es 422
`DATOS_NO_VALIDOS`. El máximo se comprueba en el servicio para que la base no lance un 22003 que acabaría en un 500; un saldo
resultante que lo superaría también es 422 sobre `cantidad`.

## D3. El tipo del movimiento decide el signo

Solo `AJUSTE` lleva la `cantidad` con signo (entero distinto de 0); en los demás tipos es un entero positivo y el tipo pone el
signo. Suman `ENTRADA`, `DEVOLUCION_CLIENTE`, `ENTRADA_COMPRA`, `TRASLADO_ENTRADA` y `CARGA_INICIAL`; restan `SALIDA`,
`DEVOLUCION_PROVEEDOR` y `TRASLADO_SALIDA`. La regla vive en un solo módulo (`src/domain/tipos.js`) y la base la refuerza con
`CHECK`: `cantidad` nunca es 0 y solo `AJUSTE` puede ser negativa, para que un fallo del motor no pueda dejar un kardex
inconsistente (RF04, RF10).

## D4. Tipos que `POST /movimientos` no acepta

`TRASLADO_SALIDA`, `TRASLADO_ENTRADA` y `CARGA_INICIAL` son 403 por esa ruta: los crean `POST /traslados`, su recepción y la carga
inicial. En cambio `ENTRADA_COMPRA` y `DEVOLUCION_PROVEEDOR` se aceptan de cualquier llamador, porque ms-compras usa la misma
ruta con las mismas cabeceras que un usuario y no se puede distinguir de uno. El 403 de un tipo reservado se decide antes de
mirar el resto del cuerpo.

## D5. Claves derivadas cuando una operación genera varios movimientos

Una operación que genera varios movimientos deriva una clave por movimiento, `<clave>#<sufijo>`: la aprobación de un conteo usa el
`id_producto` de cada línea, la carga inicial la posición `n` de cada fila y un traslado `salida` y `entrada` (D25d). Así cada
movimiento tiene su propia clave única y la operación entera se puede repetir (RNF17). `conteos.clave_aprobacion` (única, anulable
e invisible en la API) guarda la clave base de la aprobación para reconocer una repetición incluso cuando no hubo diferencias y,
por tanto, ningún movimiento. El formato completo de lo que se guarda es el de D25, D25b, D25c y D25d.

## D6. Una salida sin lote consume por FEFO

Una salida (o cualquier movimiento que baje el saldo, salvo el traslado, D28(a)) sin `id_lote` consume los lotes del par por FEFO
hasta agotarlos, y lo que sobra sale del stock sin lote. Registra un solo movimiento cuyo `id_lote` es el primer lote consumido
(o `null`). El orden FEFO es total: fecha de vencimiento ascendente, los lotes sin fecha al final y, a igual fecha, el `id_lote`
más bajo. Atiende RF17 (sacar primero lo que vence primero) sin obligar al cliente a elegir lote.

## D7. Una clave repetida devuelve el resultado original

Con la misma `Idempotency-Key` del mismo usuario y la misma operación, el servicio devuelve el resultado ya registrado (200) aunque
el cuerpo sea otro: no lo valida, no comprueba permisos ni llama al catálogo, así que un reintento tras un éxito da 200 incluso con
ms-catalogo caído (RNF17). Consecuencia que debe conocer quien llama: **una clave identifica un solo movimiento**; una operación
de varias líneas necesita una clave por línea. Una operación que la exige y no la recibe es 400. Dos operaciones lo matizan: repetir
la creación de un traslado devuelve el traslado en su estado actual (D31(c)) y en la carga inicial solo las filas ya aplicadas se
reconocen, las demás se procesan con el cuerpo nuevo (D34(a)).

## D8. Las lecturas internas no exigen usuario; las escrituras, sí

Las lecturas (`GET`) sin `X-User-Id` son válidas: son las llamadas internas de ms-reportes y ms-notificaciones en tareas
programadas, que no actúan en nombre de ningún usuario. Toda escritura (`POST`, `PUT`) exige `X-User-Id` (401 si falta) porque cada
cambio guarda su autor (RF10); se aplica en un solo sitio (`src/routes/index.js`), para que una ruta nueva no pueda olvidarlo.
Un `X-User-Rol` inválido es 401. Véanse D20 y D22.

## D9. Vocabulario de errores

Los errores son `{"error": {"codigo", "mensaje", "detalles"}}` con los códigos comunes a todos los servicios: `PETICION_MAL_FORMADA`
(400), `NO_AUTENTICADO` (401), `SIN_PERMISO` (403), `NO_EXISTE` (404), `CONFLICTO` (409), `DATOS_NO_VALIDOS` (422),
`SERVICIO_NO_DISPONIBLE` (503) y `ERROR_INTERNO` (500). Los propios de este servicio, todos 409, son `STOCK_INSUFICIENTE` y
`CODIGO_DUPLICADO` (los nombra el contrato), `BODEGA_INACTIVA`, `TRASLADO_YA_RECIBIDO` y `CONTEO_ESTADO_INVALIDO`. `CONFLICTO` se usa
para un lote que ya existe con otra fecha de vencimiento y para una clave de idempotencia que ya se usó en otro recurso.
`STOCK_INSUFICIENTE` añade `disponible` y `solicitado` a su detalle.

## D10. `GET /saldos` informa el total del producto

`GET /saldos?id_producto=` añade `meta.cantidad_total`: la suma de las filas del filtro efectivo (todas las bodegas, o la del
operador de bodega o la pedida). Sin `id_producto` no aparece. Es un cambio aditivo que evita al cliente sumar las páginas (RF05,
RF09).

## D11. Un conteo mide contra el saldo del momento de contar

En un conteo, `cantidad_sistema` se refresca con el saldo actual al registrar las cantidades contadas (`PUT /conteos/{id}/detalles`),
y la diferencia es `cantidad_contada − cantidad_sistema` de ese instante. Si se omite `ids_producto` al programar, las líneas son
todos los productos con saldo en la bodega. Qué se ajusta al aprobar está en D32(a).

## D12. Una bodega inactiva rechaza movimientos, traslados y conteos

Con la bodega inactiva, un movimiento, un traslado (origen o destino), un conteo nuevo y la aprobación de un conteo (aun sin
diferencias) responden 409 `BODEGA_INACTIVA`. Inactivar una bodega no comprueba stock ni mercancía en tránsito.

La comprobación se hace sin bloquear la fila de la bodega, así que una bodega puede inactivarse entre la comprobación y el
movimiento: uno que ya empezó puede completarse sobre una bodega que acaba de inactivarse. Es equivalente al orden «movimiento, luego
inactivar» y no rompe ninguna invariante de saldos. Se decidió no tomar `FOR SHARE` sobre la bodega: los traslados toman el saldo y
después consultan la bodega, y un movimiento que tomara la bodega y después el saldo cruzaría ese orden de bloqueo; con una
inactivación esperando entre ambos se podría cerrar un ciclo de esperas (interbloqueo). Es un riesgo deducido del orden de
bloqueo (D27(c), D31(d)), no reproducido. Si algún día se quiere cerrar la ventana, la salida es releer la bodega después de
bloquear el saldo, sin tocar el orden de bloqueos.

## D13. Aviso de stock bajo

El umbral se evalúa después de confirmar cada movimiento, incluidos los `AJUSTE` que genera la aprobación de un conteo, y no tras
`TRASLADO_SALIDA`, `TRASLADO_ENTRADA` (la mercancía en tránsito no es una baja real) ni `CARGA_INICIAL` (solo suma). Se avisa a
ms-notificaciones si el total de todas las bodegas es estrictamente menor que `cantidad_minima` (un mínimo de 0 nunca avisa). El
aviso va después del commit, con la conexión normal, sin esperar respuesta y sin reintentos; si falla solo se anota en el registro:
un fallo de notificaciones nunca impide registrar un movimiento (RF09, RNF18, llamada 3 de la Tabla 2 de la Entrega 2).
Consecuencia: **se avisa en cada movimiento mientras el total siga bajo el mínimo**, también en una `ENTRADA` que sube el stock
sin alcanzarlo, y una repetición (200) no vuelve a avisar. Por eso ms-notificaciones debe deduplicar.

## D14. Paginación

`pagina` ≥ 1 y `por_pagina` entre 1 y 100 (por defecto 1 y 20); un valor fuera de rango, repetido o que no sea un entero es 422
`DATOS_NO_VALIDOS`. Es la convención común de los listados de todos los servicios.

## D15. Qué cuenta como fallo del cortacircuitos

Una llamada a otro servicio cuenta como un fallo solo cuando falla después de agotar sus reintentos (error de red, plazo, 5xx,
redirección o respuesta defectuosa); un 4xx es una respuesta, no un fallo. Cinco fallos seguidos abren el circuito 30 s (RNF18). El
estado es por proceso y por servicio destino: no se comparte entre copias, para no romper RNF05.

## D16. La sugerencia de salida usa solo lotes

`GET /lotes/sugerencia-salida` asigna únicamente desde lotes, con la misma regla pura que aplica el motor al sacar sin `id_lote`.
Si los lotes no alcanzan es 409 `STOCK_INSUFICIENTE` (con `disponible` igual a lo que suman los lotes), aunque el saldo sí alcance
con stock sin lote: la salida real sí lo sacaría, pero no hay un lote que sugerir para ese resto. Es una consulta: no reserva ni
bloquea nada (RF17).

## D17. `/health` valida la configuración, no la base de datos

`GET /health` responde 200 `{estado: "ok", servicio: "ms-inventario"}` solo si están definidas las variables obligatorias (`DB_HOST`,
`DB_PORT`, `DB_NAME`, `DB_USER`, `MS_CATALOGO_URL`, `MS_NOTIFICACIONES_URL`) y las dos URL son http(s) válidas; si no, 503
`SERVICIO_NO_DISPONIBLE` genérico, y el registro dice los nombres de lo que falla (nunca los valores). Se evalúa en cada llamada,
con la misma convención que el Gateway. No consulta la base: es una sonda de vida y una caída de PostgreSQL no debe reiniciar el
pod (RNF10).

## D18. Errores de Express y del analizador de JSON

Todo error 4xx que generen Express o `express.json()` (JSON mal formado 400, cuerpo mayor de 100 kB 413, charset no soportado 415)
conserva su estado y responde `PETICION_MAL_FORMADA` con un mensaje fijo (el del analizador cita trozos del cuerpo). Todo 5xx
responde 500 `ERROR_INTERNO` genérico, sin traza ni mensaje aunque `NODE_ENV` no sea `production`, y se registra con su
`request_id`. Una ruta inexistente es 404 `NO_EXISTE`. Es la misma convención del Gateway.

## D19. El `request_id` vive en un `AsyncLocalStorage`

El identificador de la petición se guarda en un `AsyncLocalStorage` y el logger lo añade a toda línea que emita durante ella,
también las de error 5xx y las advertencias de los clientes de otros servicios. Una variable de módulo mezclaría los
identificadores de peticiones concurrentes (RNF05), y sin él faltaba el `request_id` justo en las líneas de error (RNF10).

## D20. Las cabeceras de identidad inválidas son 401

Un `X-User-Id` que no sea un entero positivo, un `X-User-Bodega` que no lo sea cuando viene o un `X-User-Rol` que no sea uno de los
cuatro roles es 401 `NO_AUTENTICADO`: nunca se ignora en silencio ni llega a la base como un 500. `X-User-Id` sin `X-User-Rol`
también es 401 (Ruling 10). El servicio confía en `X-User-*` solo porque el Gateway es lo único alcanzable desde fuera (RNF09);
en Kubernetes hay que restringirlo con una `NetworkPolicy`, como dice la sección «Seguridad de red» del README.

## D21. Entorno de pruebas

Las pruebas usan PostgreSQL de verdad (el del equipo o el contenedor del compose) y su propia base `inventario_test`
(`TEST_DB_NAME`), que `globalSetup` crea y migra. El arnés se niega a ejecutarse si el nombre no termina en `_test`, coincide con
`DB_NAME` o lleva caracteres fuera de minúsculas, dígitos y guion bajo; y `truncateAll` no vacía una base que no termine en `_test`.
Con `NODE_ENV=test` el servicio usa `TEST_DB_NAME`. Así ninguna prueba toca una base de desarrollo ni de otro proyecto (RNF20).

## D22. `X-User-Id` es obligatorio también en la carga inicial

Decisión del 15 de noviembre de 2026: `X-User-Id` sigue siendo obligatorio en toda escritura, también en
`POST /internas/saldos/carga-inicial`, porque cada movimiento guarda su autor (RF10); no se crea un «usuario de sistema». ms-reportes
llama hoy a esa ruta con `Idempotency-Key` y `X-Request-Id` pero sin `X-User-Id` ni `X-User-Rol`, así que la importación de
`STOCK_INICIAL` recibe 401 y queda fallida hasta que su cliente los reenvíe.

## D23. El contrato que ya consume ms-reportes

ms-reportes recorre los listados con `por_pagina=100` y se detiene cuando `pagina * por_pagina >= meta.total`, así que `meta.total`
es obligatorio y exacto. Espera `GET /bodegas` como `{datos, meta}`; `GET /saldos` con `id_producto`, `id_bodega` y
`cantidad_disponible`; `GET /saldos/bajo-umbral` como arreglo plano `[{id_producto, cantidad_total, cantidad_minima}]`;
`GET /movimientos` del más reciente al más antiguo (D24) con `fecha`, `tipo`, `id_producto`, `id_bodega` y `cantidad`;
`GET /lotes?vence_antes_de=<fecha>&con_existencia=true` ordenado por vencimiento; y que la carga inicial responda 200 (nunca 201)
`{creados, rechazados: [{fila, motivo}]}`. Su cliente trata cualquier respuesta distinta de 200 como servicio no disponible y
reintenta los 5xx de las lecturas y de la carga: un 404 o un 422 inesperado en una lectura rompe un reporte. Sus lecturas no
llevan `X-User-Id` (D8). Valida `cantidad` como un número positivo que admite decimales: una fila con decimales vuelve en
`rechazados` (D2).

## D24. La fecha de un movimiento es el instante de la escritura

`now()` es el inicio de la transacción, no el instante de la escritura: una transacción que empezó antes pero obtuvo el bloqueo del
saldo después tendría una `fecha` anterior a la de otro movimiento ya confirmado, y el kardex mostraría los `saldo_resultante`
desordenados. Por eso `movimientos.fecha`, `saldos.fecha_actualizacion`, `traslados.fecha_envio`, `traslados.fecha_recepcion` y
`conteos.fecha_aprobacion` se escriben con `clock_timestamp()` después de tomar el bloqueo, y el kardex se ordena por
`fecha DESC, id_movimiento DESC` (el id de serie se asigna al insertar, con el bloqueo tomado). Así, por (producto, bodega), el
orden del kardex coincide con el de los `saldo_resultante` (RF10). Las escrituras de una sola sentencia, como el UPSERT de umbrales,
siguen usando `now()`.

## D25. La `Idempotency-Key` se acota por usuario

La clave guardada en `movimientos.clave_idempotencia` lleva el `id_usuario` por delante (el formato completo es el de D25b). Con
una clave global, dos usuarios que usaran la misma (por ejemplo `k1`) harían que el segundo recibiera el movimiento del primero con
un 200 y su operación no se registrara, además de filtrar datos ajenos. Una repetición del mismo usuario sigue devolviendo el
original (D7). La cabecera, sin espacios en los extremos, tiene de 1 a 200 caracteres (400 `PETICION_MAL_FORMADA` si falta, está
vacía o es más larga) para que la clave guardada quepa en `varchar(255)`. Los errores no se guardan: un 409 o un 422 no deja clave y
el reintento con la misma clave se ejecuta de nuevo. La repetición se detecta por el nombre de la restricción
`movimientos_clave_idempotencia_key` (RNF17).

## D25b. La clave también se acota por operación

La clave guardada es `<id_usuario>:<operacion>:<clave>`, con `operacion` igual a `mov` (`POST /movimientos`, incluidas las llamadas
de ms-compras), `tras` (traslados), `con` (aprobación de conteos) o `ini` (carga inicial). Sin esto, un mismo usuario que reutilizara
una clave entre un movimiento y un traslado recibiría el movimiento equivocado con un 200 y su operación no se ejecutaría: el mismo
fallo silencioso que D25 evita entre usuarios. Las claves derivadas añaden `#<sufijo>` al final de la ya armada. El peor caso mide
10 + 1 + 4 + 1 + 200 + 1 + 10 = 227 caracteres, que caben en 255. Una sola función, `claveAlmacenada`, y otra, `derivada`, en
`src/services/idempotencia.js` son la fuente de verdad; una operación desconocida es un error de programación. Quien llama (por
ejemplo ms-compras) debe derivar sus claves de forma determinista y reenviar siempre el mismo `X-User-Id`: con otro usuario la
clave no se reconoce como repetición.

## D25c. La cabecera no puede llevar `#`

Las claves derivadas son `<clave guardada>#<n>`; si el usuario pudiera enviar `abc#1`, chocaría con la derivada 1 de `abc` dentro
de la misma operación. Por eso `#` en la cabecera es 400 `PETICION_MAL_FORMADA`, y las derivadas se construyen solo con
`derivada(...)`: nadie concatena a mano. Tras un fallo, `resolverFallo` relee la clave y devuelve el movimiento original si otra
petición idéntica lo confirmó entre medias; lo usan los movimientos y los traslados, mientras que la aprobación de un conteo relee
por `clave_aprobacion` (D32(d)) y la carga inicial relee directamente por la clave de cada fila (Ruling 61). Cuando una operación toma
varios saldos, se bloquean por `id_bodega` ascendente y, dentro de la misma bodega, por `id_producto` ascendente, para que dos
operaciones que comparten productos no se interbloqueen.

## D25d. Sufijos fijos de las claves derivadas

Los sufijos son constantes de `src/services/idempotencia.js`, para que ninguna operación invente los suyos: un traslado lleva
`derivada(base, 'salida')` en el movimiento `TRASLADO_SALIDA` y `derivada(base, 'entrada')` en `TRASLADO_ENTRADA` (la repetición de
`POST /traslados` se detecta releyendo la de salida); la aprobación de un conteo, el `id_producto` de cada línea; la carga inicial,
la posición `n` de cada fila desde 1. `base` es siempre `claveAlmacenada(idUsuario, operación, clave)`, y esa función rechaza una
clave con `#` como defensa para quien la llame sin pasar por la cabecera.

## D26. Límite entre los movimientos y los lotes, y tope del saldo

La primera versión de `POST /movimientos` rechazaba con 422 un cuerpo con `id_lote` o `lote` (ignorarlos en silencio habría dejado
un movimiento que no toca los lotes mientras el cliente cree que sí). Ese rechazo quedó superado por D27: hoy ambos campos se
aceptan y mueven los lotes. Sigue vigente que el motor de stock (`aplicarMovimiento`) recibe también `idTraslado` e `idConteo`
(columnas que guardan los traslados y los conteos) y que un saldo que superaría 2 147 483 647 es 422 sobre `cantidad`, nunca un 500
por el 22003 de la base.

## D27. Reglas de lotes en el motor de stock

Las reglas se aplican por el signo del cambio y no por el tipo, así que los traslados, los conteos, las devoluciones y la carga
inicial las heredan sin reglas propias (RF17).

- **(a)** Si el movimiento sube el saldo: sin `id_lote` ni `lote`, solo cambia el saldo (el stock queda «sin lote»); con `id_lote`,
  suma a ese lote (404 `NO_EXISTE` si no es de la misma bodega y producto); con `lote {codigo_lote, fecha_vencimiento}`, lo crea o
  suma al existente en una sola sentencia atómica. `id_lote` y `lote` a la vez es 422.
- **(b)** Si baja el saldo (`SALIDA`, `DEVOLUCION_PROVEEDOR`, `AJUSTE` negativo, `TRASLADO_SALIDA`): con `id_lote` resta de ese lote
  (404 si no es de ese par; 409 `STOCK_INSUFICIENTE` si el lote no alcanza aunque el saldo sí); sin `id_lote`, FEFO (D6) y el resto
  sale del stock sin lote; con `lote`, 422, porque al retirar no se crea un lote. El movimiento lleva el primer lote consumido.
- **(c)** Invariante: por (producto, bodega), la suma de `lotes.cantidad_disponible` nunca supera `saldos.cantidad_disponible` y
  ningún lote queda negativo. El saldo es el «candado maestro»: toda operación sobre un par bloquea primero su saldo y solo después
  sus lotes, en orden FEFO, así que no hay interbloqueo entre operaciones del mismo par.
- **(d)** Mismo código con otra fecha: si el lote ya existe y la petición trae una `fecha_vencimiento` distinta de la guardada
  (incluida una guardada nula), es 409 `CONFLICTO`; si no la trae, se suma sin tocar la fecha. Sin esto, una fecha ignorada en
  silencio podría sacar mercancía vencida antes de tiempo por FEFO.
- **(e)** `fecha_vencimiento` es una fecha real `YYYY-MM-DD` (`2027-02-30` es 422) y se acepta una fecha pasada, porque el contrato
  no la prohíbe. Las columnas `date` se leen como texto, nunca como `Date` (Ruling 15).

## D28. Traslados y lotes; obligatoriedad de la fecha

Enmienda de D27 para los traslados y para el cuerpo de `POST /movimientos`.

- **(a)** Un traslado nunca hace FEFO. El modelo dice que mueve cero o un lote (`traslados.id_lote` es único y anulable), así que
  repartirlo entre varios no se puede representar y la recepción no sabría qué recrear en el destino. `TRASLADO_SALIDA` con
  `id_lote` resta de ese lote; sin `id_lote` mueve solo stock sin lote (el saldo menos la suma de los lotes del par, calculada con el
  saldo bloqueado) y, si no alcanza, es 409 `STOCK_INSUFICIENTE` con un mensaje que pide indicar `id_lote`. La recepción recrea en
  el destino el lote del traslado con su código y su fecha (o entra sin lote). Al crear el traslado se comprueba, antes de sacar
  nada del origen, que el destino no tenga ya ese código con otra fecha (409 `CONFLICTO`), para que la recepción no falle después
  con la mercancía en tránsito.
- **(b)** `lote.fecha_vencimiento` es obligatoria en `POST /movimientos` cuando viene `lote` (422 si falta o es `null`): en el
  contrato solo el objeto `lote` es opcional y el contrato manda sobre D27(e). El motor sí admite la fecha nula, porque la carga
  inicial la deja opcional; por eso el camino «sin fecha» de D27(d) solo se alcanza desde ella.
- **(c)** `codigo_lote` distingue mayúsculas, a diferencia del código de las bodegas (Ruling 18): es un texto libre del proveedor y
  ningún consumidor lo pliega. Tampoco normaliza Unicode ni quita caracteres invisibles: `café` en NFC y en NFD son dos lotes.
- **(d)** Para ms-compras, que usa `POST /movimientos`, esto añade dos respuestas posibles: 404 `NO_EXISTE` por un `id_lote` de otra
  bodega o producto y 409 `CONFLICTO` por una `fecha_vencimiento` distinta de la del lote existente.

## D29. `fecha_desde` y `fecha_hasta` son días UTC

Los filtros de fecha del kardex son días UTC: `fecha_desde` incluye desde las 00:00:00 UTC de ese día y `fecha_hasta` incluye todo ese
día UTC (`fecha` menor que las 00:00 UTC del día siguiente). ms-reportes reenvía fechas `YYYY-MM-DD` sin huso, todos los servicios
usan UTC y la API devuelve instantes ISO 8601 en UTC. Limitación conocida: un movimiento de las 22:00 en Colombia (UTC−5) cae en el
día UTC siguiente. La comparación usa límites UTC explícitos y no depende del huso de la sesión de PostgreSQL. `fecha_desde`
posterior a `fecha_hasta` es 422 (RF15).

## D30. Las migraciones aplicadas son inmutables

Todo cambio de esquema va en una migración nueva con su propio `down`, nunca editando una ya aplicada: las bases de los demás
integrantes y de la CI la tienen aplicada y Knex no la reaplica. Las pruebas de migración toleran varias migraciones. El índice del
kardex por fecha es un ejemplo: es una migración propia (`20261115000100_indice_kardex_por_fecha.js`).

## D31. Traslados

Un traslado cambia stock en dos pasos, cada uno con su transacción y su clave, y entre ambos la mercancía está en tránsito (RF04,
RNF17).

- **(a)** Claves: la creación usa `base = claveAlmacenada(idUsuario, 'tras', clave)` y su movimiento `TRASLADO_SALIDA` lleva
  `derivada(base, 'salida')`; la recepción usa su propia `base` (la cabecera de esa petición) y `TRASLADO_ENTRADA` lleva
  `derivada(base, 'entrada')`. La repetición de la creación se detecta releyendo la clave de salida; la de la recepción, la de
  entrada. Por eso crear y recibir con la misma clave literal son operaciones distintas.
- **(b)** Misma clave sobre otro recurso: si en una recepción la clave de entrada ya existe pero su movimiento es de otro traslado,
  es 409 `CONFLICTO`: devolver la recepción de otro traslado sería un error silencioso.
- **(c)** La repetición devuelve el traslado en su estado actual más el movimiento original (repetir una creación ya recibida da 200
  con `estado: RECIBIDO`).
- **(d)** Una sola recepción: la recepción bloquea la fila del traslado antes de comprobar el estado. Con dos recepciones simultáneas
  y claves distintas, una gana y la otra es 409 `TRASLADO_YA_RECIBIDO`; con la misma clave, la perdedora relee por clave y responde
  200. Orden de bloqueo de la recepción: traslado, saldo del destino, lote del destino; el de la creación: saldo del origen y
  después, si hay, el lote. Ninguna operación toma dos saldos, así que no hay ciclo entre un traslado A→B y otro B→A.
- **(e)** Conservación: para un producto, la suma de los saldos más la de las cantidades de los traslados `EN_TRANSITO` es constante
  a lo largo de crear y recibir. Por eso el traslado y su movimiento se escriben siempre en la misma transacción.
- **(f)** La recepción puede fallar y dejar el traslado `EN_TRANSITO`, con la mercancía fuera de todo saldo. Con el destino inactivo
  (409 `BODEGA_INACTIVA`) se resuelve reactivando la bodega y repitiendo con la misma clave. Con 422 por desborde del saldo del
  destino, bajando ese saldo. Pero si el destino creó después del envío un lote con el mismo código y otra fecha (409 `CONFLICTO`),
  **ninguna operación de la API lo resuelve**: el código y la fecha de un lote son inmutables y los lotes no se borran, ni siquiera
  vaciarlo quita el conflicto; las unidades siguen en tránsito hasta intervenir en la base de datos. Se evita no creando en el
  destino un lote con el mismo código y otra fecha. La salida natural sería `POST /traslados/{id}/devolucion`, pendiente de decisión.
- **(g)** Alcance: crear exige alcance sobre la bodega de origen (403 si es ajena) y recibir sobre la de destino; el operador lista
  los traslados cuyo origen o destino es su bodega.

## D32. Conteos físicos

Un conteo pasa por PROGRAMADO, EN_REVISION y APROBADO, y solo la aprobación cambia saldos (RF18).

- **(a)** Se ajusta con la diferencia guardada al contar, no contra el saldo actual: `PUT …/detalles` refresca `cantidad_sistema`
  (D11) y fija `diferencia = cantidad_contada − cantidad_sistema`, y la aprobación aplica un `AJUSTE` de esa diferencia por línea. Si
  hubo movimientos entre el conteo y la aprobación, el resultado es el saldo actual más la diferencia (el recuento es una foto del
  momento de contar y las ventas posteriores son reales). Si un ajuste negativo dejara un saldo negativo, es 409
  `STOCK_INSUFICIENTE`, el conteo sigue EN_REVISION y no se aplica ningún ajuste.
- **(b)** Líneas: solo cuentan al aprobar las que tienen `cantidad_contada` registrada y diferencia distinta de 0; las que nunca se
  contaron se ignoran. `PUT` puede enviar solo algunas líneas y repetirse mientras el conteo no esté APROBADO (vuelve a refrescar
  `cantidad_sistema` de las enviadas). `cantidad_contada` es un entero ≥ 0 dentro del `INTEGER`; un `id_producto` repetido o ajeno al
  conteo es 422 sobre su posición.
- **(c)** Estados: `PUT` sobre un conteo APROBADO y aprobar uno que no está EN_REVISION son 409 `CONTEO_ESTADO_INVALIDO`.
- **(d)** Idempotencia de la aprobación: `base = claveAlmacenada(idUsuario, 'con', clave)`; `conteos.clave_aprobacion` guarda la
  base y cada `AJUSTE` lleva `derivada(base, id_producto)`. La repetición se detecta releyendo `clave_aprobacion`, también cuando no
  hubo diferencias: si la clave es de este conteo, 200 con el conteo APROBADO y sus movimientos originales, sin nuevos ajustes ni
  nueva evaluación del umbral; si es de otro conteo, 409 `CONFLICTO` (el mismo criterio que D31(b)). La aprobación bloquea la fila
  del conteo antes de comprobar el estado: con dos aprobaciones simultáneas y claves distintas, una gana y la otra es 409
  `CONTEO_ESTADO_INVALIDO`; con la misma clave, la perdedora relee y responde 200.
- **(e)** Orden de bloqueo: fila del conteo, saldos de las líneas por `id_producto` ascendente (la bodega es única) y después los
  lotes (D25c).
- **(f)** Líneas por omisión: sin `ids_producto`, los productos con `cantidad_disponible > 0` en esa bodega; con `ids_producto`
  explícito, cualquiera (con `cantidad_sistema` 0 si no tiene saldo). Una lista vacía, con repetidos o que no deje ninguna línea es 422.
- **(g)** `fecha_programada` es una fecha real que no puede ser anterior al día UTC de hoy (D29); «hoy» se acepta. La comparación usa
  un reloj inyectable para que las pruebas no dependan del día real.
- **(h)** Alcance: programar y aprobar son de ADMINISTRADOR y lo aplica el Gateway; registrar lo contado y las lecturas aplican el
  alcance sobre la bodega del conteo (un operador de otra bodega recibe 403; en el listado ve solo la suya).
- **(i)** Respuestas: un `Conteo` lleva `id_conteo`, `id_bodega`, `estado`, `fecha_programada`, `fecha_aprobacion`,
  `id_usuario_aprueba` y `detalles` (por `id_producto`, cada uno con `cantidad_sistema`, `cantidad_contada` y `diferencia`);
  `GET /conteos` lo devuelve sin `detalles`; la aprobación responde `{...Conteo, movimientos}` y `clave_aprobacion` nunca sale.
- **(j)** Umbral y bodega inactiva: tras confirmar, se evalúa el umbral (D13) de cada producto ajustado, fuera de la transacción y sin
  esperar el aviso; un fallo solo se registra. Una bodega inactiva es 409 `BODEGA_INACTIVA` aunque no haya diferencias, y deshace todo.

## D33. Tope de 1 000 líneas por conteo

Aprobar un conteo bloquea a la vez los saldos de todas sus líneas: uno enorme (con 100 kB de cuerpo caben unos 14 000 ids) dejaría
media bodega sin poder moverse durante segundos. Aprobar uno de 1 000 líneas con 666 ajustes tardó entre 2,6 y 2,9 s en una
medición local, por debajo de los 4 s que se fijaron como límite aceptable. El tope es la constante `MAX_LINEAS_CONTEO` (RF18).

- **(a)** `POST /conteos` con más de 1 000 `ids_producto` es 422; la longitud se comprueba antes de validar cada elemento, para que
  una lista enorme no cueste nada.
- **(b)** Sin `ids_producto`, la consulta de las líneas se corta en 1 001 filas; si se pasa del tope es 422 con un mensaje que pide
  contar por partes indicando `ids_producto`.
- **(c)** `PUT …/detalles` con más de 1 000 líneas es 422 antes de tocar la base (también antes del 404 o el 403 del conteo, lo
  que no revela nada de él). Mil exactas pasan.

## D34. Carga inicial de saldos

`POST /internas/saldos/carga-inicial` la llama solo ms-reportes al importar el inventario de arranque (RF16).

- **(a)** Una transacción por fila, en el orden de la lista (éxito parcial): la fila `n` (desde 1) lleva la clave
  `derivada(base, n)`, con `base = claveAlmacenada(idUsuario, 'ini', clave)`. Antes de procesar, una consulta busca cuáles de esas
  claves ya existen: esas filas ya están aplicadas y cuentan como `creados`. Un reintento que se solapa con la primera ejecución
  (ms-reportes reintenta a los 3 s con la misma clave mientras el servidor sigue trabajando) no duplica: si al aplicar una fila falla
  el 23505 de su clave, o cualquier rechazo que dependa de lo que la otra petición ya escribió, se relee la clave de la fila y, si
  existe, la fila cuenta como creada (Ruling 61). Aunque el cliente se desconecte, el servidor termina de procesar.
- **(b)** Validación por fila: una fila inválida se devuelve en `rechazados` con un `motivo` en español y no aborta la carga. Se
  rechaza una fila que no es un objeto; `id_producto` e `id_bodega` que no sean enteros ≥ 1; `cantidad` que no sea un entero ≥ 1
  dentro del `INTEGER` (0, negativa, decimal o texto); un `codigo_lote` que no sea un texto no vacío del largo de la columna; una
  `fecha_vencimiento` que no sea una fecha real o que venga sin `codigo_lote`; y los errores de negocio del motor que son 4xx
  (bodega inexistente o inactiva, lote con otra fecha, desborde). Cualquier error que no sea de negocio (la base caída) se propaga:
  500 para que el llamador reintente.
- **(c)** Tope: `filas` es un arreglo no vacío de como máximo 1 000 elementos (vacío, no arreglo o más de 1 000 es 422), y el cuerpo
  de esta ruta admite hasta 1 MB (un analizador propio montado antes del global solo para ella; el resto de rutas conserva los
  100 kB de D18). ms-reportes debe trocear las importaciones mayores.
- **(d)** Sin consulta al catálogo (es un llamador interno de confianza que ya resolvió los códigos, y mil llamadas HTTP por carga
  serían inviables con plazos de 3 s) y sin evaluación del umbral (D13: `CARGA_INICIAL` solo suma).
- **(e)** Identidad: `X-User-Id` y `X-User-Rol` son obligatorios (401; D22 y Ruling 10), sin alcance por bodega: es una llamada interna
  y el Gateway ya limita quién importa. Sin `Idempotency-Key` es 400.
- **(f)** Respuesta: siempre 200 `{creados, rechazados: [{fila, motivo}]}` si la petición está bien formada, aunque todas las filas
  se rechacen (`creados: 0`); `fila` es la posición desde 1 y `rechazados` va ordenado por `fila`.

## Ruling 10. `X-User-Id` sin `X-User-Rol` es 401

El Gateway siempre envía las dos cabeceras juntas y ningún llamador existente se rompe con esta regla, así que una petición con
`X-User-Id` pero sin `X-User-Rol` es 401 `NO_AUTENTICADO`. Sin el rol no se puede aplicar el alcance por bodega: aceptar la petición
daría a una llamada de identidad incompleta los permisos de un rol que nadie declaró (RNF09). Ver D20.

## Ruling 11. `/health` y `/docs` no dejan línea en el registro

Las sondas de salud que Kubernetes repite cada pocos segundos y la documentación llenarían el registro de ruido, y los servicios
hermanos (ms-reportes, ms-catalogo y ms-proveedores) hacen lo mismo. La exclusión es por ruta exacta (`/health`, `/docs`,
`/docs/openapi.yaml`, también con barra final) y solo para `GET` y `HEAD`: un `POST` a `/health` o un `/docs/otra-cosa` (404) sí
dejan su línea, y los errores de `/health` los registra su propio manejador (RNF10).

## Ruling 13. El registro nunca lanza

El logger se llama desde el manejador de errores y desde oyentes de eventos, donde una excepción tumbaría el proceso o dejaría que
Express respondiera con la traza. Por eso serializa con un reemplazo que escribe los `BigInt` como texto y los ciclos como
`"[Circular]"` (llevando la cadena de ancestros de cada llamada, para no marcar como ciclo una referencia compartida), y si aun así
falla escribe una línea mínima de respaldo con `servicio`, `nivel`, `request_id` y `aviso: "registro_no_serializable"`. También
protege la escritura a la salida estándar: un fallo al registrar no debe tumbar el proceso ni filtrar la pila al cliente (RNF10).

## Ruling 15. Las columnas `date` se leen como texto

`lotes.fecha_vencimiento` y `conteos.fecha_programada` se devuelven como el texto `YYYY-MM-DD` de la base, no como `Date`: el
analizador por defecto de `pg` las crea a medianoche local y, al serializarlas a JSON (UTC), cambian de día en un huso adelantado a
UTC. Se registra `pg.types.setTypeParser(1082, (v) => v)` en `src/config/db.js`. El texto en ese formato se ordena cronológicamente,
lo que usa el orden FEFO (D6).

## Ruling 16. Todo texto de entrada se valida con el largo de su columna

Un texto más largo que su columna haría que PostgreSQL lanzara un 22001, y sería un 500. Por eso todo campo de texto pasa por el
validador `texto(valor, campo, {max, min, opcional})` de `src/http/validate.js`, con `max` igual al largo exacto de la columna (es
obligatorio: sin él es un error de programación), que recorta los espacios de los extremos, mide el largo sobre lo que se guarda y
rechaza el carácter nulo y los sustitutos UTF-16 sueltos. `Idempotency-Key` admite 200 caracteres porque la clave guardada añade el
usuario, la operación y un sufijo y debe caber en `varchar(255)` (D25b).

## Ruling 18. El código de una bodega es único sin distinguir mayúsculas

ms-reportes agrupa las bodegas por `codigo.strip().casefold()`; con `mzl` y `MZL` como bodegas distintas rechazaría todas las filas
de `STOCK_INICIAL` por «hay más de una bodega con ese código». Por eso, además de la unicidad del código exacto
(`bodegas_codigo_key`), hay un índice único funcional sobre `lower(codigo)` (`bodegas_codigo_lower_key`), y el servicio responde 409
`CODIGO_DUPLICADO` ante cualquiera de los dos. El código se guarda recortado, porque esa es la clave con la que ms-reportes lo busca.
`lower()` de PostgreSQL depende de la collation y `casefold()` de Python pliega más (`ß` a `ss`); para códigos ASCII coinciden.

## Ruling 21. Las funciones de los repositorios son `async`

Sin `async`, Knex devuelve su constructor de consultas, que es un objeto con `then` pero no una `Promise`: un fallo síncrono no
llega como rechazo y un doble `await` ejecutaría la consulta dos veces. Por eso toda función de repositorio que toca la base es
`async` y devuelve una promesa real; las pruebas de capas lo comprueban con la lista de las funciones exportadas (RNF13).

## Ruling 44. El lote se bloquea siempre dentro de su par

`loteRepository.bloquearPorId` exige el par `{idBodega, idProducto}` (un `TypeError` si falta o no son enteros positivos) y solo
encuentra y bloquea el lote si es de ese par. Así nunca toma un lote de otro (producto, bodega) cuyo saldo no tiene bloqueado, que es
lo que cerraría un ciclo de esperas con un traslado (D27(c)). En la misma línea, la comprobación del lote que entra al motor usa el
mismo validador de fechas que la API: una fecha imposible como `2027-02-30` sería un 22008 de la base, es decir, un 500.

## Ruling 61. Qué se informa de una fila de la carga inicial que no se pudo comprobar

ms-reportes espera 3 s por intento y reintenta con la misma clave, y la carga de 1 000 filas tarda unos 5 s: converge con un
reintento sin duplicar nada, y se acepta sin cambiar el diseño. Pero si una fila falla con un 4xx del motor, antes de clasificarla se
relee su clave (D34(a)); si esa relectura falla, se propaga ese error (500) y no el 4xx original, porque informar como «rechazada»
una fila que sí se creó sería un dato falso. Queda documentado que una clave nueva con las mismas filas las vuelve a sumar (la
idempotencia es por clave y posición, no por contenido), y que ms-reportes genera un `uuid4` nuevo por importación.
