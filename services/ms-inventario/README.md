# ms-inventario

Bodegas, saldos, movimientos (kardex), traslados, lotes con salida FEFO, devoluciones de clientes y conteo físico.
Es el servicio más consultado.

- **Framework:** Express (Node.js) · **Base de datos:** PostgreSQL · **Puerto en el clúster:** 3000
- **Requerimientos:** RF04, RF05, RF09, RF10, RF13, RF15, RF17, RF18
- **Entidades:** `Bodega`, `Saldo`, `Movimiento`, `Lote`, `Traslado`, `Conteo`, `DetalleConteo`, `UmbralProducto`
- **Escalado:** pasa automáticamente de 1 a 4 copias cuando la CPU supera el 70 % (RNF05). No guarda sesión en memoria.
- Las operaciones bloquean el saldo mientras se actualiza para evitar saldos negativos.
- Los movimientos llevan clave de idempotencia (`Idempotency-Key`, RNF17).
- Tipos de movimiento: ENTRADA, SALIDA, AJUSTE, DEVOLUCION_CLIENTE, ENTRADA_COMPRA, DEVOLUCION_PROVEEDOR, TRASLADO_SALIDA, TRASLADO_ENTRADA, CARGA_INICIAL.

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Hace (espera) | ms-catalogo | `GET /productos/{id}` |
| Hace (aviso) | ms-notificaciones | `POST /internas/notificaciones` (STOCK_BAJO) |
| Recibe | ms-compras | `POST /movimientos` (ENTRADA_COMPRA, DEVOLUCION_PROVEEDOR) |
| Recibe | ms-notificaciones | `GET /lotes`, `GET /saldos/bajo-umbral` |
| Recibe | ms-reportes | `GET /saldos`, `/saldos/bajo-umbral`, `/movimientos`, `/lotes`, `/bodegas`; `POST /internas/saldos/carga-inicial` |

## Estructura interna (RNF13)

`routes` → `controllers` → `services` (lógica de negocio) → `repositories` (acceso a datos).
`clients` agrupa las llamadas a otros servicios (espera máxima 3 s, reintentos y cortacircuitos, RNF18).
`middleware` lee las cabeceras `X-User-*` y `X-Request-Id`, aplica la idempotencia y escribe los registros JSON.

## Pendiente

Inicializar el proyecto Node.js (`package.json`), las migraciones, `/health` y `/docs` (OpenAPI).
