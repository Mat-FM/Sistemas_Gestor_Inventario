# api-gateway

Único punto de entrada del sistema. Lo programa el equipo en Laravel, sin Kong ni otros gateways de terceros (RNF09).

- **Framework:** Laravel 13 (PHP 8.4) · **Base de datos:** MySQL (`Usuario`, `Rol`) · **Puerto en el clúster:** 8000
- **Requerimientos:** RF07, RF08, RNF07, RNF09, RNF19
- **Escalado:** pasa automáticamente de 1 a 4 copias cuando la CPU supera el 70 % (RNF05)

## Responsabilidades

- Enrutamiento hacia cada microservicio según la ruta.
- Inicio y cierre de sesión, cambio y restablecimiento de contraseña (la restablece el administrador con una temporal). JWT firmado, válido 60 minutos; contraseñas con bcrypt.
- Verificación del token y permisos por rol en cada petición (401 sin token válido, 403 sin permiso).
- Límite de peticiones: 100/min por usuario y 10 intentos de inicio de sesión/min por IP (429 con `Retry-After`).
- Identificador de petición (`X-Request-Id`) y registros JSON por petición.

Al reenviar, agrega las cabeceras `X-User-Id`, `X-User-Rol`, `X-User-Bodega` y `X-Request-Id`.
Roles: `ADMINISTRADOR`, `OPERADOR_BODEGA`, `VENDEDOR`, `CONTADOR`.

## Estructura (RNF13)

El código está en capas separadas de enrutamiento, seguridad y gestión de usuarios:

| Capa | Dónde |
| --- | --- |
| Enrutamiento | `app/Services/Routing` (mapa de rutas y permisos, tomado de `config/gateway_routes.php`) y `app/Services/Proxy` (reenvío a los servicios) |
| Seguridad | `app/Services/Jwt` (emisión y verificación del token) y `app/Http/Middleware` (JWT, rol, cambio de contraseña pendiente, identificador de petición y registro) |
| Usuarios y roles | `app/Services/Usuarios`, `app/Models` y `database/` |

## Rutas propias

Todo lo demás bajo `/api` se reenvía al microservicio que corresponda, sin el prefijo `/api`, si el rol del usuario lo permite (mapa en `config/gateway_routes.php`); lo que no esté en el mapa responde 404.

| Ruta | Quién |
| --- | --- |
| `POST /api/auth/login` | Pública (10 intentos por minuto por IP) |
| `PUT /api/auth/contrasena`, `POST /api/auth/logout` | Cualquier usuario autenticado |
| `GET /api/auth/me` | Cualquier usuario autenticado sin cambio de contraseña pendiente |
| `GET\|POST /api/usuarios`, `GET\|PUT /api/usuarios/{id}`, `POST /api/usuarios/{id}/inactivar`, `POST /api/usuarios/{id}/activar`, `POST /api/usuarios/{id}/restablecer-contrasena`, `GET /api/roles` | Solo `ADMINISTRADOR` |
| `GET /health` | Pública |
| `GET /docs` y `GET /docs/openapi.yaml` | Públicas |

Mientras un usuario tenga el cambio de contraseña pendiente (el primer administrador, un usuario recién creado o uno al que le restablecieron la contraseña), solo funcionan `PUT /api/auth/contrasena` y `POST /api/auth/logout`. Cualquier otra ruta autenticada, incluidas `GET /api/auth/me` y las que se reenvían a los servicios, responde 403 `CAMBIO_CONTRASENA_REQUERIDO` hasta que la cambie.

`/docs` publica la documentación OpenAPI del propio Gateway (`openapi.yaml`): solo describe las rutas de esta tabla, porque cada microservicio publica la suya. La página usa Swagger UI cargado desde un CDN, así que el navegador necesita acceso a internet.

## Requisitos

- PHP 8.4 con las extensiones que exige Composer, además de `pdo_mysql` (ejecución) y `pdo_sqlite` (pruebas).
- Composer 2.
- Docker, para la base MySQL local.

## Instalación

```bash
cd api-gateway
composer install
cp .env.example .env
php artisan key:generate
```

Después, edite `.env`:

