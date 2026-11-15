<?php

namespace App\Http\Controllers;

use App\Services\CategoriaService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Operaciones de categorías de la Tabla 7 de la Entrega 2 (RF02). Valida la petición y arma la respuesta;
 * las reglas de negocio están en CategoriaService.
 */
class CategoriaController extends Controller
{
    public function __construct(private CategoriaService $categorias) {}

    /** GET /categorias?id_categoria_padre&arbol: lista simple, sin paginar. */
    public function index(Request $request): JsonResponse
    {
        $filtros = $request->validate([
            'id_categoria_padre' => ['nullable', 'integer', 'min:1'],
            'arbol' => ['nullable', 'in:true,false,1,0'],
        ]);

        $lista = $this->categorias->listar(
            isset($filtros['id_categoria_padre']) ? (int) $filtros['id_categoria_padre'] : null,
            $request->boolean('arbol'),
        );

        return response()->json($lista);
    }

    /** GET /categorias/{id} */
    public function show(int $id): JsonResponse
    {
        return response()->json($this->categorias->buscar($id));
    }

    /** POST /categorias */
    public function store(Request $request): JsonResponse
    {
        $datos = $request->validate(CategoriaService::reglas());

        return response()->json($this->categorias->crear($datos), 201);
    }

    /** PUT /categorias/{id}: igual que POST. */
    public function update(Request $request, int $id): JsonResponse
    {
        // Primero el 404 y después la validación, como en ms-proveedores.
        $this->categorias->buscar($id);
        $datos = $request->validate(CategoriaService::reglas());

        return response()->json($this->categorias->actualizar($id, $datos));
    }

    /** DELETE /categorias/{id} */
    public function destroy(int $id): Response
    {
        $this->categorias->eliminar($id);

        return response()->noContent();
    }
}
