# ms-catalogo

Productos, categorías y subcategorías; búsqueda y filtrado.

- **Framework:** Laravel (PHP) · **Base de datos:** MySQL · **Puerto en el clúster:** 8000
- **Requerimientos:** RF01, RF02, RF12
- **Entidades:** `Categoria` (se relaciona consigo misma para las subcategorías), `Producto`
- Los productos se dan de baja (`estado` ACTIVO/INACTIVO), no se borran. El proveedor asociado vive en ms-proveedores.

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Recibe | ms-inventario | `GET /productos/{id}` (confirmar que el producto existe) |
| Recibe | ms-reportes | `GET /productos`, `GET /categorias`, `POST /internas/productos/lote` |
| Hace | ms-proveedores | `GET /proveedores/{id}/productos` (filtro por proveedor, RF12) |

## Pendiente

La aplicación Laravel aún no está generada.
