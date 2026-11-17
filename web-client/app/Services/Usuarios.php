<?php

namespace App\Services;

use App\Gateway\GatewayClient;
use Illuminate\Support\Facades\Cache;

/** Usuarios y roles: los gestiona el propio Gateway (RF07). */
class Usuarios
{
    public function __construct(private readonly GatewayClient $gateway) {}

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function listar(array $filtros = []): array
    {
        $respuesta = $this->gateway->get('usuarios', $filtros + ['por_pagina' => 20]);

        return ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]];
    }

    /** @return array<string, mixed> */
    public function obtener(int $id): array
    {
        return $this->gateway->get("usuarios/$id");
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function crear(array $cuerpo): array
    {
        return $this->gateway->enviar('POST', 'usuarios', $cuerpo)->cuerpo;
    }

    /** @param  array<string, mixed>  $cuerpo */
    public function actualizar(int $id, array $cuerpo): array
    {
        return $this->gateway->enviar('PUT', "usuarios/$id", $cuerpo)->cuerpo;
    }

    public function cambiarEstado(int $id, bool $activar): array
    {
        return $this->gateway->enviar('POST', "usuarios/$id/".($activar ? 'activar' : 'inactivar'), [])->cuerpo;
    }

    public function restablecerContrasena(int $id, string $temporal): void
    {
        $this->gateway->enviar('POST', "usuarios/$id/restablecer-contrasena", ['contrasena_temporal' => $temporal]);
    }

    /** @return array<int, string> id_rol → nombre del rol (ADMINISTRADOR, OPERADOR_BODEGA...) */
    public function roles(): array
    {
        return Cache::remember('roles', 3600, function (): array {
            $roles = [];
            foreach ($this->gateway->get('roles')['datos'] ?? [] as $rol) {
                $roles[(int) $rol['id_rol']] = (string) $rol['nombre'];
            }

            return $roles;
        });
    }
}
