<?php

namespace App\Services;

use App\Gateway\GatewayClient;
use App\Gateway\GatewayException;
use App\Gateway\Intento;
use Illuminate\Support\Facades\Cache;

/**
 * Los listados de inventario solo traen identificadores (id_producto, id_bodega). Aquí se convierten en nombres, con un
 * caché corto compartido (los nombres de productos y bodegas los puede leer cualquier rol) para no gastar el límite de
 * 100 peticiones por minuto del Gateway.
 */
class Nombres
{
    private const SEGUNDOS = 300;

    public function __construct(private readonly GatewayClient $gateway) {}

    /**
     * @param  iterable<int>  $ids
     * @return array<int, array{codigo: string, nombre: string, unidad_medida: string}>
     */
    public function productos(iterable $ids): array
    {
        $ids = array_values(array_unique(array_map('intval', is_array($ids) ? $ids : iterator_to_array($ids))));
        $nombres = [];
        $faltan = [];
        foreach ($ids as $id) {
            $guardado = Cache::get("producto.$id");
            if ($guardado !== null) {
                $nombres[$id] = $guardado;
            } else {
                $faltan["p$id"] = ["productos/$id", []];
            }
        }

        foreach ($this->gateway->varias($faltan) as $clave => $respuesta) {
            $id = (int) substr((string) $clave, 1);
            if ($respuesta instanceof GatewayException) {
                Intento::propagarSiAfectaATodo($respuesta);

                continue;
            }
            $producto = [
                'codigo' => (string) ($respuesta['codigo'] ?? ''),
                'nombre' => (string) ($respuesta['nombre'] ?? ''),
                'unidad_medida' => (string) ($respuesta['unidad_medida'] ?? ''),
            ];
            Cache::put("producto.$id", $producto, self::SEGUNDOS);
            $nombres[$id] = $producto;
        }

        return $nombres;
    }

    /**
     * @param  iterable<int>  $ids
     * @return array<int, string> id_proveedor → razón social
     */
    public function proveedores(iterable $ids): array
    {
        $ids = array_values(array_unique(array_map('intval', is_array($ids) ? $ids : iterator_to_array($ids))));
        $nombres = [];
        $faltan = [];
        foreach ($ids as $id) {
            $guardado = Cache::get("proveedor.$id");
            if ($guardado !== null) {
                $nombres[$id] = $guardado;
            } else {
                $faltan["v$id"] = ["proveedores/$id", []];
            }
        }

        foreach ($this->gateway->varias($faltan) as $clave => $respuesta) {
            $id = (int) substr((string) $clave, 1);
            if ($respuesta instanceof GatewayException) {
                Intento::propagarSiAfectaATodo($respuesta);

                continue;
            }
            $nombres[$id] = (string) ($respuesta['razon_social'] ?? "Proveedor #$id");
            Cache::put("proveedor.$id", $nombres[$id], self::SEGUNDOS);
        }

        return $nombres;
    }

    /** @return array{codigo: string, nombre: string, unidad_medida: string} */
    public static function productoDesconocido(int $id): array
    {
        return ['codigo' => '', 'nombre' => "Producto #$id", 'unidad_medida' => ''];
    }

    /**
     * Todas las bodegas (son pocas). Si el servicio no responde, lanza GatewayException: quien llama decide qué mostrar.
     *
     * @return array<int, array{codigo: string, nombre: string, activa: bool}>
     */
    public function bodegas(): array
    {
        return Cache::remember('bodegas', self::SEGUNDOS, function (): array {
            $bodegas = [];
            foreach ($this->gateway->get('bodegas', ['por_pagina' => 100])['datos'] ?? [] as $bodega) {
                $bodegas[(int) $bodega['id_bodega']] = [
                    'codigo' => (string) $bodega['codigo'],
                    'nombre' => (string) $bodega['nombre'],
                    'activa' => (bool) ($bodega['activa'] ?? true),
                ];
            }

            return $bodegas;
        });
    }

    public function bodega(int $id): string
    {
        return $this->bodegas()[$id]['nombre'] ?? "Bodega #$id";
    }

    /**
     * Añade a cada fila `producto` (código, nombre y unidad) y los nombres de sus bodegas (`bodega`, `bodega_origen`,
     * `bodega_destino`) a partir de sus identificadores. Lo que no se puede resolver queda como «Producto #3» o
     * «Bodega #2»: una pantalla con ids a medias es mejor que una pantalla en blanco.
     *
     * @param  list<array<string, mixed>>  $filas
     * @return list<array<string, mixed>>
     */
    public function conNombres(array $filas): array
    {
        if ($filas === []) {
            return [];
        }

        [$productos] = Intento::de(fn () => $this->productos(array_column($filas, 'id_producto')));
        [$bodegas] = Intento::de(fn () => $this->bodegas());
        [$proveedores] = array_filter(array_column($filas, 'id_proveedor')) === []
            ? [[]]
            : Intento::de(fn () => $this->proveedores(array_column($filas, 'id_proveedor')));
        $productos ??= [];
        $bodegas ??= [];
        $proveedores ??= [];

        foreach ($filas as &$fila) {
            $id = (int) ($fila['id_producto'] ?? 0);
            $fila['producto'] = $productos[$id] ?? self::productoDesconocido($id);
            if (isset($fila['id_proveedor'])) {
                $fila['proveedor'] = $proveedores[(int) $fila['id_proveedor']] ?? 'Proveedor #'.$fila['id_proveedor'];
            }
            foreach (['id_bodega' => 'bodega', 'id_bodega_origen' => 'bodega_origen', 'id_bodega_destino' => 'bodega_destino'] as $campo => $nombre) {
                if (isset($fila[$campo])) {
                    $fila[$nombre] = $bodegas[(int) $fila[$campo]]['nombre'] ?? 'Bodega #'.$fila[$campo];
                }
            }
        }

        return $filas;
    }

    /**
     * Las categorías (son pocas): id → nombre completo («Bebidas › Jugos») y el id de su padre.
     *
     * @return array<int, array{nombre: string, id_categoria_padre: int|null}>
     */
    public function categorias(): array
    {
        return Cache::remember('categorias', self::SEGUNDOS, function (): array {
            $lista = $this->gateway->get('categorias') ?? [];
            $porId = [];
            foreach ($lista as $categoria) {
                $porId[(int) $categoria['id_categoria']] = $categoria;
            }

            $categorias = [];
            foreach ($porId as $id => $categoria) {
                $padre = $categoria['id_categoria_padre'] === null ? null : (int) $categoria['id_categoria_padre'];
                $categorias[$id] = [
                    'nombre' => ($padre !== null && isset($porId[$padre]) ? $porId[$padre]['nombre'].' › ' : '').$categoria['nombre'],
                    'id_categoria_padre' => $padre,
                ];
            }
            uasort($categorias, static fn (array $a, array $b) => strcasecmp($a['nombre'], $b['nombre']));

            return $categorias;
        });
    }

    /** Tras cambiar datos que se guardan en el caché, la pantalla siguiente debe verlos ya cambiados. */
    public function olvidar(string ...$claves): void
    {
        foreach ($claves as $clave) {
            Cache::forget($clave);
        }
    }
}
