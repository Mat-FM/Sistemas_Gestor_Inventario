<?php

namespace Tests\Feature;

use App\Exceptions\ApiException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

class HttpErrorMappingTest extends TestCase
{
    private const INTERNO = 'detalle-interno-sensible-7c1e';

    protected function setUp(): void
    {
        parent::setUp();

        Route::get('/_prueba/abortar/{estado}', fn (int $estado) => abort($estado));
        Route::get('/_prueba/abortar-con-cabeceras/{estado}', fn (int $estado) => abort(
            $estado,
            self::INTERNO,
            ['Retry-After' => '30', 'X-Interno' => 'valor'],
        ));
        Route::get('/_prueba/sin-autorizacion', fn () => throw new AuthorizationException(self::INTERNO));
        Route::get('/_prueba/servicio-caido', fn () => throw ApiException::servicioNoDisponible());
    }

    /** @return array<string, array{int, int, string, string}> */
    public static function estadosHttp(): array
    {
        $malFormada = 'La petición está mal formada.';
        $interno = 'Error interno del servidor.';

        return [
            '400' => [400, 400, 'PETICION_MAL_FORMADA', $malFormada],
            '401' => [401, 401, 'NO_AUTENTICADO', 'No autenticado.'],
            '403' => [403, 403, 'SIN_PERMISO', 'No tiene permiso para realizar esta acción.'],
            '404' => [404, 404, 'NO_EXISTE', 'El recurso no existe.'],
            '405' => [405, 405, 'PETICION_MAL_FORMADA', 'Método no permitido.'],
            '409' => [409, 409, 'CONFLICTO', 'Conflicto con el estado actual del recurso.'],
            '413' => [413, 413, 'PETICION_MAL_FORMADA', $malFormada],
            '419' => [419, 419, 'PETICION_MAL_FORMADA', $malFormada],
            '422' => [422, 422, 'DATOS_NO_VALIDOS', 'Los datos enviados no son válidos.'],
            '429' => [429, 429, 'DEMASIADAS_PETICIONES', 'Demasiadas peticiones. Intente de nuevo más tarde.'],
            '503' => [503, 503, 'SERVICIO_NO_DISPONIBLE', 'El servicio no está disponible.'],
            '500' => [500, 500, 'ERROR_INTERNO', $interno],
            '501' => [501, 500, 'ERROR_INTERNO', $interno],
            '502' => [502, 500, 'ERROR_INTERNO', $interno],
            '504' => [504, 500, 'ERROR_INTERNO', $interno],
        ];
    }

    #[DataProvider('estadosHttp')]
    public function test_abort_conserva_el_estado_y_usa_el_codigo_comun(int $abortado, int $estado, string $codigo, string $mensaje): void
    {
        $this->getJson("/_prueba/abortar/{$abortado}")
            ->assertStatus($estado)
            ->assertExactJson(['error' => ['codigo' => $codigo, 'mensaje' => $mensaje, 'detalles' => []]]);
    }

    public function test_metodo_no_permitido_es_405_con_allow_y_peticion_mal_formada(): void
    {
        Log::spy();

        $respuesta = $this->postJson('/health');

        $respuesta->assertStatus(405)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'PETICION_MAL_FORMADA',
                    'mensaje' => 'Método no permitido.',
                    'detalles' => [],
                ],
            ]);
        $this->assertTrue($respuesta->headers->has('Allow'));
        $this->assertStringContainsString('GET', $respuesta->headers->get('Allow'));
        Log::shouldNotHaveReceived('error');
    }

    public function test_una_excepcion_de_autorizacion_es_403_sin_permiso(): void
    {
        Log::spy();

        $this->getJson('/_prueba/sin-autorizacion')
            ->assertStatus(403)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'SIN_PERMISO',
                    'mensaje' => 'No tiene permiso para realizar esta acción.',
                    'detalles' => [],
                ],
            ]);
        Log::shouldNotHaveReceived('error');
    }

    public function test_las_cabeceras_de_una_excepcion_http_con_estado_propio_se_conservan(): void
    {
        $respuesta = $this->getJson('/_prueba/abortar-con-cabeceras/503');

        $respuesta->assertStatus(503)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'SERVICIO_NO_DISPONIBLE',
                    'mensaje' => 'El servicio no está disponible.',
                    'detalles' => [],
                ],
            ]);
        $respuesta->assertHeader('Retry-After', '30');
        $respuesta->assertHeader('X-Interno', 'valor');
        $this->assertStringNotContainsString(self::INTERNO, $respuesta->getContent());
    }

    /** @return array<string, array{bool}> */
    public static function modosDeDepuracion(): array
    {
        return ['con APP_DEBUG verdadero' => [true], 'con APP_DEBUG falso' => [false]];
    }

    #[DataProvider('modosDeDepuracion')]
    public function test_un_5xx_http_es_500_generico_sin_cabeceras_ni_traza_y_se_registra(bool $depuracion): void
    {
        config(['app.debug' => $depuracion]);
        Log::spy();

        $respuesta = $this->getJson('/_prueba/abortar-con-cabeceras/502');

        $respuesta->assertStatus(500)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'ERROR_INTERNO',
                    'mensaje' => 'Error interno del servidor.',
                    'detalles' => [],
                ],
            ]);
        $respuesta->assertHeaderMissing('Retry-After');
        $respuesta->assertHeaderMissing('X-Interno');
        $this->assertStringNotContainsString(self::INTERNO, $respuesta->getContent());
        $this->assertStringNotContainsString('trace', $respuesta->getContent());

        Log::shouldHaveReceived('error')
            ->withArgs(fn (string $mensaje, array $contexto) => ($contexto['exception'] ?? null) instanceof HttpException
                && $contexto['exception']->getStatusCode() === 502
                && $mensaje === self::INTERNO)
            ->once();
    }

    /** @return array<string, array{int}> */
    public static function estados4xx(): array
    {
        return [
            '400' => [400],
            '401' => [401],
            '403' => [403],
            '404' => [404],
            '409' => [409],
            '413' => [413],
            '422' => [422],
            '429' => [429],
        ];
    }

    #[DataProvider('estados4xx')]
    public function test_un_4xx_http_no_llega_al_log_de_errores(int $estado): void
    {
        Log::spy();

        $this->getJson("/_prueba/abortar/{$estado}")->assertStatus($estado);

        Log::shouldNotHaveReceived('error');
    }

    public function test_un_api_exception_5xx_si_llega_al_log_de_errores(): void
    {
        Log::spy();

        $this->getJson('/_prueba/servicio-caido')
            ->assertStatus(503)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'SERVICIO_NO_DISPONIBLE',
                    'mensaje' => 'El servicio no está disponible.',
                    'detalles' => [],
                ],
            ]);

        Log::shouldHaveReceived('error')
            ->withArgs(fn (string $mensaje, array $contexto) => ($contexto['exception'] ?? null) instanceof ApiException
                && $contexto['exception']->status === 503)
            ->once();
    }
}
