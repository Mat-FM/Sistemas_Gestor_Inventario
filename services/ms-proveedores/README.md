# ms-proveedores

Proveedores y su relación con los productos.

- **Framework:** Laravel (PHP) · **Base de datos:** MySQL · **Puerto en el clúster:** 8000
- **Requerimientos:** RF03
- **Entidades:** `Proveedor` (NIT único, `estado` ACTIVO/INACTIVO), `ProveedorProducto` (guarda solo `id_producto`, que es una referencia a ms-catalogo)

## Llamadas entre servicios

| Dirección | Con | Operación |
| --- | --- | --- |
| Recibe | ms-catalogo | `GET /proveedores/{id}/productos` |
| Recibe | ms-reportes | `POST /internas/proveedores/lote` (carga masiva) |

No llama a ningún otro servicio.

## Pendiente

La aplicación Laravel aún no está generada.
