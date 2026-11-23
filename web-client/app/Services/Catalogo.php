<?php

namespace App\Services;

use App\Gateway\GatewayClient;
use App\Gateway\GatewayException;
use App\Gateway\Intento;

/** Acceso a los productos (ms-catalogo, a través del Gateway). */
class Catalogo
{
    public const MAXIMO_RESULTADOS = 10;

    public function __construct(private readonly GatewayClient $gateway) {}

    /**
     * Productos activos cuyo nombre o código contiene el texto. El catálogo filtra por nombre y por código a la vez
     * (los filtros se combinan con «y»), así que se pregunta por cada uno y se unen los resultados.
     *
     * @return list<array<string, mixed>>
     */
    public function buscar(string $texto): array
    {
        $texto = trim($texto);
        if ($texto === '') {
            return [];
        }

        $respuestas = $this->gateway->varias([
            'nombre' => ['productos', ['nombre' => $texto, 'estado' => 'ACTIVO', 'por_pagina' => self::MAXIMO_RESULTADOS]],
            'codigo' => ['productos', ['codigo' => $texto, 'estado' => 'ACTIVO', 'por_pagina' => self::MAXIMO_RESULTADOS]],
        ]);

        $productos = [];
        foreach ($respuestas as $respuesta) {
            if ($respuesta instanceof GatewayException) {
                Intento::propagarSiAfectaATodo($respuesta);
                if (count(array_filter($respuestas, fn ($r) => $r instanceof GatewayException)) === count($respuestas)) {
                    throw $respuesta;
                }

                continue;
            }
            foreach ($respuesta['datos'] ?? [] as $producto) {
                $productos[(int) $producto['id_producto']] ??= $producto;
            }
        }

        return array_slice(array_values($productos), 0, self::MAXIMO_RESULTADOS);
    }

    /** @return array<string, mixed> */
    public function obtener(int $id): array
    {
        return $this->gateway->get("productos/$id");
    }

    /**
     * @param  array<string, scalar|null>  $filtros  nombre, codigo, id_categoria, estado, pagina, por_pagina
     * @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>}
     */
    public function productos(array $filtros = []): array
    {
        $respuesta = $this->gateway->get('productos', $filtros + ['por_pagina' => 20]);

        return ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]];
    }

    /**
     * Todos los productos que cumplen los filtros, sin paginar (para los desplegables).
     *
     * @param  array<string, scalar|null>  $filtros  nombre, codigo, id_categoria, estado
     * @return list<array<string, mixed>>
     */
    public function todos(array $filtros = []): array
    {
        return $this->gateway->todas('productos', $filtros);
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crearProducto(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'productos', $cuerpo)->cuerpo;
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function actualizarProducto(int $id, array $cuerpo): array
    {
        return $this->gateway->enviar('PUT', "productos/$id", $cuerpo)->cuerpo;
    }

    public function cambiarEstadoProducto(int $id, bool $activar): array
    {
        return $this->gateway->enviar('POST', "productos/$id/".($activar ? 'activar' : 'inactivar'), [])->cuerpo;
    }

    /** @return list<array{id_categoria: int, nombre: string, descripcion: string|null, id_categoria_padre: int|null, subcategorias?: list<array<string, mixed>>}> */
    public function arbolDeCategorias(): array
    {
        return $this->gateway->get('categorias', ['arbol' => 'true']) ?? [];
    }

    /** @return array<string, mixed> */
    public function categoria(int $id): array
    {
        return $this->gateway->get("categorias/$id");
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crearCategoria(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'categorias', $cuerpo)->cuerpo;
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function actualizarCategoria(int $id, array $cuerpo): array
    {
        return $this->gateway->enviar('PUT', "categorias/$id", $cuerpo)->cuerpo;
    }

    public function eliminarCategoria(int $id): void
    {
        $this->gateway->enviar('DELETE', "categorias/$id");
    }
}
