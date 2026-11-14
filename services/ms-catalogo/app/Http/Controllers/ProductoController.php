<?php

namespace App\Http\Controllers;

use App\Http\Support\Paginated;
use App\Models\Producto;
use App\Services\ProductoService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Operaciones de productos de la Tabla 7 de la Entrega 2 (RF01, RF12). Valida la petición y arma la respuesta;
 * las reglas de negocio están en ProductoService.
 */
class ProductoController extends Controller
{
    private const POR_PAGINA_PREDETERMINADO = 20;

    public function __construct(private ProductoService $productos) {}

    /** GET /productos?nombre&codigo&id_categoria&id_proveedor&estado&pagina&por_pagina */
    public function index(Request $request): JsonResponse
    {
        $filtros = $request->validate([
            'nombre' => ['nullable', 'string', 'max:150'],
            'codigo' => ['nullable', 'string', 'max:30'],
            'id_categoria' => ['nullable', 'integer', 'min:1'],
            'id_proveedor' => ['nullable', 'integer', 'min:1'],
            'estado' => ['nullable', 'in:ACTIVO,INACTIVO'],
            'pagina' => ['nullable', 'integer', 'min:1'],
            'por_pagina' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $pagina = $this->productos->listar(
            $filtros,
            (int) ($filtros['pagina'] ?? 1),
            (int) ($filtros['por_pagina'] ?? self::POR_PAGINA_PREDETERMINADO),
        );

        return response()->json(Paginated::from($pagina, fn (Producto $p) => $this->formato($p)));
    }

    /** GET /productos/{id}. También lo usa ms-inventario para confirmar que el producto existe (llamada 1). */
    public function show(int $id): JsonResponse
    {
        return response()->json($this->formato($this->productos->buscar($id)));
    }

    /** POST /productos */
    public function store(Request $request): JsonResponse
    {
        $datos = $request->validate(ProductoService::reglas());

        return response()->json($this->formato($this->productos->crear($datos)), 201);
    }

    /** PUT /productos/{id}: igual que POST, sin codigo. Si llega codigo, se ignora. */
    public function update(Request $request, int $id): JsonResponse
    {
        // Primero el 404 y después la validación, como en el contrato (404; 422).
        $this->productos->buscar($id);
        $datos = $request->validate(ProductoService::reglas(conCodigo: false));

        return response()->json($this->formato($this->productos->actualizar($id, $datos)));
    }

    /** POST /productos/{id}/inactivar (dar de baja, RF01) */
    public function inactivar(int $id): JsonResponse
    {
        return response()->json($this->formato($this->productos->cambiarEstado($id, 'INACTIVO')));
    }

    /** POST /productos/{id}/activar */
    public function activar(int $id): JsonResponse
    {
        return response()->json($this->formato($this->productos->cambiarEstado($id, 'ACTIVO')));
    }

    /** Forma de un producto en el contrato: precio como número y fechas en ISO 8601 UTC, como en el Gateway. */
    private function formato(Producto $p): array
    {
        return [
            'id_producto' => $p->id_producto,
            'codigo' => $p->codigo,
            'nombre' => $p->nombre,
            'descripcion' => $p->descripcion,
            'id_categoria' => $p->id_categoria,
            'unidad_medida' => $p->unidad_medida,
            'precio' => (float) $p->precio,
            'estado' => $p->estado,
            'fecha_creacion' => $p->fecha_creacion?->toIso8601ZuluString(),
            'fecha_actualizacion' => $p->fecha_actualizacion?->toIso8601ZuluString(),
        ];
    }
}