- **`JWT_SECRET`**: viene vacío a propósito y debe tener al menos 32 caracteres. Genérelo con `openssl rand -base64 48` y pegue el resultado. Sin él, la aplicación no emite ni acepta tokens.
- **`ADMIN_EMAIL` y `ADMIN_PASSWORD`**: vienen vacíos y son obligatorios para crear el primer administrador (sin él nadie podría entrar, porque solo un administrador crea usuarios). La contraseña es temporal y debe tener al menos 8 caracteres, una letra y un número, y no pasar de 72 bytes; el administrador debe cambiarla en su primer inicio de sesión.

Las demás variables traen valores que funcionan tal cual en local. Las principales:

| Variable | Para qué sirve |
| --- | --- |
| `DB_*` | Conexión a MySQL (`gateway_db`, usuario `gateway`, puerto local 3307) |
| `JWT_TTL_MINUTES` | Vigencia del token (60) |
| `RATE_LIMIT_PER_MINUTE` | Peticiones por minuto por usuario (100) |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | Intentos de inicio de sesión por minuto por IP (10) |
| `MS_*_URL` | URL de cada microservicio (RNF14); por defecto, los nombres del DNS interno de Kubernetes |
| `TRUSTED_PROXIES` | Proxies de confianza (vacía en local; ver «Notas de despliegue») |
| `APP_LOCALE`, `APP_FALLBACK_LOCALE` | Idioma de los mensajes (`es`) |

## Base de datos

```bash
# Desde la raíz del repositorio: levanta solo la base del Gateway (puerto local 3307)
docker compose up -d db-api-gateway

# Desde api-gateway/: crea las tablas, los cuatro roles y el primer administrador
php artisan migrate --seed
```

Las credenciales por defecto del `docker-compose.yml` (`gateway` / `change_me`, base `gateway_db`) son las de `.env.example`; si cambia `GATEWAY_DB_PASSWORD` en el `.env` de la raíz, cambie también `DB_PASSWORD`.

`migrate --seed` falla con un mensaje claro si `ADMIN_EMAIL` o `ADMIN_PASSWORD` faltan o la contraseña no cumple la regla. Repetirlo no duplica roles ni sobrescribe un usuario que ya existe, pero vuelve a exigir una `ADMIN_PASSWORD` válida cada vez, aunque el administrador ya exista. Por eso conviene ejecutar `php artisan migrate --seed` una sola vez, al instalar, y después solo `php artisan migrate`: así no hay que dejar la contraseña temporal en el entorno de un pipeline de despliegue.

## Ejecutar el servidor

```bash
php artisan serve        # http://127.0.0.1:8000
curl http://127.0.0.1:8000/health
```

`GET /health` responde 200 `{"estado":"ok","servicio":"api-gateway"}` solo si la configuración permite atender peticiones: `JWT_SECRET` tiene al menos 32 caracteres, `JWT_TTL_MINUTES` es de al menos un minuto y las seis `MS_*_URL` son URLs `http` o `https` válidas. Si no, responde 503 `SERVICIO_NO_DISPONIBLE`, sin decir qué falla, y registra un error `configuracion_no_valida` con los nombres de las variables que hay que revisar (nunca sus valores). Sirve como sonda de readiness: un pod mal configurado no recibe tráfico, en vez de responder 500 a cada inicio de sesión o ruta autenticada. No consulta la base de datos ni los microservicios, no exige token y no tiene límite de peticiones.

La documentación queda en `http://127.0.0.1:8000/docs`.

## Docker (RNF03)

La imagen parte de `php:8.4-apache` y sirve `public/` con Apache como `www-data` (UID 33), sin privilegios de root. Lleva el código, las migraciones y los sembradores, `openapi.yaml` y `resources/docs/` (los de `/docs`), `lang/` y solo las dependencias de producción; no lleva el `.env` (ni uno suelto en otra carpeta), las pruebas, Node ni los registros del equipo (`.dockerignore`): toda la configuración llega por variables de entorno (RNF14). Pesa unos 806 MB, de los que 735 son de la imagen base. Apache escucha en el 8000 (`PORT`) y no registra accesos: la aplicación ya escribe cada petición en JSON por la salida de errores (RNF10).

