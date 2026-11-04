<?php

namespace Tests\Feature;

use App\Services\Jwt\JwtService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * GET /health es la sonda de readiness: 200 solo si el Gateway puede atender (JwtService se construye y las seis
 * URLs de servicio son http(s) válidas); si no, 503 con la forma común de error, sin decir qué falla, y el motivo
 * (el nombre de la variable, nunca su valor) en el registro.
 */
class HealthTest extends TestCase
{
    private const SECRETO_CORTO = 'secreto-corto-de-31-caracteres!';

    /** @return array<string, array{string, string}> servicio => variable de entorno */
    public static function servicios(): array
    {
        return [
            'ms-catalogo' => ['ms-catalogo', 'MS_CATALOGO_URL'],
            'ms-proveedores' => ['ms-proveedores', 'MS_PROVEEDORES_URL'],
            'ms-inventario' => ['ms-inventario', 'MS_INVENTARIO_URL'],
            'ms-compras' => ['ms-compras', 'MS_COMPRAS_URL'],
            'ms-notificaciones' => ['ms-notificaciones', 'MS_NOTIFICACIONES_URL'],
            'ms-reportes' => ['ms-reportes', 'MS_REPORTES_URL'],
        ];
    }

    /** Fija la configuración y descarta el JwtService ya construido, como si el proceso arrancara con ella. */
    private function conConfiguracion(array $valores): void
    {
        config($valores);
        $this->app->forgetInstance(JwtService::class);
    }

    private function assertNoDisponible(TestResponse $respuesta): void
    {
        $respuesta->assertStatus(503)->assertExactJson([
            'error' => [
                'codigo' => 'SERVICIO_NO_DISPONIBLE',
                'mensaje' => 'El servicio no está disponible.',
                'detalles' => [],
            ],
        ]);
    }

    /**
     * Exige un único registro de error con el motivo indicado y sin ninguno de los valores sensibles.
     *
     * @param  list<string>  $valoresProhibidos
     */
    private function assertRegistroDelMotivo(string $motivo, array $valoresProhibidos): void
    {
        Log::shouldHaveReceived('error')->once()->withArgs(function (string $mensaje, array $contexto) use ($motivo, $valoresProhibidos): bool {
            $linea = $mensaje.' '.json_encode($contexto, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            foreach ($valoresProhibidos as $valor) {
                if (str_contains($linea, $valor)) {
                    return false;
                }
            }

            return $mensaje === 'configuracion_no_valida' && in_array($motivo, $contexto['motivos'] ?? [], true);
        });
    }

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

    public function test_health_correcto_no_registra_errores_ni_consulta_la_base(): void
    {
        Log::spy();
        DB::listen(fn () => $this->fail('GET /health no debe consultar la base de datos.'));

        $this->getJson('/health')->assertOk();

        Log::shouldNotHaveReceived('error');
    }

    public function test_sin_jwt_secret_es_503(): void
    {
        $this->conConfiguracion(['gateway.jwt.secret' => '']);
        Log::spy();

        $this->assertNoDisponible($this->getJson('/health'));
        $this->assertRegistroDelMotivo('JWT_SECRET', []);
    }

    public function test_con_jwt_secret_de_31_caracteres_es_503_sin_revelar_el_secreto(): void
    {
        $this->assertSame(31, strlen(self::SECRETO_CORTO));
        $this->conConfiguracion(['gateway.jwt.secret' => self::SECRETO_CORTO]);
        Log::spy();

        $respuesta = $this->getJson('/health');

        $this->assertNoDisponible($respuesta);
        $this->assertStringNotContainsString(self::SECRETO_CORTO, (string) $respuesta->getContent());
        $this->assertRegistroDelMotivo('JWT_SECRET', [self::SECRETO_CORTO]);
    }

    public function test_con_un_jwt_secret_valido_de_32_caracteres_es_200(): void
    {
        $this->conConfiguracion(['gateway.jwt.secret' => str_repeat('s', 32)]);

        $this->getJson('/health')->assertOk();
    }

    public function test_con_una_vigencia_del_jwt_no_valida_es_503(): void
    {
        $this->conConfiguracion(['gateway.jwt.ttl_minutes' => 0]);
        Log::spy();

        $this->assertNoDisponible($this->getJson('/health'));
        $this->assertRegistroDelMotivo('JWT_TTL_MINUTES', []);
    }

    #[DataProvider('servicios')]
    public function test_una_url_de_servicio_vacia_es_503(string $servicio, string $variable): void
    {
        $this->conConfiguracion(["gateway.services.{$servicio}" => '']);
        Log::spy();

        $this->assertNoDisponible($this->getJson('/health'));
        $this->assertRegistroDelMotivo($variable, []);
    }

    #[DataProvider('servicios')]
    public function test_una_url_de_servicio_ausente_es_503(string $servicio, string $variable): void
    {
        $servicios = config('gateway.services');
        unset($servicios[$servicio]);
        $this->conConfiguracion(['gateway.services' => $servicios]);
        Log::spy();

        $this->assertNoDisponible($this->getJson('/health'));
        $this->assertRegistroDelMotivo($variable, []);
    }

    /** @return array<string, array{string}> */
    public static function urlsNoValidas(): array
    {
        return [
            'sin esquema' => ['ms-catalogo-interno:8000'],
            'otro esquema' => ['ftp://ms-catalogo-interno:8000'],
            'esquema de archivo' => ['file:///etc/ms-catalogo-interno'],
            'solo el esquema' => ['http://'],
            'con espacios' => ['http://ms catalogo-interno:8000'],
        ];
    }

    #[DataProvider('urlsNoValidas')]
    public function test_una_url_de_servicio_no_valida_es_503_sin_revelarla(string $url): void
    {
        $this->conConfiguracion(['gateway.services.ms-catalogo' => $url]);
        Log::spy();

        $respuesta = $this->getJson('/health');

        $this->assertNoDisponible($respuesta);
        $this->assertStringNotContainsString('catalogo-interno', (string) $respuesta->getContent());
        $this->assertRegistroDelMotivo('MS_CATALOGO_URL', ['catalogo-interno', $url]);
    }

    public function test_https_tambien_es_una_url_valida(): void
    {
        $this->conConfiguracion(['gateway.services.ms-reportes' => 'https://ms-reportes.example.test:5000']);

        $this->getJson('/health')->assertOk();
    }

    public function test_con_varios_fallos_el_registro_los_nombra_todos_sin_valores(): void
    {
        $this->conConfiguracion([
            'gateway.jwt.secret' => self::SECRETO_CORTO,
            'gateway.services.ms-compras' => 'ftp://ms-compras-interno:3000',
        ]);
        Log::spy();

        $this->assertNoDisponible($this->getJson('/health'));

        Log::shouldHaveReceived('error')->once()->withArgs(fn (string $m, array $c): bool => $c === ['motivos' => ['JWT_SECRET', 'MS_COMPRAS_URL']]);
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
