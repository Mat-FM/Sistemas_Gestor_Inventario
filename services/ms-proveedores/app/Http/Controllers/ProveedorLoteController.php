<?php

namespace App\Http\Controllers;

use App\Services\ProveedorService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Carga masiva interna (RF16). Solo la llama ms-reportes dentro del clúster con las filas
 * de un archivo de PROVEEDORES (Entrega 2, Tabla 8 y llamada 7).
 */
class ProveedorLoteController extends Controller
{
    public function __construct(private ProveedorService $proveedores) {}

    /** POST /internas/proveedores/lote con {filas: [{nit, razon_social, ...}]} */
    public function store(Request $request): JsonResponse
    {
        // Una lista vacía o ausente responde 422 (contrato).
        $datos = $request->validate([
            'filas' => ['required', 'array', 'min:1'],
        ]);

        return response()->json($this->proveedores->crearLote(array_values($datos['filas'])));
    }
}
