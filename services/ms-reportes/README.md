# ms-reportes

Reportes, panel de indicadores, panel de auditoría, exportación a CSV y PDF e importación masiva validada.

- **Framework:** Flask 3 (Python ≥ 3.12) · **Base de datos:** PostgreSQL · **Puerto en el clúster:** 5000
- **Requerimientos:** RF11, RF14, RF15, RF16
- **Entidades:** `Importacion` (tabla `importaciones`) y `ErrorImportacion` (tabla `errores_importacion`), según el
  modelo entidad-relación de la Entrega 2 (Figura 8)
- No guarda los reportes: los calcula al momento con datos de los demás servicios. Su base de datos solo guarda las
  importaciones masivas.

## Librerías

| Uso | Librería |
| --- | --- |
| Aplicación web | Flask, python-dotenv (lee el `.env`) y gunicorn (servidor de producción, en la imagen Docker) |
| Modelos y migraciones | Flask-SQLAlchemy, Flask-Migrate (Alembic) y `psycopg` para PostgreSQL |
| Llamadas a otros servicios | requests (los reintentos y el cortacircuitos están escritos en el servicio) |
| Lectura de Excel | openpyxl (los CSV se leen con el módulo `csv` de Python) |
| PDF | fpdf2 |
| Pruebas | pytest y pytest-cov |

Las versiones exactas están en `requirements.txt` (lo que lleva la imagen) y `requirements-dev.txt` (además, las
pruebas).

## Rutas

Las rutas no llevan el prefijo `/api`: el Gateway lo quita al reenviar (`GET /api/importaciones` llega como
`GET /importaciones`). El servicio no revisa roles: el Gateway ya lo hizo. La documentación completa, con esquemas y
ejemplos, está en `GET /docs`.

| Método | Ruta | Respuesta | Errores |
| --- | --- | --- | --- |
| `GET` | `/reportes/existencias?id_bodega&id_categoria&formato` | 200 existencias por producto y bodega | 422; 503 |
| `GET` | `/reportes/valorizacion?id_bodega&formato` | 200 `{productos, valor_total}` | 422; 503 |
| `GET` | `/reportes/rotacion?fecha_desde&fecha_hasta&limite&formato` | 200 `{mayor_rotacion, menor_rotacion}` | 422 fechas faltantes o rango no válido; 503 |
| `GET` | `/reportes/kardex?id_producto&id_bodega&id_usuario&tipo&fecha_desde&fecha_hasta&formato` | 200 movimientos | 422; 503 |
| `GET` | `/indicadores?fecha_desde&fecha_hasta` | 200 `{valor_total, productos_bajo_umbral, productos_agotados, proximos_a_vencer, mayor_rotacion, ordenes_pendientes, no_disponibles}` | 422; 503 |
| `POST` | `/importaciones` (multipart: `tipo`, `archivo`; cabecera `X-User-Id`) | 201 importación con sus errores | 400 sin `X-User-Id`; 422 formato no soportado, faltan columnas o archivo vacío |
| `GET` | `/importaciones?tipo&pagina&por_pagina` | 200 listado paginado, más recientes primero | 422 |
| `GET` | `/importaciones/{id}` | 200 importación con sus errores por fila | 404 |
| `GET` | `/health` | 200 `{estado: ok, servicio}`; 503 si PostgreSQL no responde | — |
| `GET` | `/docs` y `/docs/openapi.yaml` | Swagger UI y el documento OpenAPI | — |

`?formato` admite `json` (por defecto), `csv` o `pdf`; con `csv` o `pdf` la respuesta es un archivo para descargar
(por ejemplo `kardex-2026-11-14.pdf`). Convenciones comunes de la Entrega 2 (sección 4.1): errores con la forma
`{"error": {"codigo", "mensaje", "detalles"}}`, listados con `{"datos": [...], "meta": {"pagina", "por_pagina", "total"}}`
(`por_pagina` por defecto 20, máximo 100) y fechas en ISO 8601 UTC. Los filtros de fecha usan el formato `AAAA-MM-DD`.

