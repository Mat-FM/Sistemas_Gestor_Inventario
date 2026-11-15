<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Models\ProveedorProducto;
use Illuminate\Database\Eloquent\Collection;

/**
 * Asociación entre proveedores y productos (RF01, RF03). id_producto es un dato de ms-catalogo:
 * no se consulta a ese servicio al asociar (Entrega 2, sección 4.6); el cliente web lo toma del catálogo.
 */
class ProveedorProductoService
{
    public function __construct(private ProveedorService $proveedores) {}

    /** Productos asociados al proveedor. 404 si el proveedor no existe. */
    public function listar(int $idProveedor): Collection
    {
        return $this->proveedores->buscar($idProveedor)
            ->productos()
            ->orderBy('id_proveedor_producto')
            ->get();
    }

    /** Asocia un producto. Se permite aunque el proveedor esté INACTIVO. */
    public function asociar(int $idProveedor, int $idProducto): ProveedorProducto
    {
        $proveedor = $this->proveedores->buscar($idProveedor);

        if ($proveedor->productos()->where('id_producto', $idProducto)->exists()) {
            throw ApiException::conflicto('PRODUCTO_YA_ASOCIADO', 'El producto ya está asociado a este proveedor.');
        }

        $asociacion = $proveedor->productos()->create(['id_producto' => $idProducto]);

        // Se recarga para traer fecha_asociacion, que la pone la base de datos.
        return $asociacion->refresh();
    }

    /** Quita la asociación con un borrado real: no tiene historia (Entrega 2, sección 4.6). */
    public function desasociar(int $idProveedor, int $idProducto): void
    {
        $asociacion = $this->proveedores->buscar($idProveedor)
            ->productos()
            ->where('id_producto', $idProducto)
            ->first();

        if ($asociacion === null) {
            throw ApiException::noExiste('El producto no está asociado a este proveedor.');
        }

        $asociacion->delete();
    }
}