```bash
docker build -t api-gateway api-gateway     # desde la raíz del repositorio
```

Variables que llegan al ejecutar el contenedor (la imagen ya fija `APP_ENV=production`, `APP_DEBUG=false`, `APP_LOCALE=es`, `LOG_CHANNEL=json_stderr`, `DB_CONNECTION=mysql`, `DB_PORT=3306`, `CACHE_STORE=database` y `SESSION_DRIVER=array`):

| Variable | ¿Obligatoria? | Para qué |
| --- | --- | --- |
| `JWT_SECRET` | Sí | Firma de los tokens: al menos 32 caracteres, sin valor por defecto y la misma en todas las copias. Sin ella, `/health` responde 503 |
| `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | Sí | Conexión a MySQL |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Solo al sembrar | Primer administrador (ver más abajo); nunca en las copias que atienden tráfico |
| `APP_KEY` | Recomendada | Laravel la espera. El Gateway no cifra nada (ni cookies ni sesiones) y funcionó sin ella en las pruebas, pero se define igual, la misma en todas las copias |
| `MS_*_URL` (las seis) | Fuera del clúster | Por defecto valen los nombres del DNS interno de Kubernetes (`http://ms-catalogo:8000`...); fuera del clúster, o con otros nombres, hay que definirlas |
| `TRUSTED_PROXIES` | Detrás de un proxy | IP o CIDR del Ingress o Service (ver «Notas de despliegue»). Un valor no válido hace responder 500 a todo, también a `/health` |
| `RATE_LIMIT_PER_MINUTE`, `LOGIN_RATE_LIMIT_PER_MINUTE`, `JWT_TTL_MINUTES` | No | 100, 10 y 60 |

Antes de ejecutar los comandos, tres datos que dependen de su equipo y que **no van escritos en ellos**:

- **El puerto del equipo.** El 3000 y el 8000 pueden estar ocupados por otros proyectos, así que los comandos no los usan: elija un puerto libre y guárdelo en `PUERTO_LIBRE` (por ejemplo, `export PUERTO_LIBRE=18080`). El Gateway se publica solo en `127.0.0.1`; dentro del contenedor sigue en el 8000. Si ese puerto estuviera ocupado, `docker run` falla pero deja el contenedor creado: bórrelo con `docker rm api-gateway` antes de repetir el comando con otro puerto.
- **Las contraseñas y los secretos.** No se fijan en los comandos: guárdelos en variables del shell y el `-e NOMBRE` sin valor los toma de ahí. `read -rs NOMBRE && export NOMBRE` pide el valor sin mostrarlo ni dejarlo en el historial. Con un archivo local, fuera del repositorio, que defina esas variables, `--env-file <archivo>` hace lo mismo (y entonces se quitan los `-e`). `JWT_SECRET` y `APP_KEY` se generan **una sola vez** y se guardan, y se usan los mismos en todas las copias: si `JWT_SECRET` cambia, los tokens vigentes dejan de valer.
- **La base.** Con la del compose (`docker compose up -d db-api-gateway`, desde la raíz), dentro de la red `gestor-inventario_default` se llama `db-api-gateway` y escucha en el 3306 (no en el 3307, que es el puerto publicado en el equipo). `DB_PASSWORD` es la misma que `GATEWAY_DB_PASSWORD` en el `.env` de la raíz.

```bash
export PUERTO_LIBRE=18080
read -rs DB_PASSWORD && export DB_PASSWORD
export JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
export APP_KEY=$(docker run --rm api-gateway php artisan key:generate --show)
```

Las migraciones y el sembrado **no se ejecutan al arrancar el contenedor**: con varias copias arrancando a la vez correrían a la vez. Se lanzan con esta misma imagen, una sola vez para todas las copias y antes de arrancarlas (en Kubernetes, con un Job):

