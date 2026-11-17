<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Catalogo;
use App\Services\Nombres;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Categorías y subcategorías (de dos niveles) de los productos (RF02). */
class CategoriaController extends Controller
{
    use ResponderFormularios;

    public function __construct(private readonly Catalogo $catalogo, private readonly Nombres $nombres) {}

    public function index(): View
    {
        [$arbol, $fallo] = Intento::de(fn () => $this->catalogo->arbolDeCategorias());

        return view('categorias.index', ['arbol' => $arbol ?? [], 'fallo' => $fallo !== null]);
    }

    public function store(Request $request): RedirectResponse
    {
        $datos = $this->validar($request);

        try {
            $categoria = $this->catalogo->crearCategoria($this->cuerpo($datos));
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }
        $this->nombres->olvidar('categorias');

        return redirect()->route('categorias.index')->with('exito', "Categoría «{$categoria['nombre']}» creada.");
    }

    public function edit(int $id): View
    {
        [$arbol] = Intento::de(fn () => $this->catalogo->arbolDeCategorias());
        $categoria = $this->catalogo->categoria($id);

        return view('categorias.editar', [
            'categoria' => $categoria,
            // Solo una categoría principal puede ser el padre (son dos niveles) y no puede serlo de sí misma.
            'padres' => collect($arbol ?? [])->reject(fn ($c) => (int) $c['id_categoria'] === $id)->pluck('nombre', 'id_categoria')->all(),
            'tieneHijas' => collect($arbol ?? [])->contains(fn ($c) => (int) $c['id_categoria'] === $id && ! empty($c['subcategorias'])),
        ]);
    }

    public function update(Request $request, int $id): RedirectResponse
    {
        $datos = $this->validar($request);

        try {
            $categoria = $this->catalogo->actualizarCategoria($id, $this->cuerpo($datos));
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e, ['id_categoria_padre' => 'id_categoria_padre']);
        }
        $this->nombres->olvidar('categorias');

        return redirect()->route('categorias.index')->with('exito', "Categoría «{$categoria['nombre']}» guardada.");
    }

    public function destroy(int $id): RedirectResponse
    {
        try {
            $this->catalogo->eliminarCategoria($id);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado === 409) {
                return back()->with('error', 'No se puede eliminar: hay productos o subcategorías que la usan. Muévelos primero.');
            }
            throw $e;
        }
        $this->nombres->olvidar('categorias');

        return redirect()->route('categorias.index')->with('exito', 'Categoría eliminada.');
    }

    private function validar(Request $request): array
    {
        return $request->validate([
            'nombre' => ['required', 'string', 'max:100'],
            'descripcion' => ['nullable', 'string', 'max:255'],
            'id_categoria_padre' => ['nullable', 'integer', 'min:1'],
        ], [
            'nombre.required' => 'Escribe el nombre de la categoría.',
            'nombre.max' => 'El nombre no puede pasar de 100 caracteres.',
            'descripcion.max' => 'La descripción no puede pasar de 255 caracteres.',
        ]);
    }

    /** @param  array<string, mixed>  $datos */
    private function cuerpo(array $datos): array
    {
        return array_filter([
            'nombre' => trim($datos['nombre']),
            'descripcion' => isset($datos['descripcion']) ? trim($datos['descripcion']) : null,
            'id_categoria_padre' => isset($datos['id_categoria_padre']) ? (int) $datos['id_categoria_padre'] : null,
        ], static fn ($valor) => $valor !== null && $valor !== '');
    }
}
