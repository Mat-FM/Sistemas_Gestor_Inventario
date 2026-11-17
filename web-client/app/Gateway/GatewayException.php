<?php

namespace App\Gateway;

use RuntimeException;

/**
 * Cualquier respuesta que no sea un éxito del Gateway, ya con la forma común de error
 * ({"error": {"codigo", "mensaje", "detalles"}}). Un fallo de conexión o de plazo se representa como 503.
 */
final class GatewayException extends RuntimeException
{
    public const CAMBIO_CONTRASENA = 'CAMBIO_CONTRASENA_REQUERIDO';

    /**
     * @param  list<array<string, mixed>>  $detalles
     */
    public function __construct(
        public readonly int $estado,
        public readonly string $codigo,
        string $mensaje = '',
        public readonly array $detalles = [],
        public readonly int $reintentarEn = 0,
        public readonly ?string $idPeticionGateway = null,
    ) {
        parent::__construct($mensaje, $estado);
    }

    /** No se sabe si el Gateway llegó a ejecutar la operación: se puede reintentar con la misma clave de idempotencia. */
    public function esAmbigua(): bool
    {
        return $this->estado >= 500;
    }

    public function sesionVencida(): bool
    {
        return $this->estado === 401 && $this->codigo === 'NO_AUTENTICADO';
    }

    public function exigeCambioDeContrasena(): bool
    {
        return $this->estado === 403 && $this->codigo === self::CAMBIO_CONTRASENA;
    }

    /** Mensajes por campo (`detalles[].campo` → `detalles[].mensaje`) para mostrarlos junto a cada control. */
    public function erroresPorCampo(): array
    {
        $errores = [];
        foreach ($this->detalles as $detalle) {
            if (is_array($detalle) && isset($detalle['campo'], $detalle['mensaje'])) {
                $errores[(string) $detalle['campo']] = (string) $detalle['mensaje'];
            }
        }

        return $errores;
    }
}
