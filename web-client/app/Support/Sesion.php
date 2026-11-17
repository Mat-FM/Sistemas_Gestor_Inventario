<?php

namespace App\Support;

/**
 * Lo único que el cliente guarda de la sesión: el token del Gateway y los datos del usuario que devolvió el inicio de
 * sesión. Va en la sesión del servidor (cookie cifrada y HttpOnly): nunca en el HTML ni en JavaScript.
 */
class Sesion
{
    private const TOKEN = 'gateway.token';

    private const VENCE = 'gateway.vence';

    private const USUARIO = 'gateway.usuario';

    /**
     * @param  array{token: string, expira_en: int, usuario: array<string, mixed>}  $inicio  Respuesta de POST /auth/login.
     */
    public function iniciar(array $inicio): void
    {
        session()->regenerate();
        session()->put(self::TOKEN, $inicio['token']);
        session()->put(self::VENCE, time() + (int) ($inicio['expira_en'] ?? 3600));
        session()->put(self::USUARIO, $inicio['usuario']);
    }

    public function cerrar(): void
    {
        session()->invalidate();
        session()->regenerateToken();
    }

    public function token(): ?string
    {
        return session(self::TOKEN);
    }

    public function activa(): bool
    {
        return $this->token() !== null && (int) session(self::VENCE, 0) > time();
    }

    /** @return array<string, mixed>|null */
    public function usuario(): ?array
    {
        return session(self::USUARIO);
    }

    public function rol(): ?string
    {
        return $this->usuario()['rol'] ?? null;
    }

    public function idBodega(): ?int
    {
        $id = $this->usuario()['id_bodega'] ?? null;

        return $id === null ? null : (int) $id;
    }

    public function nombre(): string
    {
        return (string) ($this->usuario()['nombre'] ?? '');
    }

    public function debeCambiarContrasena(): bool
    {
        return (bool) ($this->usuario()['debe_cambiar_contrasena'] ?? false);
    }

    public function marcarCambioPendiente(bool $pendiente): void
    {
        $usuario = $this->usuario() ?? [];
        $usuario['debe_cambiar_contrasena'] = $pendiente;
        session()->put(self::USUARIO, $usuario);
    }
}