```bash
# Tablas: cada despliegue (incluye la tabla `cache` del límite de peticiones)
docker run --rm --network gestor-inventario_default \
  -e DB_HOST=db-api-gateway -e DB_DATABASE=gateway_db -e DB_USERNAME=gateway -e DB_PASSWORD \
  api-gateway php artisan migrate --force

# Roles y primer administrador: UNA sola vez, con ADMIN_EMAIL y ADMIN_PASSWORD en el entorno
export ADMIN_EMAIL=admin@example.com
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
docker run --rm --network gestor-inventario_default \
  -e DB_HOST=db-api-gateway -e DB_DATABASE=gateway_db -e DB_USERNAME=gateway -e DB_PASSWORD \
  -e ADMIN_EMAIL -e ADMIN_PASSWORD \
  api-gateway php artisan migrate --seed --force

# El Gateway
docker run -d --name api-gateway --network gestor-inventario_default -p 127.0.0.1:$PUERTO_LIBRE:8000 \
  -e DB_HOST=db-api-gateway -e DB_DATABASE=gateway_db -e DB_USERNAME=gateway -e DB_PASSWORD \
  -e JWT_SECRET -e APP_KEY \
  api-gateway
```

Quedan en `http://127.0.0.1:$PUERTO_LIBRE/docs` (documentación) y `/health` del mismo puerto. Los demás servicios todavía no están en el compose: con esas direcciones sin servicio detrás, `/health` responde 200 (solo comprueba que las variables estén bien escritas) y las rutas reenviadas (`/api/productos`...) responden 503 `SERVICIO_NO_DISPONIBLE`.

- **Sembrado.** `migrate --seed` aplica primero las migraciones pendientes y luego siembra. Sin `ADMIN_EMAIL` o `ADMIN_PASSWORD` (o con una contraseña que no cumple la regla) termina con código 1 y un mensaje claro, pero las tablas ya quedaron creadas: basta repetirlo con las variables bien puestas. Repetirlo no duplica roles ni sobrescribe al administrador (aunque se cambie `ADMIN_PASSWORD`, la contraseña que quedó es la primera), pero vuelve a exigir variables válidas; por eso el Job de sembrado se ejecuta una sola vez y las copias que atienden tráfico nunca llevan `ADMIN_*`. El administrador inicia sesión con la contraseña temporal y debe cambiarla.
- **`CACHE_STORE=database`, no `file`.** El contador del límite de peticiones (RNF19) vive en el almacén de caché. Con `database`, todas las copias (RNF05) cuentan en la misma tabla `cache`; con `file` cada copia llevaría su cuenta. Comprobado con dos contenedores contra la misma base y `RATE_LIMIT_PER_MINUTE=5`, alternando las peticiones autenticadas entre ambos: con `database` el 429 (con `Retry-After`) llega a la sexta petición en total; con `file`, a la undécima (cinco por copia).
- **`HEALTHCHECK`.** Cada 30 s la imagen consulta `/health` con `curl` y marca el contenedor como no sano (`docker inspect -f '{{.State.Health.Status}}' api-gateway`) si no responde 200: una `JWT_SECRET` o `JWT_TTL_MINUTES` inválidos, una `MS_*_URL` que no es una URL `http(s)` o una `TRUSTED_PROXIES` no válida. `/health` no consulta la base de datos: con MySQL caído el contenedor sigue «sano» y el inicio de sesión responde 500 `ERROR_INTERNO`. Esa vigilancia es de quien orqueste.
- **Apagado ordenado.** `docker stop` envía `SIGWINCH`, la señal de parada de la imagen de Apache: termina las peticiones en curso y sale con código 0 (`docker inspect -f '{{.State.ExitCode}}' api-gateway`), en poco más de un segundo.
- **Cargas.** La imagen deja los límites de `php.ini-production`: 2 MB por archivo (`upload_max_filesize`) y 8 MB por petición (`post_max_size`). Ni el contrato ni `ms-reportes` fijan un tamaño máximo para `POST /api/importaciones`, y no se inventó uno. Con la imagen, un archivo de 3 MB recibe 422 `DATOS_NO_VALIDOS` y una petición de 9 MB, 413 `PETICION_MAL_FORMADA`. Si hace falta más, se cambia en `servicio.ini` (en el `Dockerfile`), con `post_max_size` mayor que `upload_max_filesize`.
- **Si falta `openapi.yaml`, `resources/docs/swagger-ui.html` o `lang/`**, el Gateway arranca igual y `/health` responde 200, pero sin `openapi.yaml` el `/docs/openapi.yaml` responde 500, sin `swagger-ui.html` el `/docs` responde 500 y sin `lang/` los mensajes de validación salen como claves (`validation.required`). No los excluya del `.dockerignore`: `tests/Unit/DockerfileTest.php` comprueba que sigan dentro de la imagen.

