<?php

namespace Tests\Feature;

use App\Support\Roles;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use Monolog\Handler\TestHandler;
use Monolog\Level;
use Monolog\LogRecord;
use RuntimeException;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Todo registro emitido durante una petición de /api lleva el `request_id` que recibió el cliente en
 * `X-Request-Id` (RNF10), también los errores 5xx que registra el manejador de excepciones, y ese identificador no
 * sobrevive a la petición (RNF05). Se usa un registrador real (Monolog TestHandler), no un espía: el contexto
 * compartido lo añade el Logger al escribir, y un espía no lo vería.
 */
class RequestIdEnElRegistroTest extends TestCase
{
    use ApiHelpers;

    private TestHandler $registro;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'logging.channels.prueba' => ['driver' => 'monolog', 'handler' => TestHandler::class],
            'logging.default' => 'prueba',
        ]);
        $this->registro = Log::channel('prueba')->getLogger()->getHandlers()[0];

        Route::middleware('api')->get('/api/_prueba/explota', fn () => throw new RuntimeException('fallo de prueba'));
        Route::middleware('api')->get('/api/_prueba/bien', fn () => response()->json(['ok' => true]));
    }

    /** @return list<LogRecord> */
    private function errores(): array
    {
        return array_values(array_filter($this->registro->getRecords(), fn (LogRecord $r): bool => $r->level === Level::Error));
    }

    private function idDe(TestResponse $respuesta): string
    {
        $id = $respuesta->headers->get('X-Request-Id');
        $this->assertIsString($id);
        $this->assertNotSame('', $id);

        return $id;
    }

    public function test_el_error_500_registrado_lleva_el_request_id_de_la_respuesta(): void
    {
        $respuesta = $this->getJson('/api/_prueba/explota')->assertStatus(500)->assertJsonPath('error.codigo', 'ERROR_INTERNO');

        $errores = $this->errores();
        $this->assertCount(1, $errores);
        $this->assertSame('fallo de prueba', $errores[0]->message);
        $this->assertSame($this->idDe($respuesta), $errores[0]->context['request_id'] ?? null);
    }

    public function test_los_registros_del_503_del_proxy_llevan_el_request_id_de_la_respuesta(): void
    {
        Http::fake(fn () => throw new ConnectionException('cURL error 28: Operation timed out'));

        $respuesta = $this->conSesion($this->usuario(Roles::ADM))->getJson('/api/productos')
            ->assertStatus(503)
            ->assertJsonPath('error.codigo', 'SERVICIO_NO_DISPONIBLE');
        $id = $this->idDe($respuesta);

        // La línea propia del proxy y la del manejador de excepciones (todo 5xx se registra).
        $errores = $this->errores();
        $this->assertSame(['servicio_no_disponible', 'El servicio no está disponible.'], array_map(fn (LogRecord $r) => $r->message, $errores));
        foreach ($errores as $error) {
            $this->assertSame($id, $error->context['request_id'] ?? null, "El registro «{$error->message}» no lleva el request_id.");
        }
    }

    public function test_dos_peticiones_seguidas_tienen_request_id_distintos_y_no_se_arrastran(): void
    {
        $primera = $this->idDe($this->getJson('/api/_prueba/explota')->assertStatus(500));

        // Fuera de una petición ya no queda ningún request_id compartido.
        $this->assertArrayNotHasKey('request_id', Log::sharedContext());
        Log::info('entre_peticiones');

        $segunda = $this->idDe($this->getJson('/api/_prueba/explota')->assertStatus(500));
        $this->assertNotSame($primera, $segunda);

        $errores = $this->errores();
        $this->assertCount(2, $errores);
        $this->assertSame($primera, $errores[0]->context['request_id'] ?? null);
        $this->assertSame($segunda, $errores[1]->context['request_id'] ?? null);

        $entre = array_values(array_filter($this->registro->getRecords(), fn (LogRecord $r): bool => $r->message === 'entre_peticiones'));
        $this->assertCount(1, $entre);
        $this->assertArrayNotHasKey('request_id', $entre[0]->context);
        $this->assertArrayNotHasKey('request_id', Log::sharedContext());
    }

    public function test_la_linea_peticion_sigue_teniendo_exactamente_las_claves_del_contrato(): void
    {
        $id = $this->idDe($this->getJson('/api/_prueba/bien')->assertOk());

        $lineas = array_values(array_filter($this->registro->getRecords(), fn (LogRecord $r): bool => $r->message === 'peticion'));
        $this->assertCount(1, $lineas);
        $this->assertEqualsCanonicalizing(
            ['servicio', 'request_id', 'metodo', 'ruta', 'estado', 'id_usuario', 'duracion_ms'],
            array_keys($lineas[0]->context),
        );
        $this->assertSame($id, $lineas[0]->context['request_id']);
        $this->assertSame([], $lineas[0]->extra);
    }
}
