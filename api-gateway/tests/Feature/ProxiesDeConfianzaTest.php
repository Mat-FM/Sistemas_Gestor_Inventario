<?php

namespace Tests\Feature;

use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Proxies de confianza por entorno (`TRUSTED_PROXIES`). Detrás de un Service o un Ingress de Kubernetes,
 * `$request->ip()` es la IP del intermediario salvo que se confíe en él; sin eso, el límite de inicio de sesión
 * por IP pasa a ser global. Con la variable vacía, las cabeceras `X-Forwarded-*` se ignoran siempre.
 */
class ProxiesDeConfianzaTest extends TestCase
{
    use ApiHelpers;

    private const PROXY = '10.1.2.3';

    private const CLIENTE = '203.0.113.9';

    private const OTRO_CLIENTE = '203.0.113.10';

    protected function setUp(): void
    {
        parent::setUp();
        TrustProxies::flushState();

        Route::get('/_prueba/ip', fn (Request $request) => response()->json([
            'ip' => $request->ip(),
            'esquema' => $request->getScheme(),
            'host' => $request->getHost(),
        ]));
    }

    protected function tearDown(): void
    {
        TrustProxies::flushState();
        Request::setTrustedProxies([], -1);
        parent::tearDown();
    }

    private function confiarEn(?string $valor): void
    {
        config(['gateway.trusted_proxies' => $valor]);
    }

