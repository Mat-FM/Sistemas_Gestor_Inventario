# ms-notificaciones

Alertas en la interfaz y por correo; revisión diaria de vencimientos y de productos bajo el umbral.

- **Framework:** Flask (Python) · **Base de datos:** PostgreSQL · **Puerto en el clúster:** 5000
- **Requerimientos:** RF09, RF17
- **Entidades:** `Notificacion`, `Preferencia`, `Configuracion` (un solo registro: días de anticipación y hora de la revisión diaria)
- Tipos de notificación: STOCK_BAJO, VENCIMIENTO, ORDEN_RECIBIDA. Se dirigen por defecto al rol ADMINISTRADOR.
- Si ya existe una alerta sin leer del mismo tipo y producto para el rol, no se crea otra (índice único parcial
  `uq_notificacion_sin_leer`). Las ORDEN_RECIBIDA no traen producto y no se agrupan.

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Recibe (aviso) | ms-inventario, ms-compras | `POST /internas/notificaciones` |
| Hace (espera) | ms-inventario | `GET /lotes`, `GET /saldos/bajo-umbral` (revisión diaria) |
| Hace (aviso) | servidor de correo externo | Envío del correo |

Cada llamada a ms-inventario espera como máximo 3 s y, como son consultas, se reintenta hasta tres veces
(0,2 s, 0,4 s y 0,8 s). Tras 5 fallos seguidos el cortacircuito deja de llamarlo durante 30 s (RNF18); `/health`
muestra su estado. **Si ms-inventario no existe o no responde, la revisión diaria solo registra el fallo y
termina**: las rutas del servicio siguen funcionando.

## Rutas (Entrega 2, Tabla 11)

| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/notificaciones` | Notificaciones del rol de `X-User-Rol`, de la más reciente a la más antigua; filtros `leida`, `tipo`, `pagina`, `por_pagina` |
| POST | `/notificaciones/{id}/leida` | Marca la notificación como leída (404 si no existe o es de otro rol) |
| GET | `/preferencias/mia` | Preferencia de correo del usuario; si no la ha guardado, `recibir_correo` es falso |
| PUT | `/preferencias/mia` | `{"correo"?, "recibir_correo"}`; 422 si quiere recibir correos y no hay correo. Guarda también el rol |
| GET | `/configuracion-alertas` | `{"dias_anticipacion_vencimiento", "hora_revision_diaria"}` (solo ADM, lo controla el Gateway) |
| PUT | `/configuracion-alertas` | Cambia la configuración (1 a 365 días, hora `HH:MM`) y reprograma la revisión diaria |
| POST | `/internas/notificaciones` | Aviso de otro servicio: `{tipo, mensaje, id_producto?, id_bodega?, rol_destinatario?}` → 202 |
| GET | `/health` | Estado del servicio, de la base de datos y del cortacircuito |
| GET | `/docs` | Documentación OpenAPI (Swagger UI); la especificación está en `openapi.json` |

`POST /internas/notificaciones` responde `{"aceptada": true, "duplicada": false, "notificacion": {...}}`, o
`{"aceptada": true, "duplicada": true, "notificacion": null}` si ya había una igual sin leer. El Gateway no la publica.

### Cabeceras que llegan del Gateway

`X-User-Id`, `X-User-Rol` y `X-Request-Id`. Las rutas públicas exigen `X-User-Id` y `X-User-Rol` (401 si faltan):
cada usuario ve y marca solo las notificaciones dirigidas a su rol. Los roles por ruta los comprueba el Gateway y el servicio **los repite**
(`app/permisos.py`, defensa en profundidad): un rol que no corresponde es 403 `SIN_PERMISO`; el aviso interno es de ADMINISTRADOR y OPERADOR_BODEGA,
que son quienes registran movimientos y recepciones.

### Correo

Al crear una alerta, se envía en segundo plano a los usuarios del rol que activaron `recibir_correo` (en copia
oculta). Si el envío falla, la alerta sigue visible en la interfaz y `correo_enviado` queda en falso. Sin `SMTP_HOST`
y `MAIL_FROM` no se envía nada.

### Revisión diaria

Un hilo del mismo proceso duerme hasta `hora_revision_diaria` (hora de Colombia en la imagen), pide a ms-inventario
los lotes con existencia que vencen dentro de `dias_anticipacion_vencimiento` días y los productos bajo el umbral, y
crea las alertas VENCIMIENTO y STOCK_BAJO que falten. Por eso la imagen corre Gunicorn con **un solo proceso** y
varios hilos. Para lanzarla a mano: `flask --app app:crear_app revision-diaria`.

## Estructura interna (RNF13)

```text
wsgi.py                   Arranque: migraciones pendientes, revisión diaria y app para Gunicorn
app/
  __init__.py             Fábrica de la aplicación Flask (crear_app)
  routes/                 Blueprints → services → repositories
  services/               Reglas de negocio (duplicados, preferencias, configuración, correo)
  repositories/           SQL contra la base propia (psycopg 3)
  clients/                ms-inventario (espera máxima, reintentos y cortacircuito) y servidor de correo
  jobs/                   Revisión diaria
  contexto.py, logger.py  Cabeceras X-User-*, X-Request-Id y registros JSON (RNF10)
  errores.py, manejo_errores.py, validacion.py
migrations/               Archivos .sql que aplica app/migrar.py
tests/                    Pruebas con pytest (y un ms-inventario falso)
```

## Ejecutar en el computador

Requisitos: Python 3.12 y Docker (para la base de datos).

```bash
# Desde la raíz del repositorio: levanta la base de datos de notificaciones
docker compose up -d db-ms-notificaciones

# Desde services/ms-notificaciones
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env          # poner en MS_INVENTARIO_URL la dirección de ms-inventario
set -a && . ./.env && set +a
flask --app wsgi run --port 5000    # aplica las migraciones; http://localhost:5000/docs
```

## Ejecutar con Docker Compose

```bash
docker compose up -d --build ms-notificaciones    # levanta también su base de datos
```

El servicio queda en `http://localhost:5001` (solo para pruebas locales; en el sistema real se entra por el Gateway).
Llama a `http://ms-inventario:3000`, el mismo nombre del clúster. Para otra dirección o para el correo se usan
`NOTIFICACIONES_INVENTARIO_URL` y `NOTIFICACIONES_SMTP_HOST`, `NOTIFICACIONES_SMTP_PORT`, `NOTIFICACIONES_SMTP_USER`,
`NOTIFICACIONES_SMTP_PASSWORD` y `NOTIFICACIONES_MAIL_FROM` en el `.env` de la raíz.

## Pruebas

Necesitan una base PostgreSQL vacía llamada `notificaciones_test` (las pruebas la limpian al empezar):

```bash
docker compose exec db-ms-notificaciones createdb -U notificaciones notificaciones_test
pytest                                                     # o con cobertura (mínimo 60 %, RNF20):
pytest --cov=app --cov-report=term-missing --cov-fail-under=60
```

Las pruebas cubren los avisos internos y los duplicados, el listado por rol, la lectura, las preferencias, la
configuración, el correo (con un servidor SMTP falso), la revisión diaria con ms-inventario respondiendo, caído o
inexistente, el cortacircuito, `/health` y `/docs`.
