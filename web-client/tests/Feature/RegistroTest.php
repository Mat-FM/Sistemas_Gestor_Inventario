<?php

namespace Tests\Feature;

use App\Http\Middleware\ConfiarEnProxies;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use InvalidArgumentException;
use Tests\TestCase;

class RegistroTest extends TestCase
{
    public function test_cada_respuesta_trae_un_identificador_de_peticion_nuevo_y_se_descarta_el_del_cliente(): void
    {
        $primera = $this->withHeader('X-Request-Id', 'falsificado')->get('/login')->assertOk()->headers->get('X-Request-Id');
        $segunda = $this->get('/login')->headers->get('X-Request-Id');

        $this->assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $primera);
        $this->assertNotSame($primera, $segunda);
        $this->assertNotSame('falsificado', $primera);
    }

    public function test_cada_peticion_se_registra_sin_la_cadena_de_consulta_ni_datos_personales(): void
    {
        Log::spy();

        $this->conSesion('VENDEDOR')->get('/login?correo=ana@x.co&q=secreto');

        Log::shouldHaveReceived('info')->withArgs(function (string $mensaje, array $contexto) {
            return $mensaje === 'peticion'
                && $contexto['ruta'] === '/login'
                && $contexto['metodo'] === 'GET'
                && $contexto['estado'] === 302
                && $contexto['id_usuario'] === 7
                && array_keys($contexto) === ['metodo', 'ruta', 'estado', 'id_usuario', 'duracion_ms'];
        })->once();
    }

    public function test_un_fallo_del_gateway_se_anota_con_el_identificador_que_el_gateway_devolvio(): void
    {
        Log::spy();
        $this->fingirGateway(['GET saldos' => Http::response(['error' => ['codigo' => 'SERVICIO_NO_DISPONIBLE', 'mensaje' => '', 'detalles' => []]], 503, ['X-Request-Id' => 'id-del-gateway'])]);

        $this->conSesion('VENDEDOR')->get('/stock')->assertOk();   // el bloque de la pantalla avisa sin romper la página
        Log::shouldNotHaveReceived('error');

        $this->fingirGateway(['GET productos/1' => Http::response(['error' => ['codigo' => 'ERROR_INTERNO', 'mensaje' => '', 'detalles' => []]], 500, ['X-Request-Id' => 'id-del-gateway'])]);
        $this->conSesion('ADMINISTRADOR')->get('/movimientos/nuevo?tipo=SALIDA&id_producto=1')->assertStatus(500);

        Log::shouldHaveReceived('error')->withArgs(fn (string $mensaje, array $contexto) => $mensaje === 'gateway_error' && $contexto['gateway_request_id'] === 'id-del-gateway' && $contexto['estado'] === 500)->once();
    }

    public function test_los_proxies_de_confianza_son_ips_o_cidr_concretos_y_nunca_todos(): void
    {
        $this->assertSame([], ConfiarEnProxies::analizar(''));
        $this->assertSame(['10.0.0.0/8', '192.168.1.5', '::1'], ConfiarEnProxies::analizar(' 10.0.0.0/8, 192.168.1.5 ,,::1 '));

        foreach (['*', '0.0.0.0/0', 'REMOTE_ADDR', 'no-es-ip', '10.0.0.0/33'] as $mala) {
            try {
                ConfiarEnProxies::analizar($mala);
                $this->fail("«{$mala}» debía rechazarse");
            } catch (InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_solo_si_el_proxy_es_de_confianza_se_usa_la_ip_del_cliente_que_este_servicio_reenvia_al_gateway(): void
    {
        $this->fingirGateway(['POST auth/login' => self::error(401, 'CREDENCIALES_INVALIDAS')]);

        config(['gateway.trusted_proxies' => '']);
        $this->withServerVariables(['REMOTE_ADDR' => '10.1.2.3'])->withHeader('X-Forwarded-For', '203.0.113.9')->post('/login', ['correo' => 'a@x.co', 'contrasena' => 'x']);
        $this->assertTrue($this->seEnvio('POST', 'auth/login', fn ($p) => $p->header('X-Forwarded-For') === ['10.1.2.3']));

        config(['gateway.trusted_proxies' => '10.0.0.0/8']);
        $this->fingirGateway(['POST auth/login' => self::error(401, 'CREDENCIALES_INVALIDAS')]);
        $this->withServerVariables(['REMOTE_ADDR' => '10.1.2.3'])->withHeader('X-Forwarded-For', '203.0.113.9')->post('/login', ['correo' => 'a@x.co', 'contrasena' => 'x']);
        $this->assertTrue($this->seEnvio('POST', 'auth/login', fn ($p) => $p->header('X-Forwarded-For') === ['203.0.113.9']));
    }
}
