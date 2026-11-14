# ms-catalogo

Productos, categorías y subcategorías; búsqueda y filtrado.

- **Framework:** Laravel 12 (PHP ≥ 8.2) · **Base de datos:** MySQL · **Puerto en el clúster:** 8000
- **Requerimientos:** RF01, RF02, RF12 (y la carga masiva de productos de RF16)
- **Entidades:** `Categoria` (tabla `categorias`, se relaciona consigo misma para las subcategorías) y `Producto`
  (tabla `productos`), según el modelo entidad-relación de la Entrega 2

## Reglas de negocio

- El `codigo` del producto es único y no se puede editar.
- Los productos no se borran: se inactivan y se vuelven a activar (`estado` ACTIVO/INACTIVO).
- Las categorías tienen **dos niveles**: categoría principal y subcategoría. Un producto puede pertenecer a cualquiera
  de las dos.
- Una categoría se borra (borrado real) solo si no tiene productos ni subcategorías.
- El proveedor de un producto vive en ms-proveedores. Este servicio no lo guarda: lo consulta para el filtro
  `?id_proveedor` (RF12).
- El servicio **no revisa roles**: el Gateway ya lo hizo antes de reenviar la petición, y el servicio solo es accesible
  dentro del clúster.

## Rutas

Las rutas no llevan el prefijo `/api`: el Gateway lo quita al reenviar (`GET /api/productos` llega como
`GET /productos`). La documentación completa, con esquemas y ejemplos, está en `GET /docs`.

| Método | Ruta | Respuesta | Errores |
| --- | --- | --- | --- |
| `GET` | `/productos?nombre&codigo&id_categoria&id_proveedor&estado&pagina&por_pagina` | 200 listado paginado | 422 filtros no válidos; 503 si se filtra por proveedor y ms-proveedores no responde |
| `GET` | `/productos/{id}` | 200 producto | 404 |
| `POST` | `/productos` | 201 producto `ACTIVO` | 404 categoría inexistente; 409 `CODIGO_DUPLICADO`; 422 |
| `PUT` | `/productos/{id}` | 200 producto (si llega `codigo`, se ignora) | 404 producto o categoría; 422 |
| `POST` | `/productos/{id}/inactivar` | 200 | 404 |
| `POST` | `/productos/{id}/activar` | 200 | 404 |
| `GET` | `/categorias?id_categoria_padre&arbol` | 200 lista sin paginar | 422 |
| `GET` | `/categorias/{id}` | 200 categoría | 404 |
| `POST` | `/categorias` | 201 categoría o subcategoría | 404 padre inexistente; 409 `NOMBRE_DUPLICADO`; 422 |
| `PUT` | `/categorias/{id}` | 200 categoría | 404; 409; 422 |
| `DELETE` | `/categorias/{id}` | 204 | 404; 409 `CATEGORIA_EN_USO` |
| `POST` | `/internas/productos/lote` | 200 `{creados, rechazados: [{fila, motivo}]}` | 422 lista vacía |
| `GET` | `/health` | 200 `{estado: ok, servicio}`; 503 si MySQL no responde | — |
| `GET` | `/docs` y `/docs/openapi.yaml` | Swagger UI y el documento OpenAPI | — |

Convenciones comunes de la Entrega 2 (sección 4.1): errores con la forma `{"error": {"codigo", "mensaje", "detalles"}}`,
listados con `{"datos": [...], "meta": {"pagina", "por_pagina", "total"}}` (`por_pagina` por defecto 20, máximo 100) y
fechas en ISO 8601 UTC.

### Decisiones que precisan el contrato

La Entrega 2 no define estos detalles; se acordaron al implementar el servicio:

| Tema | Decisión |
| --- | --- |
| Validación de productos | Obligatorios `codigo` (máx. 30), `nombre` (150), `id_categoria`, `unidad_medida` (texto libre, 20) y `precio` (número ≥ 0, `decimal(12,2)`). `descripcion` (500) es opcional; si no llega en el `PUT`, queda vacía |
| Validación de categorías | `nombre` obligatorio (100); `descripcion` (255) e `id_categoria_padre` opcionales. El `PUT` reemplaza todos los datos |
| Dos niveles | Responden 422 en `id_categoria_padre`: una categoría como su propia padre, un padre que ya es subcategoría y una categoría con subcategorías que pasa a ser subcategoría |
| Nombre de categoría | Único dentro del mismo nivel (entre las principales o entre las hijas de una misma categoría) |
| Listado de categorías | Lista plana ordenada por nombre. `?id_categoria_padre`, solo las hijas de esa categoría. `?arbol=true`, solo las principales, cada una con `subcategorias` |
| Filtros de productos | `nombre` y `codigo` contienen el texto; `id_categoria` incluye los productos de sus subcategorías; los filtros se combinan |
| Filtro por proveedor | Si ms-proveedores responde 404 (el proveedor no existe), el listado sale vacío con 200 |
| Formato del producto | `precio` como número (`2500.5`), no como texto |
| Inactivar o activar sin cambio | Si el producto ya está en ese estado, responde 200 sin cambios |
| Carga masiva | Éxito parcial: se guardan las filas válidas y las demás se reportan. `fila` empieza en 1. Cada fila usa las mismas reglas de `POST /productos`. Si un código se repite (en la base o en el mismo lote), gana la primera aparición. `creados` es un número y `motivo` reúne todos los errores de la fila. `id_categoria` llega ya convertido por ms-reportes (Tabla 13) |

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Recibe | ms-inventario | `GET /productos/{id}` (confirmar que el producto existe) |
| Recibe | ms-reportes | `GET /productos`, `GET /categorias`, `POST /internas/productos/lote` (carga masiva, RF16) |
| Hace | ms-proveedores | `GET /proveedores/{id}/productos` (filtro por proveedor, RF12; llamada 8) |

### Resiliencia en la llamada a ms-proveedores (RNF18)

Toda la comunicación con ms-proveedores está en `app/Services/ProveedoresCliente.php`:

- **Tiempo de espera:** 3 s por intento (conexión y respuesta).
- **Reintentos:** como es una consulta (repetirla no duplica nada), ante un fallo de conexión o un error 5xx se
  reintenta hasta 3 veces, con esperas de 0,2, 0,4 y 0,8 s. Un 4xx no se reintenta.
- **Cortacircuitos:** tras 5 llamadas fallidas seguidas, durante 30 s no se llama a ms-proveedores y se responde 503
  `SERVICIO_NO_DISPONIBLE` de inmediato. Pasado ese tiempo se vuelve a probar: si falla, se abre otra vez; si
  responde, el contador vuelve a 0.
- Se reenvía el `X-Request-Id` de la petición, para seguirla en los registros de los dos servicios.
- Si ms-proveedores cae, solo falla el filtro `?id_proveedor`; el resto del servicio sigue funcionando, y por eso
  `/health` no consulta a ms-proveedores.

**Notas:**

- El contador del cortacircuitos vive en la caché de Laravel (`CACHE_STORE=file`), así que **cada réplica lleva el
  suyo**. Es suficiente para el objetivo (no insistir sobre un servicio caído) sin agregar un almacén compartido.
- RNF18 se aplica tal cual, aunque el Gateway espera como máximo 3 s por la respuesta de este servicio. En el peor caso
  (ms-proveedores no contesta), el primer intento ya agota esos 3 s y el Gateway responde 503 `SERVICIO_NO_DISPONIBLE`
  antes de que terminen los reintentos. Los reintentos sí ayudan ante fallos rápidos (conexión rechazada, 5xx), que es el caso más común cuando
  un pod se reinicia, y el cortacircuitos evita que las siguientes peticiones esperen.

## Estructura (RNF13)

| Capa | Dónde |
| --- | --- |
| Rutas | `routes/api.php` (operaciones del contrato) y `routes/internal.php` (`/health` y `/docs`) |
| Controladores | `app/Http/Controllers`: validan la petición y arman la respuesta |
| Lógica de negocio | `app/Services`: `CategoriaService`, `ProductoService` (incluye las reglas de validación, reutilizadas en la carga masiva) y `ProveedoresCliente` (llamada a ms-proveedores) |
| Acceso a datos | `app/Models` y `database/migrations` |
| Transversal | `app/Http/Middleware/RegistrarPeticion` (registro), `app/Exceptions/ApiException` y `bootstrap/app.php` (forma común de error), `app/Http/Support/Paginated` (listados) |

## Requisitos

- PHP 8.2 o superior con las extensiones `pdo_mysql` (ejecución), `pdo_sqlite` (pruebas), `mbstring`, `xml` y `curl`.
- Composer 2.
- Docker, para la base MySQL local.
- Para medir la cobertura de las pruebas: la extensión `pcov` (en Ubuntu, `sudo apt install php8.5-pcov`, según la
  versión de PHP).

## Instalación y ejecución

Desde la raíz del repositorio:

```bash
cp .env.example .env                  # .env de la raíz, para docker-compose
docker compose up -d db-ms-catalogo   # MySQL en 127.0.0.1:3308

cd services/ms-catalogo
composer install
cp .env.example .env                  # los valores por defecto ya apuntan a esa base
php artisan key:generate
php artisan migrate
php artisan serve --port=8002         # http://127.0.0.1:8002/docs
```

Si cambia `CATALOGO_DB_PASSWORD` en el `.env` de la raíz, cambie también `DB_PASSWORD` en el `.env` del servicio.

