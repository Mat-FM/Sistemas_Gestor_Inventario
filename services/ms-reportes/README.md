# ms-reportes

Reportes, panel de indicadores, panel de auditoría, exportación a CSV y PDF e importación masiva validada.

- **Framework:** Flask (Python) · **Base de datos:** PostgreSQL · **Puerto en el clúster:** 5000
- **Requerimientos:** RF11, RF14, RF15, RF16
- **Entidades:** `Importacion`, `ErrorImportacion`
- No guarda los reportes: los calcula al momento con datos de los demás servicios. Su base de datos solo guarda las importaciones masivas.

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Hace (espera) | ms-inventario | `GET /saldos`, `/saldos/bajo-umbral`, `/movimientos`, `/lotes`, `/bodegas` |
| Hace (espera) | ms-catalogo | `GET /productos`, `GET /categorias` |
| Hace (espera) | ms-compras | `GET /ordenes-compra` |
| Hace (espera) | ms-catalogo, ms-proveedores, ms-inventario | `POST /internas/productos/lote`, `/internas/proveedores/lote`, `/internas/saldos/carga-inicial` (carga masiva) |

## Estructura interna (RNF13)

`routes` → `services` → `repositories` / `models`. `clients` agrupa las llamadas a otros servicios (RNF18), `importers` lee y valida Excel y CSV, y `exports` genera CSV y PDF.

## Pendiente

Crear la aplicación Flask (`requirements.txt`, fábrica de la app), las migraciones, `/health` y `/docs` (OpenAPI).
