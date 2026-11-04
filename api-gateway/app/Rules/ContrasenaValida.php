<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Política de contraseñas nuevas y temporales (D4): al menos 8 caracteres, una letra y un número.
 *
 * Además tiene un tope de 72 bytes: bcrypt solo lee los primeros 72 y una contraseña más larga se truncaría en
 * silencio (dos contraseñas distintas serían la misma). Es la única regla de contraseñas del Gateway: la usan el
 * cambio de contraseña, la contraseña temporal que fija el administrador y el AdminSeeder.
 *
 * "Distinta de la actual" no se comprueba aquí: depende de otro campo y se expresa con `different:` en quien valida.
 *
 * El mensaje es fijo y no menciona el campo ni el valor, así sirve igual para `contrasena_nueva`,
 * `contrasena_temporal` o `ADMIN_PASSWORD`, y nunca puede filtrar la contraseña rechazada.
 */
class ContrasenaValida implements ValidationRule
{
    public const MINIMO_CARACTERES = 8;

    public const MAXIMO_BYTES = 72;

    public const MENSAJE = 'La contraseña debe tener al menos 8 caracteres, una letra y un número, y no superar los 72 bytes.';

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! self::cumple($value)) {
            $fail(self::MENSAJE);
        }
    }

    public static function cumple(mixed $valor): bool
    {
        return is_string($valor)
            && mb_check_encoding($valor, 'UTF-8')
            && mb_strlen($valor) >= self::MINIMO_CARACTERES
            && strlen($valor) <= self::MAXIMO_BYTES
            && preg_match('/\p{L}/u', $valor) === 1
            && preg_match('/\p{Nd}/u', $valor) === 1;
    }
}
