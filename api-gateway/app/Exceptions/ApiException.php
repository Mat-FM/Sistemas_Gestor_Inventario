<?php

namespace App\Exceptions;

use RuntimeException;

/**
 * Error con estado HTTP y código estable que el Gateway entrega al cliente
 * con la forma común {"error": {"codigo", "mensaje", "detalles"}}.
 */
class ApiException extends RuntimeException
{
    /**
     * @param  list<array<string, mixed>>  $detalles
     */
    public function __construct(
        public readonly int $status,
        public readonly string $codigo,
        string $mensaje,
        public readonly array $detalles = [],
    ) {
        parent::__construct($mensaje);
    }

    public static function noAutenticado(?string $m = null): self
    {
        return new self(401, 'NO_AUTENTICADO', $m ?? 'No autenticado.');
    }

    public static function sinPermiso(?string $m = null): self
    {
        return new self(403, 'SIN_PERMISO', $m ?? 'No tiene permiso para realizar esta acción.');
    }

    public static function noExiste(?string $m = null): self
    {
        return new self(404, 'NO_EXISTE', $m ?? 'El recurso no existe.');
    }

    public static function conflicto(string $codigo, string $m): self
    {
        return new self(409, $codigo, $m);
    }

    public static function servicioNoDisponible(?string $m = null): self
    {
        return new self(503, 'SERVICIO_NO_DISPONIBLE', $m ?? 'El servicio no está disponible.');
    }

    /**
     * @return array{error: array{codigo: string, mensaje: string, detalles: list<array<string, mixed>>}}
     */
    public function cuerpo(): array
    {
        return [
            'error' => [
                'codigo' => $this->codigo,
                'mensaje' => $this->getMessage(),
                'detalles' => $this->detalles,
            ],
        ];
    }
}