### Para los manifiestos de `k8s/`

Lo comprobado con la imagen y lo que de ello se desprende (los manifiestos aún no existen):

- **Migraciones y sembrado: un Job**, con la imagen del Gateway y los `DB_*` del Secret, antes del Deployment. `command: ["php", "artisan", "migrate", "--force"]` en cada despliegue y `["php", "artisan", "migrate", "--seed", "--force"]` (con `ADMIN_EMAIL` y `ADMIN_PASSWORD` solo en ese Job) una sola vez. Nunca en un `initContainer` del Deployment: con 4 copias correrían a la vez.
- **Secretos compartidos.** `JWT_SECRET`, `APP_KEY` y `DB_PASSWORD` salen de un Secret, el mismo para todas las copias.
- **Usuario.** `securityContext.runAsNonRoot: true` es válido: la imagen declara `USER 33` por su número.
- **Sistema de archivos de solo lectura.** `readOnlyRootFilesystem: true` funciona si se montan volúmenes `emptyDir` en `/tmp` (PHP escribe ahí las cargas de `/api/importaciones`; sin él, esas peticiones fallan con 422) y en `/var/run/apache2` (sin él, Apache no puede escribir su archivo de PID y no arranca). Conviene montar también `/var/lock/apache2`, el directorio de candados de Apache: en las pruebas no hizo falta (400 peticiones concurrentes sin errores), pero es el otro directorio donde la imagen base prepara a Apache para escribir. El Gateway **no necesita escribir en `storage/` ni en `bootstrap/cache`**: con `docker run --read-only` y los tres `--tmpfs`, el login, los errores 404, 422 y 503, el 429, `/docs` y las cargas funcionaron, no apareció ningún error de escritura y `docker diff` quedó vacío.
- **Sondas.** `/health` en el puerto 8000, sin autenticación. Como no consulta la base, sirve de sonda de configuración, no de disponibilidad de MySQL.
- **Parada.** El apagado ordenado está comprobado con `docker stop` (`SIGWINCH`, código 0), no con Kubernetes: el manifiesto debe confirmar que el runtime del clúster respeta el `STOPSIGNAL` de la imagen (si envía `SIGTERM`, Apache corta las peticiones en curso) y fijar `terminationGracePeriodSeconds`.
- **Escalado.** HPA de 1 a 4 copias al 70 % de CPU (RNF05): necesita `resources.requests.cpu` en el contenedor. El Service del Gateway expone el 8000, y su Ingress o Service debe figurar en `TRUSTED_PROXIES`.

## Pruebas

```bash
php artisan test
```

Las pruebas usan SQLite en memoria y simulan los microservicios (`Http::fake()`), así que no necesitan MySQL ni ningún servicio levantado.

El paquete de desarrollo `laravel/pao` condensa la salida de las pruebas en JSON cuando detecta que las ejecuta una herramienta automática (por las variables de entorno que esta define), y eso puede ocultar los avisos de PHPUnit. Si la salida aparece comprimida, ejecute PHPUnit directamente y sin esas variables definidas para ver la salida completa:

```bash
vendor/bin/phpunit --display-all-issues --colors=never
```

El código debe pasar el formateador: `vendor/bin/pint --test` (sin `--test` lo corrige).

### Cobertura (RNF20)

```bash
php artisan test --coverage --min=60
```

Exige una cobertura mínima del 60 % y requiere un controlador de cobertura (`pcov` o `xdebug`), que PHP no trae por defecto. Sin él, el comando termina con «Code coverage driver not available». Para instalarlo en local, por ejemplo, `pecl install pcov`.

