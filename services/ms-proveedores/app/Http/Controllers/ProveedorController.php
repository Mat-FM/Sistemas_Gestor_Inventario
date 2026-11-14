<?php

namespace App\Http\Controllers;

use App\Http\Support\Paginated;
use App\Models\Proveedor;
use App\Services\ProveedorService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Operaciones de proveedores de la Tabla 8 de la Entrega 2. Valida la petición y arma la respuesta;
 * las reglas de negocio están en ProveedorService.
 */
class ProveedorController extends Controller
{
    private const POR_PAGINA_PREDETERMINADO = 20;

    public function __construct(private ProveedorService $proveedores) {}

    /** GET /proveedores?nit&razon_social&id_producto&estado&pagina&por_pagina */
    public function index(Request $request): JsonResponse
    {
        $filtros = $request->validate([
            'nit' => ['nullable', 'string', 'max:20'],
            'razon_social' => ['nullable', 'string', 'max:150'],
            'id_producto' => ['nullable', 'integer', 'min:1'],
            'estado' => ['nullable', 'in:ACTIVO,INACTIVO'],
            'pagina' => ['nullable', 'integer', 'min:1'],
            'por_pagina' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $pagina = $this->proveedores->listar(
            $filtros,
            (int) ($filtros['pagina'] ?? 1),
            (int) ($filtros['por_pagina'] ?? self::POR_PAGINA_PREDETERMINADO),
        );

        return response()->json(Paginated::from($pagina, fn (Proveedor $p) => $p->toArray()));
    }

    /** GET /proveedores/{id} */
    public function show(int $id): JsonResponse
    {
        return response()->json($this->proveedores->buscar($id));
    }

    /** POST /proveedores */
    public function store(Request $request): JsonResponse
    {
        $datos = $request->validate(ProveedorService::reglas());

        return response()->json($this->proveedores->crear($datos), 201);
    }

    /** PUT /proveedores/{id}: igual que POST, sin nit. Si llega nit, se ignora. */
    public function update(Request $request, int $id): JsonResponse
    {
        // Primero el 404 y después la validación, como en el contrato (404; 422).
        $this->proveedores->buscar($id);
        $datos = $request->validate(ProveedorService::reglas(conNit: false));

        return response()->json($this->proveedores->actualizar($id, $datos));
    }

    /** POST /proveedores/{id}/inactivar */
    public function inactivar(int $id): JsonResponse
    {
        return response()->json($this->proveedores->cambiarEstado($id, 'INACTIVO'));
    }

    /** POST /proveedores/{id}/activar */
    public function activar(int $id): JsonResponse
    {
        return response()->json($this->proveedores->cambiarEstado($id, 'ACTIVO'));
    }
}