### Decisiones que precisan el contrato

La Entrega 2 no define estos detalles; se acordaron al implementar el servicio.

**Reportes e indicadores**

| Tema | Decisión |
| --- | --- |
| Rotación | Cuenta solo los movimientos `SALIDA` del periodo (no traslados, ajustes ni devoluciones). Entran todos los productos ACTIVOS, con 0 si no tuvieron salidas. `limite` por defecto 10, máximo 100 |
| Existencias | `id_categoria` incluye sus subcategorías, igual que la búsqueda de productos (RF12) |
| Valorización | Cantidad en existencia por el precio del producto en ms-catalogo; sin `id_bodega`, suma las dos bodegas. Las cuentas se hacen con `Decimal` |
| Kardex | Los mismos filtros de `GET /movimientos`, sin paginar, con el código y el nombre del producto y el nombre de la bodega |
| Indicadores: periodo | Solo afecta a `mayor_rotacion` (los 5 primeros). Sin `fecha_hasta` termina hoy; sin `fecha_desde` empieza 30 días antes. Los demás indicadores son del momento |
| `proximos_a_vencer` | Lotes con existencia que vencen en los próximos 30 días |
| `productos_agotados` | Productos ACTIVOS cuya suma en las dos bodegas es 0, también los que no tienen saldo |
| `ordenes_pendientes` | Órdenes en estado `ENVIADA` o `RECIBIDA_PARCIAL` (las que esperan mercancía) |
| CSV | Separado por `;`, con coma decimal y en UTF-8 con BOM, para abrirse bien con Excel en español. Un texto que empieza por `=`, `+`, `-` o `@` se guarda con un apóstrofo delante, para que Excel no lo ejecute como fórmula |
| PDF | A4 horizontal con título, fecha de generación, filtros usados y tablas; números como `1.500,50` |

**Importación masiva (RF16)**

| Tema | Decisión |
| --- | --- |
| Archivo | Campos `tipo` y `archivo` del formulario. CSV en UTF-8 separado por `,` o `;`, o Excel `.xlsx` (primera hoja) |
| Columnas | La fila 1 es el encabezado y debe traer todas las columnas de la Tabla 13; no distingue mayúsculas y las columnas de más se ignoran. Las filas vacías se saltan |
| Validación | Cada fila se valida con las reglas del servicio destino (obligatorios, largos, números, correo, fecha `AAAA-MM-DD`), para señalar el campo exacto. `precio` y `cantidad` admiten coma decimal y separador de miles (`2500,5`, `2.500,50`, `2,500.50`) |
| Conversión | `categoria` por nombre exacto (sin distinguir mayúsculas); si dos categorías tienen ese nombre, la fila se rechaza. `codigo_producto` y `codigo_bodega` por código. Solo se convierten las filas sin errores de formato |
| `numero_fila` | El número de la fila en el archivo, como en Excel (la primera de datos es la 2). `numero_fila` 0 es un error de toda la importación |
| Errores | Uno por fila y campo. Las filas que rechaza el servicio destino quedan con `campo` vacío y su `motivo` como mensaje |
| Estados | `PROCESADA`: ninguna fila con error. `CON_ERRORES`: al menos una, aunque no se cree ninguna. `FALLIDA`: un servicio no respondió; se guarda igual y se responde 201 |
| Contadores | `filas_totales`: filas con datos. `filas_validas`: las que el servicio destino creó (en una `FALLIDA`, solo las de los bloques que alcanzó a confirmar). `filas_con_error`: filas con al menos un error |
| Bloques | Las filas válidas se envían en bloques de **1 000 como máximo** en los tres tipos (es el límite de la carga inicial de ms-inventario); el número de fila de cada rechazo se traduce al del archivo |
| Archivo repetido | La `Idempotency-Key` de la carga inicial se deriva del contenido de cada bloque (SHA-256): si se vuelve a subir un archivo que ya se aplicó, ms-inventario lo reconoce como repetición y **no vuelve a sumar los saldos**. ms-inventario reconoce la repetición por clave y usuario: si otro usuario sube el mismo archivo, sí se suma. Para cargar otra vez las mismas cantidades hay que cambiar el archivo |
| Usuario | `X-User-Id` es obligatorio (400 si falta): la ruta solo la usa el administrador a través del Gateway |
| Respuesta | `POST` devuelve también los `errores`, igual que el detalle, para que el cliente web los muestre sin otra petición |
| Archivo inutilizable | 422 sin guardar nada: formato no soportado, archivo dañado o vacío, CSV que no está en UTF-8 o faltan columnas |

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Hace (espera) | ms-inventario | `GET /saldos`, `/saldos/bajo-umbral`, `/movimientos`, `/lotes`, `/bodegas` |
| Hace (espera) | ms-catalogo | `GET /productos`, `GET /categorias` |
| Hace (espera) | ms-compras | `GET /ordenes-compra` |
| Hace (espera) | ms-catalogo, ms-proveedores, ms-inventario | `POST /internas/productos/lote`, `/internas/proveedores/lote`, `/internas/saldos/carga-inicial` (carga masiva) |