La integración continua lo ejecuta en cada pull request que toque `api-gateway/` o su flujo: [`.github/workflows/ci-api-gateway.yml`](../.github/workflows/ci-api-gateway.yml) instala PHP 8.4 con `pcov`, copia `.env.example` a `.env`, genera la llave y corre este mismo comando.

## Notas de despliegue

- **Entorno de producción.** Defina `APP_ENV=production` y `APP_DEBUG=false`: `.env.example` trae `local` y `true`, que son para desarrollo. Las respuestas JSON nunca incluyen trazas ni mensajes internos, ni siquiera con el modo de depuración activo, pero en producción debe estar apagado. Defina también `APP_LOCALE=es` y `CACHE_STORE=database` (la imagen de Docker ya fija los cuatro valores). El contador del límite de peticiones vive en el almacén de caché; con `database` se comparte entre las copias del Gateway (RNF05) y hay que haber migrado la tabla `cache` (`php artisan migrate`). Con otros almacenes locales (`array`, `file`) cada copia contaría por separado. Todas las copias deben compartir el mismo `JWT_SECRET`, o no se reconocerán los tokens entre sí.
- **Limpieza de la caché.** El almacén `database` no elimina las filas vencidas de la tabla `cache`: solo borra una fila vencida cuando se vuelve a leer esa misma clave, y Laravel no trae un comando de Artisan que pode el resto. Programe una limpieza periódica fuera de la aplicación, por ejemplo con un CronJob de Kubernetes que ejecute `DELETE FROM cache WHERE expiration <= UNIX_TIMESTAMP();`.
- **IP real del cliente (`TRUSTED_PROXIES`).** El límite de 10 intentos de inicio de sesión por IP depende de que la aplicación vea la IP real del cliente. Detrás de un Ingress, de un Service o de un balanceador, todos los clientes llegarían con la IP de ese intermediario y compartirían un único contador: tras 10 intentos en un minuto, nadie más podría iniciar sesión. `TRUSTED_PROXIES` es la lista de IP o CIDR de esos intermediarios, separados por comas (por ejemplo, `10.0.0.0/8`). Las entradas vacías y los espacios se ignoran. Solo de esas direcciones se aceptan `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Port` y `X-Forwarded-Proto`; cualquier otra petición se toma con la IP que conecta. Vacía (el valor de `.env.example`), no se confía en ningún proxy y esas cabeceras se ignoran siempre. `*`, `REMOTE_ADDR` y los rangos `/0` se rechazan, porque confiar en todos dejaría a cualquier cliente falsear su IP con `X-Forwarded-For` y esquivar el límite. También se rechaza cualquier entrada que no sea una IP (v4 o v6) ni un CIDR, como un nombre de host. Con un valor rechazado, todas las peticiones (también `/health`) responden 500 y el registro explica el motivo; los comandos de consola no se ven afectados. Antes de este cambio, el Gateway usaba el `TrustProxies` por defecto de Laravel, que sin proxies configurados confía en todos cuando el `Host` de la petición (que lo pone el cliente) termina en `.on-forge.com` o `.on-vapor.com`, o en Laravel Cloud. Con ese `Host`, un cliente podía falsear su IP. `ConfiarEnProxies` lo sustituye y lee la lista en cada petición, así que funciona también con `php artisan config:cache`.
- **Tamaño de las cargas (`/api/importaciones`).** Los archivos llegan como `multipart/form-data` y PHP los limita con `upload_max_filesize` (cada archivo) y `post_max_size` (la petición entera, que debe ser mayor). Súbalos en la configuración de PHP de la imagen al tamaño máximo que acepte el servicio de destino; la imagen actual deja los valores de `php.ini-production` (2 MB y 8 MB), porque ese máximo no está definido (ver «Docker»). Si un archivo supera `upload_max_filesize`, el Gateway responde 422 `DATOS_NO_VALIDOS` («El archivo no se recibió completo.») y no reenvía nada. Si la petición supera `post_max_size`, PHP descarta todos sus campos y archivos (los deja vacíos y solo emite un aviso). Cuando PHP conoce la longitud de la petición (`Content-Length`, lo normal), el Gateway lo detecta y responde 413 `PETICION_MAL_FORMADA` sin reenviar nada. Si no la conoce (una petición por partes, *chunked*, que el servidor web no reagrupa), el Gateway no puede detectarlo y reenvía al servicio una petición vacía, sin campos ni archivos.
- **Imagen del contenedor.** Ver «Docker (RNF03)». La imagen incluye `openapi.yaml`, `resources/docs/swagger-ui.html` y `lang/`; sin `openapi.yaml`, `/docs/openapi.yaml` responde 500, y sin `swagger-ui.html`, `/docs`. Sin `lang/`, la validación sigue funcionando, pero muchos mensajes salen como claves sin traducir (por ejemplo, `validation.required`) en vez del texto en español.
- **Único punto de entrada (RNF09).** El Gateway es el único componente accesible desde fuera del clúster. Los microservicios confían en las cabeceras `X-User-*` que él añade, así que solo deben ser alcanzables desde dentro del clúster.

