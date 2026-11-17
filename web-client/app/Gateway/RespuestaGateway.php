<?php

namespace App\Gateway;

/** Respuesta correcta del Gateway: su estado (200, 201, 204...) y el JSON ya decodificado (null si no trae cuerpo). */
final readonly class RespuestaGateway
{
    public function __construct(public int $estado, public mixed $cuerpo) {}
}