Los listados paginados (`/productos`, `/saldos`, `/movimientos`, `/lotes`, `/bodegas`) se piden completos, de 100 en
100. Todas
las llamadas reenvían el `X-Request-Id` de la petición y, si vienen, `X-User-Id` y `X-User-Rol`: `ms-inventario` los exige
en la carga inicial de saldos.

### Resiliencia (RNF18)

Toda la comunicación está en `app/clients/` y pasa por `app/clients/base.py`:

- **Tiempo de espera:** `CALL_TIMEOUT_SECONDS` (3 s) por intento. La carga inicial de ms-inventario aplica cada fila en
  su propia transacción (unos 5 s por cada 1 000 filas), así que su plazo es `CALL_TIMEOUT_SECONDS` más 10 ms por fila
  del bloque (1 000 filas: 13 s).
- **Reintentos:** solo las operaciones que no se duplican al repetirse: las consultas (`GET`) y la carga inicial de
  ms-inventario, que lleva `Idempotency-Key` (derivada del contenido de cada bloque). Ante un fallo de conexión o un 5xx se reintenta
  hasta 3 veces, con esperas de 0,2, 0,4 y 0,8 s; un 4xx no se reintenta. Las cargas masivas de ms-catalogo y
  ms-proveedores **no** se reintentan: repetirlas rechazaría como duplicadas las filas ya creadas.
- **Cortacircuitos:** uno por servicio. Tras 5 llamadas fallidas seguidas, durante 30 s no se le llama y se falla de
  inmediato; después se vuelve a probar.
- **Excepción, el panel de indicadores (RNF18):** si un servicio no responde, solo se pierden los indicadores que lo necesitan (salen en `null` y se listan en `no_disponibles`); responde 503 únicamente cuando no se puede calcular ninguno.
- Si la base de datos de ms-reportes no responde, solo fallan las importaciones (503): los reportes y el panel no la usan.
- Si un servicio no responde, los demás reportes responden 503 `SERVICIO_NO_DISPONIBLE` y la importación se guarda como
  `FALLIDA`. Una respuesta con otra forma (por ejemplo sin `datos` o sin `creados`) se trata igual.

**Notas:**

- El estado del cortacircuitos vive en la memoria del proceso, así que **cada réplica (y cada proceso) lleva el suyo**.
- **El Gateway espera como máximo 3 s por toda la petición.** Una importación grande, o un reporte que necesita muchas
  páginas de otro servicio, puede superar ese tiempo: el Gateway responde 503 aunque ms-reportes termine. En una
  importación, el resultado queda guardado y se puede consultar después en `GET /importaciones`.