## Sesiones

El token es un JWT sin estado: el Gateway no guarda sesiones y el token sirve hasta que vence, a los `JWT_TTL_MINUTES` (60 por defecto) de emitirse, salvo que se revoque como se explica más abajo. En cada petición se vuelve a leer al usuario de la base, y el rol y la bodega salen de ahí, no del token. Por eso inactivar a un usuario o cambiarle el rol surte efecto de inmediato en las rutas autenticadas: con el token que ya tenía, la siguiente petición es 401 o se hace con el rol nuevo.

**Restablecer la contraseña** (`POST /api/usuarios/{id}/restablecer-contrasena`) **e inactivar** (`POST /api/usuarios/{id}/inactivar`) **revocan las sesiones anteriores** del usuario. Restablecer es la vía de recuperación cuando se sospecha que le robaron la sesión: sin revocación, el token del atacante seguiría sirviendo hasta vencer y, en cuanto el usuario fijara su contraseña definitiva, volvería a servir para todo. Ambas operaciones guardan el instante en `usuarios.sesiones_desde` (UTC, al segundo; es un dato interno que no aparece en la API ni en `openapi.yaml`), y `AuthenticateJwt` rechaza todo token del usuario cuya claim `iat` sea anterior a esa marca. El rechazo es el mismo 401 `NO_AUTENTICADO` genérico de cualquier token no válido: no indica el motivo.

- **Ventana de un segundo.** La comparación es al segundo y el token vale si su `iat` es igual o posterior a la marca. Así quien inicia sesión con la contraseña temporal en el mismo segundo del restablecimiento no queda bloqueado; a cambio, un token emitido en ese mismo segundo sobrevive a la revocación. Es una limitación aceptada.
- **Reactivar no rehabilita.** `POST /api/usuarios/{id}/activar` no limpia la marca: los tokens anteriores a la inactivación siguen sin servir aunque no hayan vencido, y el usuario debe iniciar sesión de nuevo.
- **Cambiar la propia contraseña no revoca.** `PUT /api/auth/contrasena` no revoca nada, ni el token con el que se hace ni los de las demás sesiones del usuario: es una decisión de contrato (la Tabla 6 no lo prevé y el cliente web puede seguir con el mismo token). Tampoco lo hacen cambiar el rol ni editar los datos de un usuario.
- **Un administrador que restablece su propia contraseña pierde su sesión actual.** La petición responde 204, pero su token deja de servir: debe iniciar sesión de nuevo con la temporal.
- **Cerrar sesión no revoca.** `POST /api/auth/logout` no invalida el token; es el cliente quien debe borrarlo. Fuera de restablecer la contraseña e inactivar, un token robado sigue sirviendo hasta que vence.
- **Despliegue.** La columna la crea la migración `2026_11_04_000000_add_sesiones_desde_to_usuarios` (`php artisan migrate`); los usuarios que ya existen quedan con la marca nula, es decir, sin revocaciones. Cada copia del Gateway escribe la marca y el `iat` con su propio reloj, así que deben tener los relojes sincronizados (por ejemplo, con NTP): cualquier desfase entre los relojes de las copias ensancha la ventana de un segundo, y puede dejar vivo un token revocado o rechazar uno recién emitido tras el restablecimiento.
