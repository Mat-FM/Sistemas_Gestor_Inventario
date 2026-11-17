<?php

namespace App\Http\Controllers\Concerns;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

/**
 * Qué se le dice al usuario cuando falla el guardado de un formulario de administración (productos, proveedores,
 * usuarios...): el mensaje va junto al campo que lo causó y lo escrito se conserva, salvo las contraseñas.
 */
trait ResponderFormularios
{
    /** Código de error del servicio → campo del formulario al que pertenece. */
    private const CAMPO_DE_DUPLICADO = [
        'CORREO_DUPLICADO' => 'correo',
        'NIT_DUPLICADO' => 'nit',
        'CODIGO_DUPLICADO' => 'codigo',
        'NOMBRE_DUPLICADO' => 'nombre',
        'PRODUCTO_YA_ASOCIADO' => 'id_producto',
    ];

    /** @param  array<string, string>  $campos  Nombre del campo en el servicio → nombre del control del formulario. */
    protected function fallaDeFormulario(Request $request, GatewayException $e, array $campos = []): RedirectResponse
    {
        Intento::propagarSiAfectaATodo($e);

        $redireccion = back()->withInput($request->except(['contrasena_temporal', 'contrasena', 'contrasena_actual', 'contrasena_nueva']));

        if ($e->estado === 409 && isset(self::CAMPO_DE_DUPLICADO[$e->codigo])) {
            return $redireccion->withErrors([self::CAMPO_DE_DUPLICADO[$e->codigo] => $e->getMessage()]);
        }

        if ($e->estado === 422 && $e->erroresPorCampo() !== []) {
            $errores = [];
            foreach ($e->erroresPorCampo() as $campo => $mensaje) {
                $errores[$campos[$campo] ?? $campo] = $this->enEspanol($mensaje);
            }

            return $redireccion->withErrors($errores);
        }

        return $redireccion->with('error', match (true) {
            $e->esAmbigua() => 'El sistema no respondió. Revisa si el cambio quedó guardado antes de intentarlo otra vez.',
            $e->estado === 404 => 'Eso ya no existe. Vuelve a la lista y revisa.',
            $e->estado === 409 => $e->getMessage() ?: 'Ese cambio no se puede hacer ahora.',
            $e->estado === 429 => 'Hiciste muchas peticiones seguidas. Espera un momento e intenta de nuevo.',
            default => $e->getMessage() ?: 'No se pudo guardar. Revisa los datos e intenta de nuevo.',
        });
    }

    /** Los servicios de Laravel responden algunos mensajes de validación en inglés: se traducen los más comunes. */
    private function enEspanol(string $mensaje): string
    {
        return match (true) {
            (bool) preg_match('/field is required/i', $mensaje) => 'Este campo es obligatorio.',
            (bool) preg_match('/may not be greater than (\d+) characters|must not be greater than (\d+) characters/i', $mensaje, $m) => 'Es demasiado largo (máximo '.($m[1] ?: $m[2]).' caracteres).',
            (bool) preg_match('/must be at least (\d+)/i', $mensaje, $m) => 'Debe ser al menos '.$m[1].'.',
            (bool) preg_match('/must be a number/i', $mensaje) => 'Debe ser un número.',
            (bool) preg_match('/valid email/i', $mensaje) => 'Escribe un correo válido.',
            default => ucfirst($mensaje),
        };
    }
}
