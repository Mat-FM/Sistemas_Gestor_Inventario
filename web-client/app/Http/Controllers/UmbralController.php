<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Catalogo;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Support\Formato;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Stock mínimo de cada producto: por debajo de él el producto aparece como «con poco stock» (RF09). */
class UmbralController extends Controller
{
    use ResponderFormularios;

    public function __construct(
        private readonly Inventario $inventario,
        private readonly Catalogo $catalogo,
        private readonly Nombres $nombres,
    ) {}

    public function index(Request $request): View
    {
        [$respuesta, $fallo] = Intento::de(fn () => $this->inventario->umbrales(['pagina' => max(1, $request->integer('pagina', 1))]));
        $filas = $this->nombres->conNombres($respuesta['datos'] ?? []);

        $texto = trim((string) $request->query('q', ''));
        $resultados = [];
        $falloBusqueda = false;
        if ($texto !== '') {
            [$encontrados, $error] = Intento::de(fn () => $this->catalogo->buscar($texto));
            $falloBusqueda = $error !== null;
            // Con el mínimo actual a la vista, si ya tiene uno (se consultan hasta 100 umbrales).
            [$todos] = Intento::de(fn () => $this->inventario->umbrales(['por_pagina' => 100])['datos']);
            $actuales = array_column($todos ?? [], 'cantidad_minima', 'id_producto');
            $resultados = array_map(fn (array $producto) => $producto + ['minimo' => $actuales[$producto['id_producto']] ?? null], $encontrados ?? []);
        }

        return view('umbrales.index', [
            'filas' => $filas,
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'texto' => $texto,
            'resultados' => $resultados,
            'falloBusqueda' => $falloBusqueda,
        ]);
    }

    public function update(Request $request, int $producto): RedirectResponse
    {
        $request->merge(['cantidad_minima' => preg_replace('/[\s.]/', '', (string) $request->input('cantidad_minima'))]);
        $datos = $request->validate([
            'cantidad_minima' => ['required', 'integer', 'min:0', 'max:2147483647'],
        ], [
            'cantidad_minima.required' => 'Escribe el mínimo.',
            'cantidad_minima.integer' => 'El mínimo debe ser un número entero, sin decimales.',
            'cantidad_minima.min' => 'El mínimo no puede ser negativo.',
            'cantidad_minima.max' => 'Ese mínimo es demasiado grande.',
        ]);

        try {
            $this->inventario->guardarUmbral($producto, (int) $datos['cantidad_minima']);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);

            return back()->withInput()->with('error', $e->estado === 404
                ? 'Ese producto ya no existe.'
                : ($e->esAmbigua() ? 'El sistema no respondió. Revisa el valor antes de intentarlo otra vez.' : ($e->getMessage() ?: 'No se pudo guardar el mínimo.')));
        }

        $nombre = $this->nombres->productos([$producto])[$producto]['nombre'] ?? "Producto #$producto";

        return redirect()->route('umbrales.index')->with('exito', "Listo: avisaremos cuando «{$nombre}» baje de ".Formato::numero($datos['cantidad_minima']).'.');
    }
}
