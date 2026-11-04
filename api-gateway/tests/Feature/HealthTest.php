<?php

namespace Tests\Feature;

use Tests\TestCase;

class HealthTest extends TestCase
{
    public function test_health_responde_ok(): void
    {
        $this->getJson('/health')
            ->assertOk()
            ->assertExactJson(['estado' => 'ok', 'servicio' => 'api-gateway']);
    }

    public function test_health_no_exige_autenticacion_ni_cabeceras_especiales(): void
    {
        $this->get('/health', ['Accept' => 'text/html'])
            ->assertOk()
            ->assertExactJson(['estado' => 'ok', 'servicio' => 'api-gateway']);
    }

    public function test_ruta_inexistente_usa_el_formato_comun_de_error(): void
    {
        $this->getJson('/ruta-inexistente')
            ->assertStatus(404)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'NO_EXISTE',
                    'mensaje' => 'El recurso no existe.',
                    'detalles' => [],
                ],
            ]);
    }

    public function test_la_ruta_up_del_esqueleto_ya_no_esta_publicada(): void
    {
        $this->getJson('/up')
            ->assertStatus(404)
            ->assertJsonPath('error.codigo', 'NO_EXISTE');
    }
}
