<?php

namespace App\Http\Controllers\Concerns;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

/**
 * Qué se le dice al usuario cuando una escritura (movimiento, traslado, recepción) falla, y qué se hace con la clave de
 * idempotencia: tras un fallo que no se sabe si llegó a ejecutarse (el Gateway no respondió, 5xx) se conserva, para que
 * repetir no duplique; tras un rechazo definitivo (4xx) se descarta y el formulario genera una nueva.
 */
trait ResponderFallas
{
    /**
     * @param  array<string, string>  $campos  Nombre del campo en el servicio → nombre del control del formulario.
     */
    protected function fallaDeEscritura(Request $request, GatewayException $e, array $campos = []): RedirectResponse
    {
        Intento::propagarSiAfectaATodo($e);

        if ($e->esAmbigua()) {
            return back()->withInput()->with('error',
                'No pudimos confirmar si se guardó, porque el sistema no respondió. Toca Guardar otra vez: si ya se había guardado, no se repite.');
        }

        $redireccion = back()->withInput($request->except('clave'));

        if ($e->estado === 409 && $e->codigo === 'STOCK_INSUFICIENTE') {
            $disponible = $e->detalles[0]['disponible'] ?? null;
            // ms-inventario no despacha lo vencido (D36) y lo dice entre paréntesis: «(hay 5 unidades vencidas que no se pueden despachar)».
            $vencidas = preg_match('/\((hay \d+ unidades vencidas[^)]*)\)/', (string) ($e->detalles[0]['mensaje'] ?? ''), $coincidencia) === 1 ? " ({$coincidencia[1]})" : '';

            return $redireccion->withErrors(['cantidad' => $disponible !== null
                ? "No hay stock suficiente. Disponible: {$disponible}{$vencidas}."
                : 'No hay stock suficiente en esa bodega.']);
        }

        if ($e->estado === 422 && $e->erroresPorCampo() !== []) {
            $errores = [];
            foreach ($e->erroresPorCampo() as $campo => $mensaje) {
                $errores[$campos[$campo] ?? $campo] = ucfirst($mensaje);
            }

            return $redireccion->withErrors($errores);
        }

        return $redireccion->with('error', match (true) {
            $e->estado === 403 => 'No tienes permiso para hacer esto en esa bodega.',
            $e->estado === 404 => 'Ese producto, bodega o traslado ya no existe.',
            $e->estado === 429 => 'Hiciste muchas peticiones seguidas. Espera un momento e intenta de nuevo.',
            default => $e->getMessage() ?: 'No se pudo guardar. Revisa los datos e intenta de nuevo.',
        });
    }
}
