<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Inventario;
use App\Services\Nombres;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Bodegas donde se guarda la mercancía (RF05). */
class BodegaController extends Controller
{
    use ResponderFormularios;

    public function __construct(private readonly Inventario $inventario, private readonly Nombres $nombres) {}

    public function index(): View
    {
        [$bodegas, $fallo] = Intento::de(fn () => $this->inventario->bodegas());

        return view('bodegas.index', ['bodegas' => $bodegas ?? [], 'fallo' => $fallo !== null]);
    }

    public function create(): View
    {
        return view('bodegas.formulario', ['bodega' => null]);
    }

    public function store(Request $request): RedirectResponse
    {
        $datos = $this->validar($request, true);

        try {
            $bodega = $this->inventario->crearBodega($datos);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }
        $this->nombres->olvidar('bodegas');

        return redirect()->route('bodegas.index')->with('exito', "Bodega «{$bodega['nombre']}» creada.");
    }

    public function edit(int $id): View
    {
        return view('bodegas.formulario', ['bodega' => $this->inventario->bodega($id)]);
    }

    public function update(Request $request, int $id): RedirectResponse
    {
        $datos = $this->validar($request, false);

        try {
            $bodega = $this->inventario->actualizarBodega($id, $datos);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }
        $this->nombres->olvidar('bodegas');

        return redirect()->route('bodegas.index')->with('exito', "Bodega «{$bodega['nombre']}» guardada.");
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
        try {
            $bodega = $this->inventario->cambiarEstadoBodega($id, $activar);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado === 409) {
                return back()->with('error', $e->getMessage() ?: 'No se puede inactivar una bodega que todavía tiene mercancía o traslados pendientes.');
            }
            throw $e;
        }
        $this->nombres->olvidar('bodegas');

        return back()->with('exito', "«{$bodega['nombre']}» ".($activar ? 'quedó activa.' : 'quedó inactiva: ya no recibe movimientos.'));
    }

    /** @return array<string, string> */
    private function validar(Request $request, bool $crear): array
    {
        $datos = $request->validate([
            'codigo' => $crear ? ['required', 'string', 'max:30'] : ['nullable'],
            'nombre' => ['required', 'string', 'max:100'],
            'ciudad' => ['required', 'string', 'max:100'],
            'direccion' => ['required', 'string', 'max:255'],
        ], [
            'codigo.required' => 'Escribe un código corto para la bodega (por ejemplo B3).',
            'codigo.max' => 'El código no puede pasar de 30 caracteres.',
            'nombre.required' => 'Escribe el nombre de la bodega.',
            'nombre.max' => 'El nombre no puede pasar de 100 caracteres.',
            'ciudad.required' => 'Escribe la ciudad.',
            'ciudad.max' => 'La ciudad no puede pasar de 100 caracteres.',
            'direccion.required' => 'Escribe la dirección.',
            'direccion.max' => 'La dirección no puede pasar de 255 caracteres.',
        ]);

        return array_filter(array_map('trim', $datos), static fn ($valor) => $valor !== '');
    }
}
