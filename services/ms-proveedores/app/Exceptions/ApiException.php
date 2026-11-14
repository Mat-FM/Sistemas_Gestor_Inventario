<?php

namespace App\Exceptions;

use RuntimeException;

/**
 * Error que el servicio responde con la forma común de la Entrega 2 (sección 4.1):
 * {"error": {"codigo", "mensaje", "detalles"}}. Es la misma forma que usa el API Gateway.
 */
class ApiException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $codigo,
        string $mensaje,
        public readonly array $detalles = [],
    ) {
        parent::__construct($mensaje);
    }

    public static function noExiste(string $mensaje = 'El recurso no existe.'): self
    {
        return new self(404, 'NO_EXISTE', $mensaje);
    }

    /** 409 con un código propio, por ejemplo NIT_DUPLICADO. */
    public static function conflicto(string $codigo, string $mensaje): self
    {
        return new self(409, $codigo, $mensaje);
    }

    /** @param  list<array{campo: string, mensaje: string}>  $detalles */
    public static function datosNoValidos(array $detalles = []): self
    {
        return new self(422, 'DATOS_NO_VALIDOS', 'Los datos enviados no son válidos.', $detalles);
    }

    public static function peticionMalFormada(int $status = 400, string $mensaje = 'La petición está mal formada.'): self
    {
        return new self($status, 'PETICION_MAL_FORMADA', $mensaje);
    }

    /** Siempre genérico: nunca muestra el mensaje ni la traza del error original. */
    public static function errorInterno(): self
    {
        return new self(500, 'ERROR_INTERNO', 'Error interno del servidor.');
    }

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
