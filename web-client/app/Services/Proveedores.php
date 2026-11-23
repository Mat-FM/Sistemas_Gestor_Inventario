<?php

namespace App\Services;

use App\Gateway\GatewayClient;

/** Acceso a ms-proveedores a través del Gateway (RF03). */
class Proveedores
{
    public function __construct(private readonly GatewayClient $gateway) {}

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function listar(array $filtros = []): array
    {
        $respuesta = $this->gateway->get('proveedores', $filtros + ['por_pagina' => 20]);

        return ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]];
    }

    /**
     * Todos los proveedores que cumplen los filtros, sin paginar (para los desplegables).
     *
     * @return list<array<string, mixed>>
     */
    public function todos(array $filtros = []): array
    {
        return $this->gateway->todas('proveedores', $filtros);
    }

    /** @return array<string, mixed> */
    public function obtener(int $id): array
    {
        return $this->gateway->get("proveedores/$id");
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crear(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'proveedores', $cuerpo)->cuerpo;
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function actualizar(int $id, array $cuerpo): array
    {
        return $this->gateway->enviar('PUT', "proveedores/$id", $cuerpo)->cuerpo;
    }

    public function cambiarEstado(int $id, bool $activar): array
    {
        return $this->gateway->enviar('POST', "proveedores/$id/".($activar ? 'activar' : 'inactivar'), [])->cuerpo;
    }

    /** @return list<array{id_proveedor_producto: int, id_producto: int, fecha_asociacion: string}> */
    public function productos(int $id): array
    {
        return $this->gateway->get("proveedores/$id/productos") ?? [];
    }

    public function asociar(int $id, int $idProducto): void
    {
        $this->gateway->enviar('POST', "proveedores/$id/productos", ['id_producto' => $idProducto]);
    }

    public function quitar(int $id, int $idProducto): void
    {
        $this->gateway->enviar('DELETE', "proveedores/$id/productos/$idProducto");
    }
}