    /** @param  array<string, string>  $cabeceras */
    private function pedirIp(string $desde, array $cabeceras = []): TestResponse
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $desde])->getJson('/_prueba/ip', $cabeceras);
    }

    private function login(string $desde, string $cliente): TestResponse
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $desde])
            ->postJson('/api/auth/login', ['correo' => 'x@example.test', 'contrasena' => 'mala'], ['X-Forwarded-For' => $cliente]);
    }

    public function test_el_env_example_trae_trusted_proxies_vacia_y_documentada(): void
    {
        $ejemplo = (string) file_get_contents(base_path('.env.example'));

        $this->assertMatchesRegularExpression('/^TRUSTED_PROXIES=\s*$/m', $ejemplo);
        $this->assertMatchesRegularExpression('/^#.*TRUSTED_PROXIES|^#.*proxies/mi', $ejemplo);
    }

    public function test_la_configuracion_sale_de_la_variable_trusted_proxies(): void
    {
        $this->assertSame('', config('gateway.trusted_proxies'));
    }

    public function test_sin_configuracion_x_forwarded_for_se_ignora(): void
    {
        $this->confiarEn('');

        $this->pedirIp(self::PROXY, ['X-Forwarded-For' => self::CLIENTE, 'X-Forwarded-Proto' => 'https'])
            ->assertOk()
            ->assertJsonPath('ip', self::PROXY)
            ->assertJsonPath('esquema', 'http');
    }

    public function test_sin_configuracion_un_host_de_forge_o_vapor_no_hace_confiar_en_todos(): void
    {
        // El TrustProxies de Laravel confía en `*` si el Host (que pone el cliente) termina en .on-forge.com o
        // .on-vapor.com y no hay proxies configurados: un cliente podría falsificar su IP con X-Forwarded-For.
        $this->confiarEn('');

        foreach (['gateway.on-forge.com', 'gateway.on-vapor.com'] as $host) {
            $this->withServerVariables(['REMOTE_ADDR' => self::PROXY])
                ->getJson("http://{$host}/_prueba/ip", ['X-Forwarded-For' => self::CLIENTE])
                ->assertOk()
                ->assertJsonPath('host', $host)
                ->assertJsonPath('ip', self::PROXY);
        }
    }

    public function test_el_trust_proxies_por_defecto_de_laravel_si_confia_en_todos_con_un_host_de_forge(): void
    {
        // Documenta el problema que motivó ConfiarEnProxies: con el middleware por defecto y sin proxies
        // configurados, un Host de Forge hace que se acepte un X-Forwarded-For falso. Si esta prueba deja de
        // cumplirse, Laravel cambió ese comportamiento.
        $peticion = Request::create('http://gateway.on-forge.com/_prueba/ip', 'GET', server: ['REMOTE_ADDR' => self::PROXY]);
        $peticion->headers->set('X-Forwarded-For', self::CLIENTE);

        $ip = (new TrustProxies)->handle($peticion, fn (Request $r) => response($r->ip()))->getContent();

        $this->assertSame(self::CLIENTE, $ip);
    }

    public function test_con_un_cidr_de_confianza_se_usa_la_ip_del_cliente_real(): void
    {
        $this->confiarEn('10.0.0.0/8');

        $this->pedirIp(self::PROXY, [
            'X-Forwarded-For' => self::CLIENTE,
            'X-Forwarded-Proto' => 'https',
            'X-Forwarded-Host' => 'gateway.example.test',
            'X-Forwarded-Port' => '443',
        ])
            ->assertOk()
            ->assertJsonPath('ip', self::CLIENTE)
            ->assertJsonPath('esquema', 'https')
            ->assertJsonPath('host', 'gateway.example.test');
    }

    public function test_una_peticion_desde_una_ip_no_incluida_ignora_la_cabecera(): void
    {
        $this->confiarEn('10.0.0.0/8');

        $this->pedirIp('192.168.1.5', ['X-Forwarded-For' => self::CLIENTE])
            ->assertOk()
            ->assertJsonPath('ip', '192.168.1.5');
    }

    public function test_entradas_vacias_y_espacios_se_toleran(): void
    {
        $this->confiarEn(' , 192.168.0.1 ,, 10.0.0.0/8 , ');

        $this->pedirIp(self::PROXY, ['X-Forwarded-For' => self::CLIENTE])->assertJsonPath('ip', self::CLIENTE);
        $this->pedirIp('192.168.0.1', ['X-Forwarded-For' => self::OTRO_CLIENTE])->assertJsonPath('ip', self::OTRO_CLIENTE);
        $this->pedirIp('172.16.0.1', ['X-Forwarded-For' => self::CLIENTE])->assertJsonPath('ip', '172.16.0.1');
    }

    public function test_una_lista_solo_de_comas_y_espacios_equivale_a_vacia(): void
    {
        $this->confiarEn(' , ,');

        $this->pedirIp(self::PROXY, ['X-Forwarded-For' => self::CLIENTE])->assertOk()->assertJsonPath('ip', self::PROXY);
    }

    public function test_detras_del_mismo_proxy_el_limite_de_login_cuenta_por_cliente_real(): void
    {
        $this->confiarEn('10.0.0.0/8');

        for ($i = 0; $i < 10; $i++) {
            $this->login(self::PROXY, self::CLIENTE)->assertStatus(401);
        }
        $this->login(self::PROXY, self::CLIENTE)->assertStatus(429)->assertJsonPath('error.codigo', 'DEMASIADAS_PETICIONES');

        // Otro cliente detrás del mismo proxy tiene su propio contador.
        $this->login(self::PROXY, self::OTRO_CLIENTE)->assertStatus(401)->assertJsonPath('error.codigo', 'CREDENCIALES_INVALIDAS');
    }

    public function test_sin_proxies_de_confianza_el_limite_de_login_cuenta_por_la_ip_que_conecta(): void
    {
        $this->confiarEn('');

        for ($i = 0; $i < 10; $i++) {
            $this->login(self::PROXY, self::CLIENTE)->assertStatus(401);
        }

        // Cambiar X-Forwarded-For no da un contador nuevo si no se confía en el proxy.
        $this->login(self::PROXY, self::OTRO_CLIENTE)->assertStatus(429);
    }

    /** @return array<string, array{string}> */
    public static function valoresConComodin(): array
    {
        return [
            'solo el comodín' => ['*'],
            'comodín con espacios' => [' * '],
            'comodín junto a un cidr' => ['10.0.0.0/8,*'],
            'doble comodín' => ['**'],
            'REMOTE_ADDR confía en quien conecte' => ['REMOTE_ADDR'],
            'todo IPv4' => ['0.0.0.0/0'],
            'todo IPv6 junto a una IP' => ['10.0.0.1, ::/0'],
        ];
    }

    #[DataProvider('valoresConComodin')]
    public function test_el_comodin_se_rechaza_con_un_error_claro(string $valor): void
    {
        $this->confiarEn($valor);
        Log::spy();

        // Nunca se confía en todos: la petición falla (500 genérico, sin detalles) en vez de aceptar la cabecera.
        $this->pedirIp(self::PROXY, ['X-Forwarded-For' => self::CLIENTE])
            ->assertStatus(500)
            ->assertJsonPath('error.codigo', 'ERROR_INTERNO');

        Log::shouldHaveReceived('error')->withArgs(
            fn (string $mensaje): bool => str_contains($mensaje, 'TRUSTED_PROXIES no admite «*»')
        );
    }
}
