# ms-proveedores

Proveedores y su relación con los productos que suministran.

- **Framework:** Laravel 12 (PHP ≥ 8.2) · **Base de datos:** MySQL · **Puerto en el clúster:** 8000
- **Requerimientos:** RF03 (y la carga masiva de proveedores de RF16)
- **Entidades:** `Proveedor` (tabla `proveedores`) y `ProveedorProducto` (tabla `proveedor_producto`), según el modelo
  entidad-relación de la Entrega 2 (Figura 4)

## Reglas de negocio

- El NIT es único y no se puede editar.
- Los proveedores no se borran: se inactivan y se vuelven a activar (`estado` ACTIVO/INACTIVO).
- `ProveedorProducto` guarda solo `id_producto`, una referencia a ms-catalogo **sin clave foránea** (RNF02). Al
  asociar un producto no se consulta a ms-catalogo; el cliente web lo toma del catálogo.
- Las asociaciones con productos sí se borran (borrado real), porque no tienen historia.
- El servicio **no revisa roles**: el Gateway ya lo hizo antes de reenviar la petición, y el servicio solo es accesible
  dentro del clúster.

## Rutas

Las rutas no llevan el prefijo `/api`: el Gateway lo quita al reenviar (`GET /api/proveedores` llega como
`GET /proveedores`). La documentación completa, con esquemas y ejemplos, está en `GET /docs`.

| Método | Ruta | Respuesta | Errores |
| --- | --- | --- | --- |
| `GET` | `/proveedores?nit&razon_social&id_producto&estado&pagina&por_pagina` | 200 listado paginado | 422 filtros no válidos |
| `GET` | `/proveedores/{id}` | 200 proveedor | 404 |
| `POST` | `/proveedores` | 201 proveedor `ACTIVO` | 409 `NIT_DUPLICADO`; 422 |
| `PUT` | `/proveedores/{id}` | 200 proveedor (si llega `nit`, se ignora) | 404; 422 |
| `POST` | `/proveedores/{id}/inactivar` | 200 | 404 |
| `POST` | `/proveedores/{id}/activar` | 200 | 404 |
| `GET` | `/proveedores/{id}/productos` | 200 `[{id_proveedor_producto, id_producto, fecha_asociacion}]` | 404 |
| `POST` | `/proveedores/{id}/productos` | 201 asociación | 404; 409 `PRODUCTO_YA_ASOCIADO`; 422 |
| `DELETE` | `/proveedores/{id}/productos/{id_producto}` | 204 | 404 |
| `POST` | `/internas/proveedores/lote` | 200 `{creados, rechazados: [{fila, motivo}]}` | 422 lista vacía |
| `GET` | `/health` | 200 `{estado: ok, servicio}`; 503 si MySQL no responde | — |
| `GET` | `/docs` y `/docs/openapi.yaml` | Swagger UI y el documento OpenAPI | — |

Convenciones comunes de la Entrega 2 (sección 4.1): errores con la forma `{"error": {"codigo", "mensaje", "detalles"}}`,
listados con `{"datos": [...], "meta": {"pagina", "por_pagina", "total"}}` (`por_pagina` por defecto 20, máximo 100) y
fechas en ISO 8601 UTC.

### Decisiones que precisan el contrato

La Entrega 2 no define estos detalles; se acordaron al implementar el servicio:

| Tema | Decisión |
| --- | --- |
| Validación | Todos los campos del proveedor son obligatorios. Largos máximos: `nit` 20, `razon_social` 150, `nombre_contacto` 100, `telefono` 20, `correo` 255 (con formato de correo), `direccion` 255 |
| Filtros del listado | `nit` exacto; `razon_social` contiene el texto; `id_producto`, proveedores que tienen asociado ese producto |
| Inactivar o activar sin cambio | Si el proveedor ya está en ese estado, responde 200 sin cambios |
| Asociar a un proveedor inactivo | Se permite |
| Carga masiva | Éxito parcial: se guardan las filas válidas y las demás se reportan. `fila` empieza en 1. Cada fila usa las mismas reglas de `POST /proveedores`. Si un NIT se repite (en la base o en el mismo lote), gana la primera aparición. `creados` es un número y `motivo` reúne todos los errores de la fila |

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Recibe | ms-catalogo | `GET /proveedores/{id}/productos` (filtro de productos por proveedor, RF12) |
| Recibe | ms-reportes | `POST /internas/proveedores/lote` (carga masiva, RF16) |

No llama a ningún otro servicio.

## Estructura (RNF13)

