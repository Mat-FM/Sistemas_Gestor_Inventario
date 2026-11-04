<?php

namespace Tests\Feature;

use App\Exceptions\ApiException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

class ErrorFormatTest extends TestCase
{
    private const SECRETO = 'clave-interna-que-no-debe-salir-9f3a';

    protected function setUp(): void
    {
        parent::setUp();

        Route::get('/_prueba/conflicto', fn () => throw ApiException::conflicto('CORREO_DUPLICADO', 'El correo ya existe.'));
        Route::get('/_prueba/con-detalles', fn () => throw new ApiException(
            400,
            'PETICION_MAL_FORMADA',
            'La petición está mal formada.',
            [['campo' => 'por_pagina', 'mensaje' => 'Debe ser un número.']],
        ));
        Route::post('/_prueba/validacion', function (Request $request) {
            $request->validate(['nombre' => 'required|string', 'correo' => 'required|email']);
        });
        Route::get('/_prueba/no-autenticado', fn () => throw new AuthenticationException);
        Route::get('/_prueba/limitada', fn () => response()->json(['ok' => true]))->middleware('throttle:1,1');
        Route::get('/_prueba/error-interno', fn () => throw new RuntimeException(self::SECRETO));
    }

    public function test_api_exception_se_renderiza_con_su_estado_y_codigo(): void
    {
        $this->getJson('/_prueba/conflicto')
            ->assertStatus(409)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'CORREO_DUPLICADO',
                    'mensaje' => 'El correo ya existe.',
                    'detalles' => [],
                ],
            ]);
    }

    public function test_api_exception_conserva_sus_detalles(): void
    {
        $this->getJson('/_prueba/con-detalles')
            ->assertStatus(400)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'PETICION_MAL_FORMADA',
                    'mensaje' => 'La petición está mal formada.',
                    'detalles' => [['campo' => 'por_pagina', 'mensaje' => 'Debe ser un número.']],
                ],
            ]);
    }

    public function test_api_exception_no_se_registra_como_error_del_servidor(): void
    {
        Log::spy();

        $this->getJson('/_prueba/conflicto')->assertStatus(409);

        Log::shouldNotHaveReceived('error');
    }

    public function test_validacion_fallida_es_422_con_detalles_por_campo(): void
    {
        $this->postJson('/_prueba/validacion', ['correo' => 'no-es-un-correo'])
            ->assertStatus(422)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'DATOS_NO_VALIDOS',
                    'mensaje' => 'Los datos enviados no son válidos.',
                    'detalles' => [
                        ['campo' => 'nombre', 'mensaje' => __('validation.required', ['attribute' => 'nombre'])],
                        ['campo' => 'correo', 'mensaje' => __('validation.email', ['attribute' => 'correo'])],
                    ],
                ],
            ]);
    }

    public function test_responde_json_aunque_el_cliente_no_lo_pida(): void
    {
        $this->post('/_prueba/validacion', [], ['Accept' => 'text/html'])
            ->assertStatus(422)
            ->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS');

        $this->get('/ruta-inexistente', ['Accept' => 'text/html'])
            ->assertStatus(404)
            ->assertJsonPath('error.codigo', 'NO_EXISTE');
    }

    public function test_autenticacion_fallida_es_401_con_el_formato_comun(): void
    {
        $this->getJson('/_prueba/no-autenticado')
            ->assertStatus(401)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'NO_AUTENTICADO',
                    'mensaje' => 'No autenticado.',
                    'detalles' => [],
                ],
            ]);
    }

    public function test_limite_de_peticiones_es_429_y_conserva_retry_after(): void
    {
        $this->getJson('/_prueba/limitada')->assertOk();

        $respuesta = $this->getJson('/_prueba/limitada');

        $respuesta->assertStatus(429)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'DEMASIADAS_PETICIONES',
                    'mensaje' => 'Demasiadas peticiones. Intente de nuevo más tarde.',
                    'detalles' => [],
                ],
            ]);
        $this->assertTrue($respuesta->headers->has('Retry-After'));
        $espera = (int) $respuesta->headers->get('Retry-After');
        $this->assertGreaterThan(0, $espera);
        $this->assertLessThanOrEqual(60, $espera);
    }

    public function test_una_respuesta_http_lanzada_como_excepcion_no_se_convierte_en_error_interno(): void
    {
        // Laravel atrapa HttpResponseException dentro de la acción de la ruta; solo llega al manejador
        // cuando la lanza un middleware, así que se prueba el manejador directamente.
        $manejador = $this->app->make(ExceptionHandler::class);

        $respuesta = $manejador->render(
            Request::create('/_prueba/respuesta-propia'),
            new HttpResponseException(response('hecho a mano', 202)),
        );

        $this->assertSame(202, $respuesta->getStatusCode());
        $this->assertSame('hecho a mano', $respuesta->getContent());
    }

    /** @return array<string, array{bool}> */
    public static function modosDeDepuracion(): array
    {
        return ['con APP_DEBUG verdadero' => [true], 'con APP_DEBUG falso' => [false]];
    }

    #[DataProvider('modosDeDepuracion')]
    public function test_error_no_controlado_es_500_sin_filtrar_el_stack(bool $depuracion): void
    {
        config(['app.debug' => $depuracion]);
        Log::spy();

        $respuesta = $this->getJson('/_prueba/error-interno');

        $respuesta->assertStatus(500)
            ->assertExactJson([
                'error' => [
                    'codigo' => 'ERROR_INTERNO',
                    'mensaje' => 'Error interno del servidor.',
                    'detalles' => [],
                ],
            ]);
        $cuerpo = $respuesta->getContent();
        $this->assertStringNotContainsString(self::SECRETO, $cuerpo);
        $this->assertStringNotContainsString('RuntimeException', $cuerpo);
        $this->assertStringNotContainsString('trace', $cuerpo);
        $this->assertStringNotContainsString(basename(__FILE__), $cuerpo);

        Log::shouldHaveReceived('error')
            ->withArgs(fn (string $mensaje, array $contexto) => $mensaje === self::SECRETO
                && ($contexto['exception'] ?? null) instanceof RuntimeException)
            ->once();
    }
}
