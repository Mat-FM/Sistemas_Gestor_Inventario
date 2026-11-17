<?php

namespace App\Services;

use App\Gateway\GatewayClient;

/** Acceso a ms-notificaciones a través del Gateway: alertas de cada rol, preferencia de correo y configuración (RF09, RF17). */
class Notificaciones
{
    public function __construct(private readonly GatewayClient $gateway) {}

    /**
     * @param  array<string, scalar|null>  $filtros  leida, tipo, pagina, por_pagina
     * @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>}
     */
    public function listar(array $filtros = []): array
    {
        $respuesta = $this->gateway->get('notificaciones', $filtros + ['por_pagina' => 20]);

        return ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]];
    }

    public function sinLeer(): int
    {
        return (int) ($this->listar(['leida' => 'false', 'por_pagina' => 1])['meta']['total'] ?? 0);
    }

    public function marcarLeida(int $id): array
    {
        return $this->gateway->enviar('POST', "notificaciones/$id/leida", [])->cuerpo;
    }

    /** @return array{id_usuario: int, rol: string, correo: string|null, recibir_correo: bool} */
    public function preferencia(): array
    {
        return $this->gateway->get('preferencias/mia');
    }

    public function guardarPreferencia(bool $recibirCorreo, ?string $correo): array
    {
        return $this->gateway->enviar('PUT', 'preferencias/mia', ['recibir_correo' => $recibirCorreo, 'correo' => $correo])->cuerpo;
    }

    /** @return array{dias_anticipacion_vencimiento: int, hora_revision_diaria: string} */
    public function configuracion(): array
    {
        return $this->gateway->get('configuracion-alertas');
    }

    public function guardarConfiguracion(int $dias, string $hora): array
    {
        return $this->gateway->enviar('PUT', 'configuracion-alertas', ['dias_anticipacion_vencimiento' => $dias, 'hora_revision_diaria' => $hora])->cuerpo;
    }
}
