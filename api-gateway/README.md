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
| `POST /api/auth/logout`, `GET /api/auth/me`, `PUT /api/auth/contrasena` | Cualquier usuario autenticado |
| `GET\|POST /api/usuarios`, `GET\|PUT /api/usuarios/{id}`, `POST /api/usuarios/{id}/inactivar`, `POST /api/usuarios/{id}/activar`, `POST /api/usuarios/{id}/restablecer-contrasena`, `GET /api/roles` | Solo `ADMINISTRADOR` |
| `GET /health` | Pública |
| `GET /docs` y `GET /docs/openapi.yaml` | Públicas |

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
| `APP_LOCALE`, `APP_FALLBACK_LOCALE` | Idioma de los mensajes (`es`) |

## Base de datos

```bash
# Desde la raíz del repositorio: levanta solo la base del Gateway (puerto local 3307)
docker compose up -d db-api-gateway

# Desde api-gateway/: crea las tablas, los cuatro roles y el primer administrador
php artisan migrate --seed
```

Las credenciales por defecto del `docker-compose.yml` (`gateway` / `change_me`, base `gateway_db`) son las de `.env.example`; si cambia `GATEWAY_DB_PASSWORD` en el `.env` de la raíz, cambie también `DB_PASSWORD`.

`migrate --seed` falla con un mensaje claro si `ADMIN_EMAIL` o `ADMIN_PASSWORD` faltan o la contraseña no cumple la regla. Se puede repetir sin riesgo: no duplica roles y nunca sobrescribe un usuario que ya existe.

## Ejecutar el servidor

```bash
php artisan serve        # http://127.0.0.1:8000
curl http://127.0.0.1:8000/health
```

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

- **Entorno de producción.** Defina `APP_LOCALE=es` y `CACHE_STORE=database`. El contador del límite de peticiones vive en el almacén de caché; con `database` se comparte entre las copias del Gateway (RNF05) y hay que haber migrado la tabla `cache` (`php artisan migrate`). Con otros almacenes locales (`array`, `file`) cada copia contaría por separado. Todas las copias deben compartir el mismo `JWT_SECRET`, o no se reconocerán los tokens entre sí.
- **Limpieza de la caché.** El almacén `database` no elimina las filas vencidas de la tabla `cache`: solo borra una fila vencida cuando se vuelve a leer esa misma clave, y Laravel no trae un comando de Artisan que pode el resto. Programe una limpieza periódica fuera de la aplicación, por ejemplo con un CronJob de Kubernetes que ejecute `DELETE FROM cache WHERE expiration <= UNIX_TIMESTAMP();`.
- **IP real del cliente.** El límite de 10 intentos de inicio de sesión por IP depende de que la aplicación vea la IP real del cliente. Hoy `bootstrap/app.php` no configura proxies de confianza: detrás de un Ingress o de un balanceador, todos los clientes llegarían con la IP de ese intermediario y compartirían un único contador de 10 intentos por minuto. Antes de desplegar detrás de uno, configure `$middleware->trustProxies(at: [...])` en `bootstrap/app.php`, limitado al CIDR del Ingress; nunca `'*'`, porque entonces cualquier cliente podría falsear su IP con `X-Forwarded-For`.
- **Imagen del contenedor.** Cuando se contenerice, la imagen debe incluir `openapi.yaml`, `resources/docs/swagger-ui.html` y `lang/`. Si falta alguno, `/docs` o los mensajes de validación fallan.
- **Único punto de entrada (RNF09).** El Gateway es el único componente accesible desde fuera del clúster. Los microservicios confían en las cabeceras `X-User-*` que él añade, así que solo deben ser alcanzables desde dentro del clúster.
