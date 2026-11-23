<?php

namespace Tests;

use GuzzleHttp\Promise\PromiseInterface;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

abstract class TestCase extends BaseTestCase
{
    protected const TOKEN = 'token-secreto-del-gateway';

    /** Inicia la sesión como si el Gateway ya hubiera aceptado el inicio de sesión. */
    protected function conSesion(string $rol = 'ADMINISTRADOR', ?int $idBodega = null, bool $cambioPendiente = false): static
    {
        return $this->withSession([
            'gateway.token' => self::TOKEN,
            'gateway.vence' => time() + 3600,
            'gateway.usuario' => [
                'id_usuario' => 7,
                'nombre' => 'Ana María Pérez',
                'rol' => $rol,
                'id_bodega' => $idBodega,
                'debe_cambiar_contrasena' => $cambioPendiente,
            ],
        ]);
    }

    /**
     * Sustituye al Gateway. Las claves son «MÉTODO ruta» (sin /api); el valor, una respuesta o una función que la arma.
     * Lo que no está en el arreglo responde 404, para que una petición inesperada se note.
     *
     * @param  array<string, Response|callable|PromiseInterface>  $respuestas
     */
    protected function fingirGateway(array $respuestas): void
    {
        // Cada llamada parte de un cliente limpio: los simulados anteriores no pueden tapar a los nuevos.
        Http::swap(new Factory);
        Http::preventStrayRequests();
        Http::fake(function (Request $peticion) use ($respuestas) {
            $ruta = Str::after((string) parse_url($peticion->url(), PHP_URL_PATH), '/api/');
            $respuesta = $respuestas[$peticion->method().' '.$ruta] ?? null;

            if ($respuesta === null) {
                return Http::response(['error' => ['codigo' => 'NO_EXISTE', 'mensaje' => "Sin respuesta falsa para {$peticion->method()} $ruta", 'detalles' => []]], 404);
            }

            return is_callable($respuesta) ? $respuesta($peticion) : $respuesta;
        });
    }

    protected static function error(int $estado, string $codigo, string $mensaje = '', array $detalles = [], array $cabeceras = [])
    {
        return Http::response(['error' => ['codigo' => $codigo, 'mensaje' => $mensaje, 'detalles' => $detalles]], $estado, $cabeceras);
    }

    protected static function listado(array $datos, ?int $total = null)
    {
        return Http::response(['datos' => $datos, 'meta' => ['pagina' => 1, 'por_pagina' => 20, 'total' => $total ?? count($datos)]]);
    }

    /** Un listado de varias páginas: responde la página pedida (`pagina`, `por_pagina`), como los servicios. */
    protected static function paginado(array $datos): callable
    {
        return function (Request $peticion) use ($datos) {
            parse_str((string) parse_url($peticion->url(), PHP_URL_QUERY), $consulta);
            $porPagina = (int) ($consulta['por_pagina'] ?? 20);
            $pagina = (int) ($consulta['pagina'] ?? 1);

            return Http::response([
                'datos' => array_slice($datos, ($pagina - 1) * $porPagina, $porPagina),
                'meta' => ['pagina' => $pagina, 'por_pagina' => $porPagina, 'total' => count($datos)],
            ]);
        };
    }

    protected static function bodegas()
    {
        return self::listado([
            ['id_bodega' => 1, 'codigo' => 'B1', 'nombre' => 'Bodega Centro', 'ciudad' => 'Manizales', 'direccion' => 'Calle 1', 'activa' => true],
            ['id_bodega' => 2, 'codigo' => 'B2', 'nombre' => 'Bodega Norte', 'ciudad' => 'Manizales', 'direccion' => 'Calle 2', 'activa' => true],
        ]);
    }

    protected static function producto(int $id, string $nombre, string $codigo = 'COD')
    {
        return Http::response(['id_producto' => $id, 'codigo' => $codigo.$id, 'nombre' => $nombre, 'unidad_medida' => 'UNIDAD', 'estado' => 'ACTIVO']);
    }

    /** ¿Se envió alguna petición con ese método a esa ruta (y, si se da, que cumpla la comprobación)? */
    protected function seEnvio(string $metodo, string $ruta, ?callable $comprobar = null): bool
    {
        return Http::recorded(static function (Request $peticion) use ($metodo, $ruta, $comprobar) {
            return $peticion->method() === $metodo
                && Str::after((string) parse_url($peticion->url(), PHP_URL_PATH), '/api/') === $ruta
                && ($comprobar === null || $comprobar($peticion));
        })->isNotEmpty();
    }
}
