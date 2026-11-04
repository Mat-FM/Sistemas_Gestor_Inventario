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

- **Entorno de producción.** Defina `APP_ENV=production` y `APP_DEBUG=false`: `.env.example` trae `local` y `true`, que son para desarrollo. Las respuestas JSON nunca incluyen trazas ni mensajes internos, ni siquiera con el modo de depuración activo, pero en producción debe estar apagado. Defina también `APP_LOCALE=es` y `CACHE_STORE=database`. El contador del límite de peticiones vive en el almacén de caché; con `database` se comparte entre las copias del Gateway (RNF05) y hay que haber migrado la tabla `cache` (`php artisan migrate`). Con otros almacenes locales (`array`, `file`) cada copia contaría por separado. Todas las copias deben compartir el mismo `JWT_SECRET`, o no se reconocerán los tokens entre sí.
- **Limpieza de la caché.** El almacén `database` no elimina las filas vencidas de la tabla `cache`: solo borra una fila vencida cuando se vuelve a leer esa misma clave, y Laravel no trae un comando de Artisan que pode el resto. Programe una limpieza periódica fuera de la aplicación, por ejemplo con un CronJob de Kubernetes que ejecute `DELETE FROM cache WHERE expiration <= UNIX_TIMESTAMP();`.
- **IP real del cliente (`TRUSTED_PROXIES`).** El límite de 10 intentos de inicio de sesión por IP depende de que la aplicación vea la IP real del cliente. Detrás de un Ingress, de un Service o de un balanceador, todos los clientes llegarían con la IP de ese intermediario y compartirían un único contador: tras 10 intentos en un minuto, nadie más podría iniciar sesión. `TRUSTED_PROXIES` es la lista de IP o CIDR de esos intermediarios, separados por comas (por ejemplo, `10.0.0.0/8`). Las entradas vacías y los espacios se ignoran. Solo de esas direcciones se aceptan `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Port` y `X-Forwarded-Proto`; cualquier otra petición se toma con la IP que conecta. Vacía (el valor de `.env.example`), no se confía en ningún proxy y esas cabeceras se ignoran siempre. `*`, `REMOTE_ADDR` y los rangos `/0` se rechazan, porque confiar en todos dejaría a cualquier cliente falsear su IP con `X-Forwarded-For` y esquivar el límite. También se rechaza cualquier entrada que no sea una IP (v4 o v6) ni un CIDR, como un nombre de host. Con un valor rechazado, todas las peticiones (también `/health`) responden 500 y el registro explica el motivo; los comandos de consola no se ven afectados. Antes de este cambio, el Gateway usaba el `TrustProxies` por defecto de Laravel, que sin proxies configurados confía en todos cuando el `Host` de la petición (que lo pone el cliente) termina en `.on-forge.com` o `.on-vapor.com`, o en Laravel Cloud. Con ese `Host`, un cliente podía falsear su IP. `ConfiarEnProxies` lo sustituye y lee la lista en cada petición, así que funciona también con `php artisan config:cache`.
- **Tamaño de las cargas (`/api/importaciones`).** Los archivos llegan como `multipart/form-data` y PHP los limita con `upload_max_filesize` (cada archivo) y `post_max_size` (la petición entera, que debe ser mayor). Súbalos en la configuración de PHP de la imagen al tamaño máximo que acepte el servicio de destino. Si un archivo supera `upload_max_filesize`, el Gateway responde 422 `DATOS_NO_VALIDOS` («El archivo no se recibió completo.») y no reenvía nada. Si la petición supera `post_max_size`, PHP descarta todos sus campos y archivos (los deja vacíos y solo emite un aviso). Cuando PHP conoce la longitud de la petición (`Content-Length`, lo normal), el Gateway lo detecta y responde 413 `PETICION_MAL_FORMADA` sin reenviar nada. Si no la conoce (una petición por partes, *chunked*, que el servidor web no reagrupa), el Gateway no puede detectarlo y reenvía al servicio una petición vacía, sin campos ni archivos.
- **Imagen del contenedor.** Cuando se contenerice, la imagen debe incluir `openapi.yaml`, `resources/docs/swagger-ui.html` y `lang/`. Sin los dos primeros, `/docs` responde 500. Sin `lang/`, la validación sigue funcionando, pero muchos mensajes salen como claves sin traducir (por ejemplo, `validation.required`) en vez del texto en español.
- **Único punto de entrada (RNF09).** El Gateway es el único componente accesible desde fuera del clúster. Los microservicios confían en las cabeceras `X-User-*` que él añade, así que solo deben ser alcanzables desde dentro del clúster.

## Sesiones

El token es un JWT sin estado: el Gateway no guarda sesiones y el token sirve hasta que vence, a los `JWT_TTL_MINUTES` (60 por defecto) de emitirse. En cada petición se vuelve a leer al usuario de la base, y el rol y la bodega salen de ahí, no del token. Por eso inactivar a un usuario o cambiarle el rol surte efecto de inmediato en las rutas autenticadas: con el token que ya tenía, la siguiente petición es 401 o se hace con el rol nuevo.

Limitación conocida: no existe revocación de tokens.

- `POST /api/auth/logout` no invalida el token; es el cliente quien debe borrarlo.
- Restablecer la contraseña (`POST /api/usuarios/{id}/restablecer-contrasena`) no invalida los tokens ya emitidos. Deja el cambio de contraseña pendiente, así que mientras el usuario no cambie la temporal esos tokens solo sirven para `PUT /api/auth/contrasena` (que exige la contraseña temporal) y `POST /api/auth/logout`. En cuanto la cambia, todos sus tokens aún vigentes vuelven a servir para todo hasta que vencen.
- Cambiar la propia contraseña (`PUT /api/auth/contrasena`) tampoco invalida los demás tokens del usuario.
- Reactivar a un usuario inactivado (`POST /api/usuarios/{id}/activar`) vuelve a habilitar los tokens que se le emitieron antes de inactivarlo y aún no han vencido.

Cómo resolverlo es una decisión pendiente del equipo.
