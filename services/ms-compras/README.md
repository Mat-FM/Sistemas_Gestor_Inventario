# ms-compras

Órdenes de compra, cambios de estado, recepción total o parcial y devoluciones a proveedor.

- **Framework:** Express (Node.js) · **Base de datos:** PostgreSQL · **Puerto en el clúster:** 3000
- **Requerimientos:** RF06, RF13
- **Entidades:** `OrdenCompra`, `DetalleOrden`, `Recepcion`, `DevolucionProveedor`
- Estados de la orden: CREADA, ENVIADA, RECIBIDA_PARCIAL, RECIBIDA, ANULADA. Número consecutivo único (ej. `OC-0001`).
- Cada recepción y cada devolución guardan el identificador del movimiento que crearon en ms-inventario.

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Hace (espera) | ms-inventario | `POST /movimientos` (ENTRADA_COMPRA, DEVOLUCION_PROVEEDOR) |
| Hace (aviso) | ms-notificaciones | `POST /internas/notificaciones` (ORDEN_RECIBIDA) |
| Recibe | ms-reportes | `GET /ordenes-compra` |

## Estructura interna (RNF13)

`routes` → `controllers` → `services` → `repositories`, con `clients` para llamadas a otros servicios (RNF18) y `middleware` para cabeceras, idempotencia y registros.

## Pendiente

Inicializar el proyecto Node.js (`package.json`), las migraciones, `/health` y `/docs` (OpenAPI).
