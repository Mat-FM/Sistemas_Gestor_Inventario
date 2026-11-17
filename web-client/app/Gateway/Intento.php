<?php

namespace App\Gateway;

/**
 * Para los datos que acompañan a una pantalla (avisos, listas del inicio): si fallan, la pantalla se muestra igual y
 * ese bloque dice que no está disponible. La sesión vencida y el cambio de contraseña pendiente sí se propagan,
 * porque afectan a toda la pantalla.
 */
final class Intento
{
    /**
     * @template T
     *
     * @param  callable(): T  $consulta
     * @return array{0: T|null, 1: GatewayException|null}
     */
    public static function de(callable $consulta): array
    {
        try {
            return [$consulta(), null];
        } catch (GatewayException $e) {
            self::propagarSiAfectaATodo($e);

            return [null, $e];
        }
    }

    public static function propagarSiAfectaATodo(GatewayException $e): void
    {
        if ($e->sesionVencida() || $e->exigeCambioDeContrasena()) {
            throw $e;
        }
    }
}
