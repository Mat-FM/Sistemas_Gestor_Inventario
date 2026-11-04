<?php

namespace App\Exceptions;

use RuntimeException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

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
     * @param  list<array{campo: string, mensaje: string}>  $detalles
     */
    public static function datosNoValidos(array $detalles = []): self
    {
        return new self(422, 'DATOS_NO_VALIDOS', 'Los datos enviados no son válidos.', $detalles);
    }

    public static function demasiadasPeticiones(?string $m = null): self
    {
        return new self(429, 'DEMASIADAS_PETICIONES', $m ?? 'Demasiadas peticiones. Intente de nuevo más tarde.');
    }

    public static function peticionMalFormada(int $status = 400, ?string $m = null): self
    {
        return new self($status, 'PETICION_MAL_FORMADA', $m ?? 'La petición está mal formada.');
    }

    /**
     * Siempre genérico: nunca lleva el mensaje ni la traza de la excepción original.
     */
    public static function errorInterno(): self
    {
        return new self(500, 'ERROR_INTERNO', 'Error interno del servidor.');
    }

    /**
     * Traduce una excepción HTTP (abort, 405, 413, AuthorizationException convertida en 403...) al formato común.
     *
     * Conserva el estado y usa el código de D6 que le corresponde; 405 y los demás 4xx sin código propio usan
     * PETICION_MAL_FORMADA. Cualquier otro estado (los 5xx salvo 503, y los menores de 400) es un error interno
     * genérico. El mensaje de la excepción original nunca se copia.
     */
    public static function deHttp(HttpExceptionInterface $e): self
    {
        $status = $e->getStatusCode();

        return match (true) {
            $status === 401 => self::noAutenticado(),
            $status === 403 => self::sinPermiso(),
            $status === 404 => self::noExiste(),
            $status === 405 => self::peticionMalFormada(405, 'Método no permitido.'),
            $status === 409 => self::conflicto('CONFLICTO', 'Conflicto con el estado actual del recurso.'),
            $status === 422 => self::datosNoValidos(),
            $status === 429 => self::demasiadasPeticiones(),
            $status === 503 => self::servicioNoDisponible(),
            $status >= 400 && $status < 500 => self::peticionMalFormada($status),
            default => self::errorInterno(),
        };
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
