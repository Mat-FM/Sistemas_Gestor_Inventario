<?php

namespace App\Services;

use App\Gateway\GatewayClient;
use App\Gateway\RespuestaGateway;

/** Acceso a ms-compras a través del Gateway: órdenes de compra, recepciones y devoluciones a proveedor (RF06, RF13). */
class Compras
{
    public function __construct(private readonly GatewayClient $gateway) {}

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function ordenes(array $filtros = []): array
    {
        return $this->listado('ordenes-compra', $filtros);
    }

    /** @return array<string, mixed> La orden con sus `detalles` y sus `recepciones`. */
    public function orden(int $id): array
    {
        return $this->gateway->get("ordenes-compra/$id");
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crearOrden(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'ordenes-compra', $cuerpo)->cuerpo;
    }

    public function cambiarEstado(int $id, string $estado): array
    {
        return $this->gateway->enviar('PATCH', "ordenes-compra/$id/estado", ['estado' => $estado])->cuerpo;
    }

    /** @param  list<array<string, mixed>>  $lineas */
    public function recibir(int $id, array $lineas, string $clave): RespuestaGateway
    {
        return $this->gateway->enviar('POST', "ordenes-compra/$id/recepciones", ['lineas' => $lineas], claveIdempotencia: $clave);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function devoluciones(array $filtros = []): array
    {
        return $this->listado('devoluciones-proveedor', $filtros);
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crearDevolucion(array $cuerpo, string $clave): RespuestaGateway
    {
        return $this->gateway->enviar('POST', 'devoluciones-proveedor', $cuerpo, claveIdempotencia: $clave);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    private function listado(string $ruta, array $filtros): array
    {
        $respuesta = $this->gateway->get($ruta, $filtros + ['por_pagina' => 20]);

        return ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]];
    }
}
