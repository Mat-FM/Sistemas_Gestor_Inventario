<?php

namespace App\Http\Controllers;

use App\Services\ProductoService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Carga masiva interna (RF16). Solo la llama ms-reportes dentro del clúster con las filas
 * de un archivo de PRODUCTOS (Entrega 2, Tabla 7 y llamada 7).
 */
class ProductoLoteController extends Controller
{
    public function __construct(private ProductoService $productos) {}

    /** POST /internas/productos/lote con {filas: [{codigo, nombre, descripcion, id_categoria, unidad_medida, precio}]} */
    public function store(Request $request): JsonResponse
    {
        // Una lista vacía o ausente responde 422 (contrato).
        $datos = $request->validate([
            'filas' => ['required', 'array', 'min:1'],
        ]);

        return response()->json($this->productos->crearLote(array_values($datos['filas'])));
    }
}