Para usar el filtro `?id_proveedor` en local, ms-proveedores debe estar corriendo (por ejemplo con
`php artisan serve --port=8001`) y `MS_PROVEEDORES_URL` debe apuntar a él (`http://127.0.0.1:8001`). Sin él, ese filtro
responde 503 y lo demás funciona.

## Variables de entorno (RNF14)

| Variable | Uso |
| --- | --- |
| `APP_NAME` | Nombre del servicio en los registros (`ms-catalogo`) |
| `APP_KEY` | Clave de la aplicación (`php artisan key:generate`) |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | Conexión a MySQL |
| `MS_PROVEEDORES_URL` | Dirección de ms-proveedores. En el clúster, `http://ms-proveedores:8000` |
| `CACHE_STORE` | Dónde se guarda el contador del cortacircuitos (`file`) |
| `LOG_CHANNEL`, `LOG_LEVEL` | Registros; `json_stderr` escribe una línea JSON por registro en la salida de errores |

## Registros (RNF10)

Cada petición a las rutas del contrato deja una línea JSON con `servicio`, `request_id`, `metodo`, `ruta`, `estado`,
`id_usuario` (de `X-User-Id`) y `duracion_ms`. El `request_id` es el `X-Request-Id` que envía el Gateway (o el servicio
que hace la llamada interna), para seguir una misma operación en todos los componentes; si no llega, se genera uno.
También se devuelve en la cabecera `X-Request-Id` de la respuesta y se reenvía a ms-proveedores. `/health` y `/docs` no
se registran.

Las fallas de ms-proveedores dejan un registro `servicio_no_disponible` (con el estado recibido y los fallos seguidos), y
la apertura del cortacircuitos, un registro `cortacircuitos_abierto`.

## Pruebas (RNF20)

```bash
php artisan test                        # solo las pruebas
php artisan test --coverage --min=60    # con cobertura (requiere pcov)
```

Las pruebas usan SQLite en memoria (`phpunit.xml`), así que no necesitan MySQL. ms-proveedores se simula con
`Http::fake()`, sin red. Cubren categorías, productos, el filtro por proveedor con sus reintentos y el cortacircuitos,
la carga masiva, `/health`, `/docs`, la forma común de error y `X-Request-Id` (`tests/Feature`).

Cobertura actual: **98,8 %** (38 pruebas); RNF20 exige al menos 60 %.

## Docker (RNF03)

La imagen sirve la aplicación con **Apache y PHP 8.4** (`php:8.4-apache`), con el usuario `www-data` en el puerto
8000. Instala las dependencias con Composer sin las de desarrollo y no lleva el `.env`, las pruebas ni `vendor/` del
equipo (`.dockerignore`). Trae fijos los valores que no son secretos del `.env.example` (`APP_NAME`, `LOG_CHANNEL`,
`CACHE_STORE=file`, `MS_PROVEEDORES_URL=http://ms-proveedores:8000`...) con `APP_ENV=production` y `APP_DEBUG=false`;
el resto llega por variables de entorno. Apache no escribe su propio registro de accesos (incluiría la cadena de
consulta): cada petición la registra la aplicación en JSON. Tiene un `HEALTHCHECK` que consulta `/health`.

Desde `services/ms-catalogo`, con la base del `docker-compose.yml` levantada (`docker compose up -d db-ms-catalogo`
desde la raíz):

```bash
docker build -t ms-catalogo .

# Dentro de la red del compose, la base se llama db-ms-catalogo y escucha en el 3306.
VARIABLES="-e APP_KEY=base64:$(openssl rand -base64 32) -e DB_HOST=db-ms-catalogo -e DB_DATABASE=catalogo_db -e DB_USERNAME=catalogo -e DB_PASSWORD=change_me"

docker run --rm --network gestor-inventario_default $VARIABLES ms-catalogo php artisan migrate --force   # crea las tablas
docker run -d --name ms-catalogo --network gestor-inventario_default $VARIABLES -p 127.0.0.1:8002:8000 ms-catalogo
```

El servicio queda en `http://127.0.0.1:8002/docs`. Para el filtro `?id_proveedor`, el contenedor de ms-proveedores
debe estar en la misma red con el nombre `ms-proveedores` (ver el README de ms-proveedores), o se cambia
`MS_PROVEEDORES_URL` con `-e`. Las migraciones no se aplican solas al arrancar: se ejecutan una vez con
`php artisan migrate --force`, como arriba, antes de iniciar el servicio (con varias réplicas, que arranquen todas a
la vez no debe aplicar la misma migración varias veces). `APP_KEY` debe ser la misma en todas las réplicas.

## Pendiente

- Manifiestos de Kubernetes.