| Capa | Dónde |
| --- | --- |
| Rutas | `routes/api.php` (operaciones del contrato) y `routes/internal.php` (`/health` y `/docs`) |
| Controladores | `app/Http/Controllers`: validan la petición y arman la respuesta |
| Lógica de negocio | `app/Services`: `ProveedorService` (incluye las reglas de validación, reutilizadas en la carga masiva) y `ProveedorProductoService` |
| Acceso a datos | `app/Models` y `database/migrations` |
| Transversal | `app/Http/Middleware/RegistrarPeticion` (registro), `app/Exceptions/ApiException` y `bootstrap/app.php` (forma común de error), `app/Http/Support/Paginated` (listados) |

## Requisitos

- PHP 8.2 o superior con las extensiones `pdo_mysql` (ejecución), `pdo_sqlite` (pruebas), `mbstring` y `xml`.
- Composer 2.
- Docker, para la base MySQL local.

## Instalación y ejecución

Desde la raíz del repositorio:

```bash
cp .env.example .env                     # .env de la raíz, para docker-compose
docker compose up -d db-ms-proveedores   # MySQL en 127.0.0.1:3309

cd services/ms-proveedores
composer install
cp .env.example .env                     # los valores por defecto ya apuntan a esa base
php artisan key:generate
php artisan migrate
php artisan serve --port=8001            # http://127.0.0.1:8001/docs
```

Si cambia `PROVEEDORES_DB_PASSWORD` en el `.env` de la raíz, cambie también `DB_PASSWORD` en el `.env` del servicio.

## Variables de entorno (RNF14)

| Variable | Uso |
| --- | --- |
| `APP_NAME` | Nombre del servicio en los registros y en `/health` (`ms-proveedores`) |
| `APP_KEY` | Clave de la aplicación (`php artisan key:generate`) |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | Conexión a MySQL |
| `LOG_CHANNEL`, `LOG_LEVEL` | Registros; `json_stderr` escribe una línea JSON por registro en la salida de errores |

## Registros (RNF10)

Cada petición a las rutas del contrato deja una línea JSON con `servicio`, `request_id`, `metodo`, `ruta`, `estado`,
`id_usuario` (de `X-User-Id`) y `duracion_ms`. El `request_id` es el `X-Request-Id` que envía el Gateway (o el servicio
que hace la llamada interna), para seguir una misma operación en todos los componentes; si no llega, se genera uno.
También se devuelve en la cabecera `X-Request-Id` de la respuesta. `/health` y `/docs` no se registran.

## Pruebas

```bash
php artisan test
```

Las pruebas usan SQLite en memoria (`phpunit.xml`), así que no necesitan MySQL. Cubren los endpoints de proveedores,
asociaciones, carga masiva, `/health`, `/docs`, la forma común de error y `X-Request-Id` (`tests/Feature`).

## Docker (RNF03)

La imagen sirve la aplicación con **Apache y PHP 8.4** (`php:8.4-apache`), con el usuario `www-data` en el puerto
8000. Instala las dependencias con Composer sin las de desarrollo y no lleva el `.env`, las pruebas ni `vendor/` del
equipo (`.dockerignore`). Trae fijos los valores que no son secretos del `.env.example` (`APP_NAME`, `LOG_CHANNEL`,
`CACHE_STORE`...) con `APP_ENV=production` y `APP_DEBUG=false`; el resto llega por variables de entorno. Apache no
escribe su propio registro de accesos (incluiría la cadena de consulta): cada petición la registra la aplicación en
JSON. Tiene un `HEALTHCHECK` que consulta `/health`.

Desde `services/ms-proveedores`, con la base del `docker-compose.yml` levantada (`docker compose up -d
db-ms-proveedores` desde la raíz):

```bash
docker build -t ms-proveedores .

# Dentro de la red del compose, la base se llama db-ms-proveedores y escucha en el 3306.
VARIABLES="-e APP_KEY=base64:$(openssl rand -base64 32) -e DB_HOST=db-ms-proveedores -e DB_DATABASE=proveedores_db -e DB_USERNAME=proveedores -e DB_PASSWORD=change_me"

docker run --rm --network gestor-inventario_default $VARIABLES ms-proveedores php artisan migrate --force   # crea las tablas
docker run -d --name ms-proveedores --network gestor-inventario_default $VARIABLES -p 127.0.0.1:8001:8000 ms-proveedores
```

El servicio queda en `http://127.0.0.1:8001/docs`. Las migraciones no se aplican solas al arrancar: se ejecutan una vez
con `php artisan migrate --force`, como arriba, antes de iniciar el servicio (con varias réplicas, que arranquen todas a
la vez no debe aplicar la misma migración varias veces). `APP_KEY` debe ser la misma en todas las réplicas.

## Pendiente

- Manifiestos de Kubernetes.
