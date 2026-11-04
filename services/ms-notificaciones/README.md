# ms-notificaciones

Alertas en la interfaz y por correo; revisión diaria de vencimientos y de productos bajo el umbral.

- **Framework:** Flask (Python) · **Base de datos:** PostgreSQL · **Puerto en el clúster:** 5000
- **Requerimientos:** RF09, RF17
- **Entidades:** `Notificacion`, `Preferencia`, `Configuracion` (un solo registro: días de anticipación y hora de la revisión diaria)
- Tipos de notificación: STOCK_BAJO, VENCIMIENTO, ORDEN_RECIBIDA. Se dirigen por defecto al rol ADMINISTRADOR.

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Recibe (aviso) | ms-inventario, ms-compras | `POST /internas/notificaciones` |
| Hace (espera) | ms-inventario | `GET /lotes`, `GET /saldos/bajo-umbral` (revisión diaria) |
| Hace (aviso) | servidor de correo externo | Envío del correo |

## Estructura interna (RNF13)

`routes` (blueprints) → `services` → `repositories` / `models`. `clients` agrupa las llamadas a otros servicios (RNF18) y `jobs` las tareas programadas (revisión diaria).

## Pendiente

Crear la aplicación Flask (`requirements.txt`, fábrica de la app), las migraciones, `/health` y `/docs` (OpenAPI).
