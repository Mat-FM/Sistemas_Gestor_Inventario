<?php

namespace Tests\Feature;

use Tests\TestCase;

class ExampleTest extends TestCase
{
    /**
     * Una ruta que no existe responde 404 con la forma común de error.
     */
    public function test_una_ruta_inexistente_responde_404_con_la_forma_comun(): void
    {
        $response = $this->get('/ruta-que-no-existe');

        $response->assertStatus(404)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'NO_EXISTE',
                    'mensaje' => 'El recurso no existe.',
                    'detalles' => [],
                ],
            ]);
    }
}
