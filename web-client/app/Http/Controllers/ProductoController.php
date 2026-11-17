<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Catalogo;
use App\Services\Nombres;
use App\Support\Formato;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Productos del catálogo: crear, editar y dar de baja (RF01, RF12). */
class ProductoController extends Controller
{
    use ResponderFormularios;

    public function __construct(private readonly Catalogo $catalogo, private readonly Nombres $nombres) {}

    public function index(Request $request): View
    {
        $texto = trim((string) $request->query('q', ''));
        $estado = in_array($request->query('estado'), ['ACTIVO', 'INACTIVO'], true) ? $request->query('estado') : null;
        $categoria = $request->integer('categoria') ?: null;

        [$respuesta, $fallo] = Intento::de(function () use ($request, $texto, $estado, $categoria) {
            $filtros = ['estado' => $estado, 'id_categoria' => $categoria];
            if ($texto === '') {
                return $this->catalogo->productos($filtros + ['pagina' => max(1, $request->integer('pagina', 1))]);
            }
            // El catálogo filtra por nombre y por código a la vez («y»): se pregunta por cada uno y se unen.
            $unidos = [];
            foreach (['nombre', 'codigo'] as $campo) {
                foreach ($this->catalogo->productos($filtros + [$campo => $texto, 'por_pagina' => 50])['datos'] as $producto) {
                    $unidos[$producto['id_producto']] ??= $producto;
                }
            }

            return ['datos' => array_values($unidos), 'meta' => null];
        });
        [$categorias] = Intento::de(fn () => $this->nombres->categorias());

        return view('productos.index', [
            'productos' => $respuesta['datos'] ?? [],
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'categorias' => $categorias ?? [],
            'texto' => $texto,
            'estado' => $estado,
            'categoria' => $categoria,
        ]);
    }

    public function create(): View
    {
        return view('productos.formulario', ['producto' => null, 'categorias' => $this->categorias()]);
    }

    public function store(Request $request): RedirectResponse
    {
        $datos = $this->validar($request, true);

        try {
            $producto = $this->catalogo->crearProducto($this->cuerpo($datos, true));
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('productos.index')->with('exito', "Producto «{$producto['nombre']}» creado.");
    }

    public function edit(int $id): View
    {
        return view('productos.formulario', ['producto' => $this->catalogo->obtener($id), 'categorias' => $this->categorias()]);
    }

    public function update(Request $request, int $id): RedirectResponse
    {
        $datos = $this->validar($request, false);

        try {
            $producto = $this->catalogo->actualizarProducto($id, $this->cuerpo($datos, false));
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }
        $this->nombres->olvidar("producto.$id");

        return redirect()->route('productos.index')->with('exito', "Producto «{$producto['nombre']}» guardado.");
    }

    public function inactivar(int $id): RedirectResponse
    {
        return $this->cambiarEstado($id, false);
    }

    public function activar(int $id): RedirectResponse
    {
        return $this->cambiarEstado($id, true);
    }

    private function cambiarEstado(int $id, bool $activar): RedirectResponse
    {
        $producto = $this->catalogo->cambiarEstadoProducto($id, $activar);

        return back()->with('exito', "«{$producto['nombre']}» ".($activar ? 'quedó activo.' : 'quedó inactivo: ya no se ofrece al registrar movimientos.'));
    }

    /** @return array<int, string> id → nombre completo, solo para elegir en el formulario */
    private function categorias(): array
    {
        [$categorias] = Intento::de(fn () => $this->nombres->categorias());

        return array_map(static fn (array $categoria) => $categoria['nombre'], $categorias ?? []);
    }

    private function validar(Request $request, bool $crear): array
    {
        $request->merge(['precio' => Formato::normalizarDecimal($request->input('precio'))]);

        return $request->validate([
            'codigo' => $crear ? ['required', 'string', 'max:30'] : ['nullable'],
            'nombre' => ['required', 'string', 'max:150'],
            'descripcion' => ['nullable', 'string', 'max:500'],
            'id_categoria' => ['required', 'integer', 'min:1'],
            'unidad_medida' => ['required', 'string', 'max:20'],
            'precio' => ['required', 'numeric', 'min:0', 'max:9999999999'],
        ], [
            'codigo.required' => 'Escribe el código del producto.',
            'codigo.max' => 'El código no puede pasar de 30 caracteres.',
            'nombre.required' => 'Escribe el nombre.',
            'nombre.max' => 'El nombre no puede pasar de 150 caracteres.',
            'descripcion.max' => 'La descripción no puede pasar de 500 caracteres.',
            'id_categoria.required' => 'Elige la categoría.',
            'id_categoria.integer' => 'Elige la categoría.',
            'unidad_medida.required' => 'Escribe la unidad de medida (por ejemplo UNIDAD o KG).',
            'unidad_medida.max' => 'La unidad no puede pasar de 20 caracteres.',
            'precio.required' => 'Escribe el precio.',
            'precio.numeric' => 'El precio debe ser un número (por ejemplo 18.500 o 18500,50).',
            'precio.min' => 'El precio no puede ser negativo.',
            'precio.max' => 'Ese precio es demasiado grande.',
        ]);
    }

    /** @param  array<string, mixed>  $datos */
    private function cuerpo(array $datos, bool $crear): array
    {
        return array_filter([
            'codigo' => $crear ? trim($datos['codigo']) : null,
            'nombre' => trim($datos['nombre']),
            'descripcion' => isset($datos['descripcion']) ? trim($datos['descripcion']) : null,
            'id_categoria' => (int) $datos['id_categoria'],
            'unidad_medida' => trim($datos['unidad_medida']),
            'precio' => (float) $datos['precio'],
        ], static fn ($valor) => $valor !== null && $valor !== '');
    }
}
