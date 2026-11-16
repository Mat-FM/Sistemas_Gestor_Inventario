<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Rutas de operación (/health, /docs), forma común de error y X-Request-Id (RNF08, RNF10).
 */
class HealthDocsTest extends TestCase
{
    use RefreshDatabase;

    public function test_health_responde_ok_si_la_base_responde(): void
    {
        $this->getJson('/health')
            ->assertOk()
            ->assertExactJson(['estado' => 'ok', 'servicio' => 'ms-catalogo']);
    }

    public function test_health_responde_503_si_la_base_no_responde(): void
    {
        // Una conexión a un archivo SQLite que no existe hace fallar la consulta.
        config([
            'database.connections.caida' => ['driver' => 'sqlite', 'database' => '/ruta/que/no/existe.sqlite'],
            'database.default' => 'caida',
        ]);

        $respuesta = $this->getJson('/health');

        // Se restaura la conexión para que RefreshDatabase pueda deshacer la transacción al terminar.
        config(['database.default' => 'sqlite']);

        $respuesta->assertStatus(503)
            ->assertJsonPath('error.codigo', 'SERVICIO_NO_DISPONIBLE');
    }

    public function test_docs_entrega_swagger_ui_y_el_documento_openapi(): void
    {
        $this->get('/docs')
            ->assertOk()
            ->assertHeader('Content-Type', 'text/html; charset=utf-8')
            ->assertSee('/docs/openapi.yaml');

        $this->get('/docs/openapi.yaml')
            ->assertOk()
            ->assertSee('openapi: 3.0.3');
    }

    public function test_una_ruta_inexistente_responde_404_con_la_forma_comun(): void
    {
        $this->getJson('/ruta-que-no-existe')
            ->assertStatus(404)
            ->assertExactJson(['error' => ['codigo' => 'NO_EXISTE', 'mensaje' => 'El recurso no existe.', 'detalles' => []]]);
    }

    public function test_un_metodo_no_permitido_responde_405(): void
    {
        $this->deleteJson('/productos')
            ->assertStatus(405)
            ->assertJsonPath('error.codigo', 'PETICION_MAL_FORMADA');
    }

    public function test_reutiliza_el_x_request_id_que_llega_o_genera_uno(): void
    {
        $this->getJson('/productos', ['X-Request-Id' => 'id-del-gateway'])
            ->assertHeader('X-Request-Id', 'id-del-gateway');

        // Un valor con caracteres no permitidos se reemplaza por uno nuevo.
        $generado = $this->getJson('/productos', ['X-Request-Id' => "malo\ninyectado"])->headers->get('X-Request-Id');
        $this->assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $generado);
    }
}
