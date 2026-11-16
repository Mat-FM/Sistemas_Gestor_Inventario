<?php

namespace App\Http\Controllers;

use App\Models\ProveedorProducto;
use App\Services\ProveedorProductoService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Productos de un proveedor (Tabla 8 de la Entrega 2). GET /proveedores/{id}/productos también lo usa
 * ms-catalogo para el filtro por proveedor (RF12, llamada 8).
 */
class ProveedorProductoController extends Controller
{
    public function __construct(private ProveedorProductoService $asociaciones) {}

    /** GET /proveedores/{id}/productos: lista simple, sin paginar. */
    public function index(int $id): JsonResponse
    {
        $lista = $this->asociaciones->listar($id)->map(fn (ProveedorProducto $a) => $this->formato($a));

        return response()->json($lista);
    }

    /** POST /proveedores/{id}/productos con {id_producto} */
    public function store(Request $request, int $id): JsonResponse
    {
        $datos = $request->validate([
            'id_producto' => ['required', 'integer', 'min:1'],
        ]);

        $asociacion = $this->asociaciones->asociar($id, (int) $datos['id_producto']);

        return response()->json($this->formato($asociacion), 201);
    }

    /** DELETE /proveedores/{id}/productos/{id_producto} */
    public function destroy(int $id, int $idProducto): Response
    {
        $this->asociaciones->desasociar($id, $idProducto);

        return response()->noContent();
    }

    /** Forma de una asociación en el contrato; la fecha en ISO 8601 UTC, como en el Gateway. */
    private function formato(ProveedorProducto $a): array
    {
        return [
            'id_proveedor_producto' => $a->id_proveedor_producto,
            'id_producto' => $a->id_producto,
            'fecha_asociacion' => $a->fecha_asociacion?->toIso8601ZuluString(),
        ];
    }
}