- **Contratos de ms-inventario y ms-compras.** Al implementar este servicio, esos dos servicios aún no existían. Los
  reportes usan las rutas y los filtros de las Tablas 9 y 10 y los nombres de los atributos de las Figuras 5 y 6 (por
  ejemplo `cantidad_disponible`, `saldo_resultante`, `codigo` de la bodega). La integración con ms-inventario a través
  del Gateway ya se probó (issue #10); con ms-compras queda pendiente probarla cuando esté fusionado.

## Estructura (RNF13)

| Capa | Dónde |
| --- | --- |
| Rutas | `app/routes/`: `reportes.py`, `importaciones.py` y `operacion.py` (`/health`, `/docs`), como Blueprints de Flask. Validan la petición y arman la respuesta |
| Lógica de negocio | `app/services/`: `reporte_service.py` (cálculos) e `importacion_service.py` (pasos de la importación) |
| Acceso a datos | `app/repositories/importacion_repository.py` (la única capa que usa la sesión de la base), `app/models/` y `migrations/` |
| Llamadas a otros servicios | `app/clients/`: `base.py` (RNF18) y un módulo por servicio |
| Importación | `app/importers/`: `lector.py` (CSV y Excel) y `filas.py` (columnas y validación por tipo) |
| Exportación | `app/exports/`: `csv_export.py` y `pdf_export.py` |
| Transversal | `app/__init__.py` (`create_app`), `app/config.py` (variables de entorno), `app/errores.py` (forma común de error), `app/registro.py` (registro y `X-Request-Id`), `app/paginacion.py` y `app/validacion.py` |

## Requisitos

- Python 3.12 o superior, con el módulo `venv` (en Ubuntu: `sudo apt install python3-venv`).
- Docker, para la base PostgreSQL local.

## Instalación y ejecución

Desde la raíz del repositorio:

```bash
cp .env.example .env                    # .env de la raíz, para docker-compose
docker compose up -d db-ms-reportes     # PostgreSQL en 127.0.0.1:5436

cd services/ms-reportes
python3 -m venv .venv
source .venv/bin/activate               # en cada terminal nueva; el prompt muestra (.venv)
pip install -r requirements-dev.txt
cp .env.example .env                    # los valores por defecto ya apuntan a esa base
flask db upgrade                        # crea las tablas
flask run --port 5000                   # http://127.0.0.1:5000/docs
```

Si cambia `REPORTES_DB_PASSWORD` en el `.env` de la raíz, cambie también `DB_PASSWORD` en el `.env` del servicio.

Para usar los reportes y las importaciones en local, los demás servicios deben estar corriendo y las variables
`MS_*_URL` deben apuntar a ellos (por ejemplo `MS_CATALOGO_URL=http://127.0.0.1:8002`). Sin ellos, los reportes
responden 503 y las importaciones quedan `FALLIDA`; `/health`, `/docs` y la consulta de importaciones funcionan igual.

Si cambia un modelo, la migración se genera con `flask db migrate -m "descripción"` y se aplica con `flask db upgrade`.

## Docker (RNF03)

La imagen sirve la aplicación con **gunicorn** sobre `python:3.14-slim`, con un usuario sin privilegios (`USER 10001`, numérico para que Kubernetes lo acepte con `runAsNonRoot`). No lleva el
`.env`, las pruebas ni el entorno virtual (`.dockerignore`): toda la configuración llega por variables de entorno.
Incluye las migraciones y los archivos de `/docs`. Tiene un `HEALTHCHECK` que consulta `/health`.

Desde `services/ms-reportes`, con la base del `docker-compose.yml` levantada (`docker compose up -d db-ms-reportes`
desde la raíz):

```bash
docker build -t ms-reportes .

# Dentro de la red del compose, la base se llama db-ms-reportes y escucha en el 5432.
VARIABLES="-e DB_HOST=db-ms-reportes -e DB_PORT=5432 -e DB_NAME=reportes_db -e DB_USER=reportes -e DB_PASSWORD=change_me"

docker run --rm --network gestor-inventario_default $VARIABLES ms-reportes flask db upgrade   # crea las tablas
docker run -d --name ms-reportes --network gestor-inventario_default $VARIABLES -p 127.0.0.1:5000:5000 ms-reportes
```

El servicio queda en `http://127.0.0.1:5000/docs`. Las migraciones no se aplican solas al arrancar: se ejecutan una vez
con `flask db upgrade`, como arriba, antes de iniciar el servicio (con varias réplicas, que arranquen todas a la vez no
debe aplicar la misma migración varias veces). Para que los reportes funcionen, las variables `MS_*_URL` deben apuntar
a los demás servicios. `GUNICORN_WORKERS` (por defecto 2) cambia la cantidad de procesos; cada proceso lleva su propio
cortacircuitos.

## Variables de entorno (RNF14)

| Variable | Uso |
| --- | --- |
| `FLASK_APP` | Módulo de la aplicación (`app`), para `flask run` y `flask db` |
| `SERVICE_NAME` | Nombre del servicio en los registros y en `/health` (`ms-reportes`) |
| `PORT` | Puerto en el que escucha gunicorn en la imagen Docker (5000). `flask run` no lo lee: en local se indica con `--port` |
| `GUNICORN_WORKERS` | Procesos de gunicorn en la imagen Docker (2) |
| `LOG_LEVEL` | Nivel mínimo de los registros (`INFO`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Conexión a PostgreSQL |
| `MS_CATALOGO_URL`, `MS_PROVEEDORES_URL`, `MS_INVENTARIO_URL`, `MS_COMPRAS_URL` | Direcciones de los demás servicios. En el clúster, `http://<servicio>:<puerto>` |
| `CALL_TIMEOUT_SECONDS` | Tiempo máximo de cada intento de llamada a otro servicio (3) |

## Registros (RNF10)

Todos los registros van a la salida de errores, una línea JSON por registro, con la misma forma que en los servicios
Laravel (`message`, `context`, `level_name`, `datetime`). Cada petición a las rutas del contrato deja una línea
`peticion` con `servicio`, `request_id`, `metodo`, `ruta`, `estado`, `id_usuario` (de `X-User-Id`) y `duracion_ms`.
El `request_id` es el `X-Request-Id` que envía el Gateway (si no llega o no es válido, se genera uno); se devuelve en
la respuesta y se reenvía a los demás servicios. Nunca se registra el cuerpo, la cadena de consulta ni las cabeceras.
`/health` y `/docs` no se registran.

Otros registros: `error_interno` (con la traza, en un 500), `servicio_no_disponible` (destino, estado y fallos
seguidos), `cortacircuitos_abierto`, `respuesta_no_valida` y `base_de_datos_no_disponible`.

## Pruebas

```bash
pytest                                        # solo las pruebas
pytest --cov=app --cov-report=term-missing    # con cobertura
```

Las pruebas usan SQLite en memoria, así que no necesitan PostgreSQL. Los demás servicios se simulan reemplazando
`requests.request` (`tests/simulacion.py`), sin red, y los reintentos no esperan de verdad. Cubren las importaciones
(los tres tipos, los estados, los reintentos y los archivos no válidos), los reportes y los indicadores con sus
exportaciones, RNF18 (reintentos y cortacircuitos), `/health`, `/docs`, la forma común de error y `X-Request-Id`.

Cobertura actual: **98 %** (55 pruebas). RNF20 no exige cobertura para este servicio.

## Pendiente

- Probar los reportes y la carga de stock inicial contra ms-inventario y ms-compras cuando estén implementados.
- Manifiestos de Kubernetes.
