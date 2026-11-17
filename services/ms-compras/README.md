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

Cada llamada espera como máximo 3 s. `POST /movimientos` se reintenta hasta tres veces (0,2 s, 0,4 s y 0,8 s)
porque lleva `Idempotency-Key`; el aviso a notificaciones no se reintenta. Tras 5 fallos seguidos contra un
servicio, el cortacircuito deja de llamarlo durante 30 s (RNF18). `/health` muestra el estado de cada cortacircuito.

## Rutas (Entrega 2, Tabla 10)

| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/ordenes-compra` | Listado paginado; filtros `estado`, `id_proveedor`, `id_bodega_destino`, `fecha_desde`, `fecha_hasta` |
| GET | `/ordenes-compra/{id}` | Orden con sus líneas (`detalles`) y sus recepciones |
| POST | `/ordenes-compra` | Crea la orden en estado CREADA |
| PUT | `/ordenes-compra/{id}` | Edita la orden (solo en CREADA) |
| PATCH | `/ordenes-compra/{id}/estado` | `{"estado": "ENVIADA"}` o `{"estado": "ANULADA"}` |
| POST | `/ordenes-compra/{id}/recepciones` | Recibe mercancía (exige `Idempotency-Key`) |
| GET | `/ordenes-compra/{id}/recepciones` | Recepciones de la orden |
| POST | `/devoluciones-proveedor` | Devuelve mercancía a un proveedor (exige `Idempotency-Key`) |
| GET | `/devoluciones-proveedor` | Listado paginado; filtros `id_proveedor`, `fecha_desde`, `fecha_hasta` |
| GET | `/health` | Estado del servicio y de la base de datos |
| GET | `/docs` | Documentación OpenAPI (Swagger UI); la especificación está en `openapi.yaml` |

Cambios de estado: CREADA → ENVIADA o ANULADA; ENVIADA → ANULADA solo si no tiene recepciones.
RECIBIDA_PARCIAL y RECIBIDA se asignan solos con cada recepción.

### Cómo funciona una recepción

1. Se bloquea la orden (candado de PostgreSQL) para que dos recepciones simultáneas no superen lo pendiente.
2. Se valida que cada línea sea de la orden y que la cantidad no supere lo pendiente.
3. Por cada línea se registra un movimiento ENTRADA_COMPRA en ms-inventario y, si inventario responde,
   se guarda la recepción y se suma a `cantidad_recibida`.
4. Si una línea falla, las demás quedan guardadas y la respuesta lista las faltantes. Repetir la misma petición
   con la **misma** `Idempotency-Key` registra solo las faltantes (RNF17).
5. La orden pasa a RECIBIDA_PARCIAL o RECIBIDA y se avisa a ms-notificaciones.

### Cabeceras que llegan del Gateway

`X-User-Id`, `X-User-Rol`, `X-User-Bodega` (operador de bodega) y `X-Request-Id`. Las operaciones que
escriben exigen `X-User-Id` y `X-User-Rol` (401 si faltan). El operador de bodega solo recibe y devuelve en su
bodega (403 `BODEGA_AJENA`). Los roles por ruta ya los comprueba el Gateway.

## Estructura interna (RNF13)

```text
src/
  app.js, server.js       Aplicación Express y arranque (aplica las migraciones pendientes)
  routes/                 Rutas → controllers → services → repositories
  controllers/            Lee la petición y da forma a la respuesta
  services/               Reglas de negocio (estados, recepciones, devoluciones)
  repositories/           SQL contra la base propia
  clients/                Llamadas a otros servicios: espera máxima, reintentos y cortacircuito
  middleware/             Cabeceras X-User-*, X-Request-Id, registros JSON y formato de errores
migrations/               Archivos .sql que aplica scripts/migrar.js
dev/                      Simulador de ms-inventario y ms-notificaciones (lo usan las pruebas; no va en la imagen)
tests/                    Pruebas con Jest y Supertest
```

## Ejecutar en el computador

Requisitos: Node.js 22 y Docker (para la base de datos).

```bash
# Desde la raíz del repositorio: levanta la base de datos de compras
docker compose up -d db-ms-compras

# Desde services/ms-compras
cp .env.example .env          # poner en MS_INVENTARIO_URL y MS_NOTIFICACIONES_URL la dirección de cada servicio
npm install
npm run migrate
npm run dev                   # http://localhost:3000/docs
```

## Ejecutar con Docker Compose

```bash
docker compose up -d --build ms-compras    # levanta también su base de datos
```

El servicio queda en `http://localhost:3002` (solo para pruebas locales; en el sistema real se entra por el Gateway).

ms-compras llama a `http://ms-inventario:3000` y a `http://ms-notificaciones:5000`, los mismos nombres del clúster.
Mientras ms-inventario no esté levantado, las órdenes se crean, editan y consultan con normalidad, y las recepciones
y devoluciones responden 503 `SERVICIO_NO_DISPONIBLE` sin guardar nada. Para apuntar a otra dirección se usan
`COMPRAS_INVENTARIO_URL` y `COMPRAS_NOTIFICACIONES_URL` en el `.env` de la raíz.

## Pruebas

Necesitan una base PostgreSQL vacía llamada `compras_test` (las pruebas la limpian al empezar):

```bash
docker compose exec db-ms-compras createdb -U compras compras_test
npm test                       # o npm run test:cobertura (mínimo 60 % de líneas, RNF20)
```

Las pruebas cubren las órdenes, las transiciones de estado, las recepciones (parciales, repetidas, simultáneas,
con inventario caído y con una línea fallida), las devoluciones, el cortacircuito y `/health`.

## Simulador de inventario y notificaciones

`dev/simulador-servicios.js` responde `POST /movimientos` y `POST /internas/notificaciones` con el mismo contrato
que tendrán ms-inventario y ms-notificaciones. Lo levantan las pruebas automáticas; ni Docker Compose ni la imagen
lo usan. Para probar a mano sin ms-inventario: `npm run simulador` y `MS_INVENTARIO_URL=http://127.0.0.1:3001`. Lleva un saldo
en memoria, así que una devolución mayor que lo recibido responde 409 `STOCK_INSUFICIENTE`. `GET /saldos` y
`GET /internas/notificaciones` muestran lo que ha recibido. **Se elimina cuando los dos servicios reales estén listos.**
