<?php

namespace App\Services;

use App\Gateway\GatewayClient;
use App\Gateway\GatewayException;
use App\Gateway\RespuestaGateway;

/**
 * Acceso a ms-inventario a través del Gateway: saldos, movimientos, lotes y traslados. Solo arma las rutas y los
 * parámetros; la autorización por rol y por bodega la aplican el Gateway y el servicio.
 */
class Inventario
{
    public const POR_PAGINA = 20;

    public function __construct(private readonly GatewayClient $gateway) {}

    /**
     * @param  array<string, scalar|null>  $filtros  id_producto, id_bodega, pagina, por_pagina
     * @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>}
     */
    public function saldos(array $filtros = []): array
    {
        return $this->listado('saldos', $filtros);
    }

    /**
     * Los saldos de varios productos, cada uno por su lado (el servicio solo filtra por un producto a la vez). Un
     * producto cuyo saldo no se pudo pedir queda como la excepción, para que se muestre «no disponible» solo en él.
     *
     * @param  list<int>  $ids
     * @return array<int, array{datos: list<array<string, mixed>>, meta: array<string, mixed>}|GatewayException>
     */
    public function saldosDeProductos(array $ids, ?int $idBodega = null): array
    {
        $consultas = [];
        foreach ($ids as $id) {
            $consultas["p$id"] = ['saldos', ['id_producto' => $id, 'id_bodega' => $idBodega, 'por_pagina' => 100]];
        }

        $resultado = [];
        foreach ($this->gateway->varias($consultas) as $clave => $respuesta) {
            $resultado[(int) substr((string) $clave, 1)] = $respuesta instanceof GatewayException
                ? $respuesta
                : ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? []];
        }

        return $resultado;
    }

    /** @return list<array{id_producto: int, cantidad_total: int, cantidad_minima: int}> */
    public function bajoUmbral(): array
    {
        return $this->gateway->get('saldos/bajo-umbral') ?? [];
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function movimientos(array $filtros = []): array
    {
        return $this->listado('movimientos', $filtros);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function traslados(array $filtros = []): array
    {
        return $this->listado('traslados', $filtros);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function lotes(array $filtros = []): array
    {
        return $this->listado('lotes', $filtros);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} Los conteos, sin sus líneas. */
    public function conteos(array $filtros = []): array
    {
        return $this->listado('conteos', $filtros);
    }

    /** @return array<string, mixed> Un conteo con sus líneas. */
    public function conteo(int $id): array
    {
        return $this->gateway->get("conteos/$id");
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function programarConteo(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'conteos', $cuerpo)->cuerpo;
    }

    /** @param  list<array{id_producto: int, cantidad_contada: int}>  $detalles */
    public function registrarConteo(int $id, array $detalles): array
    {
        return $this->gateway->enviar('PUT', "conteos/$id/detalles", ['detalles' => $detalles])->cuerpo;
    }

    /** @return array<string, mixed> El conteo aprobado, con los movimientos de ajuste que generó. */
    public function aprobarConteo(int $id, string $clave): array
    {
        return $this->gateway->enviar('POST', "conteos/$id/aprobacion", [], claveIdempotencia: $clave)->cuerpo;
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function registrarMovimiento(array $cuerpo, string $clave): RespuestaGateway
    {
        return $this->gateway->enviar('POST', 'movimientos', $cuerpo, claveIdempotencia: $clave);
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crearTraslado(array $cuerpo, string $clave): RespuestaGateway
    {
        return $this->gateway->enviar('POST', 'traslados', $cuerpo, claveIdempotencia: $clave);
    }

    public function recibirTraslado(int $id, string $clave): RespuestaGateway
    {
        return $this->gateway->enviar('POST', "traslados/$id/recepcion", [], claveIdempotencia: $clave);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    private function listado(string $ruta, array $filtros): array
    {
        $respuesta = $this->gateway->get($ruta, $filtros + ['por_pagina' => self::POR_PAGINA]);

        return [
            'datos' => $respuesta['datos'] ?? [],
            'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => self::POR_PAGINA, 'total' => 0],
        ];
    }

    /** @return list<array{id_bodega: int, codigo: string, nombre: string, ciudad: string, direccion: string, activa: bool}> */
    public function bodegas(): array
    {
        return $this->gateway->get('bodegas', ['por_pagina' => 100])['datos'] ?? [];
    }

    /** @return array<string, mixed> */
    public function bodega(int $id): array
    {
        return $this->gateway->get("bodegas/$id");
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crearBodega(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'bodegas', $cuerpo)->cuerpo;
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function actualizarBodega(int $id, array $cuerpo): array
    {
        return $this->gateway->enviar('PUT', "bodegas/$id", $cuerpo)->cuerpo;
    }

    public function cambiarEstadoBodega(int $id, bool $activar): array
    {
        return $this->gateway->enviar('POST', "bodegas/$id/".($activar ? 'activar' : 'inactivar'), [])->cuerpo;
    }

    /** @return array{datos: list<array{id_producto: int, cantidad_minima: int, fecha_actualizacion: string}>, meta: array<string, mixed>} */
    public function umbrales(array $filtros = []): array
    {
        return $this->listado('umbrales', $filtros);
    }

    public function guardarUmbral(int $idProducto, int $cantidadMinima): array
    {
        return $this->gateway->enviar('PUT', "umbrales/$idProducto", ['cantidad_minima' => $cantidadMinima])->cuerpo;
    }
}
