<?php

namespace Tests\Feature;

use App\Http\Middleware\AuthenticateJwt;
use App\Http\Middleware\EnforcePasswordChange;
use App\Support\Roles;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Illuminate\Testing\TestResponse;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Límite de peticiones (RNF19): 100 por minuto por usuario autenticado y 10 intentos de inicio de sesión por
 * minuto por IP. En las pruebas el contador vive en el almacén `array` (phpunit.xml), que se reinicia con cada
 * prueba; en producción es `database`, compartido entre las copias del Gateway (RNF05).
 */
class RateLimitTest extends TestCase
{
    use ApiHelpers;

    private const IP_A = '10.0.0.1';

    private const IP_B = '10.0.0.2';

    private function login(string $correo = 'x@example.test', string $contrasena = 'mala'): TestResponse
    {
        return $this->postJson('/api/auth/login', ['correo' => $correo, 'contrasena' => $contrasena]);
    }

    private function desdeLaIp(string $ip): static
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $ip]);
    }

    /** 429 con la forma común de error y un `Retry-After` de entre 1 y 60 segundos. */
    private function assertDemasiadasPeticiones(TestResponse $respuesta): void
    {
        $respuesta->assertStatus(429)
            ->assertJsonPath('error.codigo', 'DEMASIADAS_PETICIONES')
            ->assertJsonPath('error.detalles', []);
        $this->assertNotSame('', trim((string) $respuesta->json('error.mensaje')));

        $reintentar = $respuesta->headers->get('Retry-After');
        $this->assertNotNull($reintentar, 'Falta la cabecera Retry-After.');
        $this->assertMatchesRegularExpression('/^\d+$/', $reintentar);
        $this->assertGreaterThan(0, (int) $reintentar);
        $this->assertLessThanOrEqual(60, (int) $reintentar);
    }

    /** Hace `$n` peticiones GET /api/auth/me con la sesión actual y exige que todas respondan `$estado`. */
    private function pedirMe(int $n, int $estado = 200): void
    {
        for ($i = 1; $i <= $n; $i++) {
            $this->getJson('/api/auth/me')->assertStatus($estado);
        }
    }

    public function test_el_intento_11_de_login_del_minuto_desde_la_misma_ip_es_429_con_retry_after(): void
    {  // [RF-3]
        for ($i = 0; $i < 10; $i++) {
            $this->login()->assertStatus(401);
        }

        $this->assertDemasiadasPeticiones($this->login());
    }

    public function test_otra_ip_no_se_ve_afectada(): void
    {
        $this->desdeLaIp(self::IP_A);
        for ($i = 0; $i < 10; $i++) {
            $this->login()->assertStatus(401);
        }
        $this->assertDemasiadasPeticiones($this->login());

        $this->desdeLaIp(self::IP_B);
        $this->login()->assertStatus(401)->assertJsonPath('error.codigo', 'CREDENCIALES_INVALIDAS');

        // La IP agotada sigue bloqueada: la otra no le ha dado un contador nuevo.
        $this->desdeLaIp(self::IP_A);
        $this->assertDemasiadasPeticiones($this->login());
    }

    public function test_la_peticion_101_de_un_usuario_autenticado_es_429_y_otro_usuario_no_se_afecta(): void
    {
        $primero = $this->usuario(Roles::ADM);
        $segundo = $this->usuario(Roles::VEN);

        $this->conSesion($primero);
        $this->pedirMe(100);
        $this->assertDemasiadasPeticiones($this->getJson('/api/auth/me'));

        // El segundo usuario tiene su propio contador, aunque llegue desde la misma IP.
        $this->conSesion($segundo);
        $this->getJson('/api/auth/me')->assertOk()->assertJsonPath('id_usuario', $segundo->id_usuario);
    }

    public function test_el_almacen_de_produccion_es_database_para_compartir_el_contador_entre_copias(): void
    {
        $ejemplo = file_get_contents(base_path('.env.example'));

        $this->assertStringContainsString('CACHE_STORE=database', $ejemplo);
        // Una línea activa, no un comentario ni otro valor que solo contenga el texto.
        $this->assertMatchesRegularExpression('/^CACHE_STORE=database\s*$/m', $ejemplo);

        // El almacén `database` existe y su tabla la crea la migración del esqueleto.
        $this->assertSame('database', config('cache.stores.database.driver'));
        $this->assertTrue(Schema::hasTable(config('cache.stores.database.table')));
    }

    public function test_los_intentos_de_login_correctos_tambien_cuentan(): void
    {
        $usuario = $this->usuario(Roles::ADM, ['contrasena' => 'Contrasena123']);

        for ($i = 0; $i < 10; $i++) {
            $this->login($usuario->correo, 'Contrasena123')->assertOk();
        }

        // El undécimo, con la contraseña correcta, también se rechaza.
        $this->assertDemasiadasPeticiones($this->login($usuario->correo, 'Contrasena123'));
    }

    public function test_la_clave_del_login_es_la_ip_y_no_el_correo(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->login("persona{$i}@example.test")->assertStatus(401);
        }

        // Cambiar de correo en cada intento no da un contador nuevo.
        $this->assertDemasiadasPeticiones($this->login('otra@example.test'));
    }

    public function test_agotar_el_login_no_limita_las_peticiones_autenticadas_de_la_misma_ip(): void
    {
        $usuario = $this->usuario();

        for ($i = 0; $i < 10; $i++) {
            $this->login()->assertStatus(401);
        }
        $this->assertDemasiadasPeticiones($this->login());

        // El contador del login y el del usuario son distintos.
        $this->conSesion($usuario)->getJson('/api/auth/me')->assertOk();
    }

    public function test_el_limite_por_usuario_no_depende_de_la_ip(): void
    {
        $usuario = $this->usuario();
        $this->conSesion($usuario);

        $this->desdeLaIp(self::IP_A);
        $this->pedirMe(100);

        // Cambiar de IP con el mismo token no da un contador nuevo...
        $this->desdeLaIp(self::IP_B);
        $this->assertDemasiadasPeticiones($this->getJson('/api/auth/me'));

        // ...y otro usuario desde la IP ya agotada sí puede pedir.
        $this->desdeLaIp(self::IP_A);
        $this->conSesion($this->usuario(Roles::CON))->getJson('/api/auth/me')->assertOk();
    }

    public function test_un_usuario_con_cambio_de_contrasena_pendiente_tambien_cuenta_en_rutas_prohibidas(): void
    {
        $usuario = $this->usuario(Roles::ADM, ['debe_cambiar_contrasena' => true]);
        $this->conSesion($usuario);

        // `throttle:api` va antes que `cambio.contrasena`: los 403 también gastan el contador.
        for ($i = 0; $i < 100; $i++) {
            $this->getJson('/api/auth/me')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
        }

        $this->assertDemasiadasPeticiones($this->getJson('/api/auth/me'));
    }

    public function test_las_peticiones_con_token_invalido_no_gastan_el_contador_del_usuario(): void
    {
        $usuario = $this->usuario();

        // Un token firmado con otro secreto que dice ser el usuario: lo rechaza `jwt` antes del límite.
        $this->withToken($this->tokenFirmado(['sub' => (string) $usuario->id_usuario], 'otro-secreto-de-mas-de-32-caracteres'));
        $this->pedirMe(105, 401);

        $this->conSesion($usuario)->getJson('/api/auth/me')
            ->assertOk()
            ->assertHeader('X-RateLimit-Remaining', '99');
    }

    public function test_el_limite_por_usuario_se_lee_de_la_configuracion(): void
    {
        config(['gateway.rate_limit.por_usuario' => 3]);

        $this->conSesion($this->usuario());
        $this->getJson('/api/auth/me')->assertOk()->assertHeader('X-RateLimit-Limit', '3');
        $this->pedirMe(2);

        $this->assertDemasiadasPeticiones($this->getJson('/api/auth/me'));
    }

    public function test_el_limite_de_login_se_lee_de_la_configuracion(): void
    {
        config(['gateway.rate_limit.login_por_ip' => 2]);

        $this->login()->assertStatus(401);
        $this->login()->assertStatus(401);

        $this->assertDemasiadasPeticiones($this->login());
    }

    public function test_el_orden_real_de_ejecucion_es_jwt_limite_y_cambio_de_contrasena(): void
    {
        // El orden declarado en la ruta no basta: Laravel reordena según su lista de prioridad. Esta es la cadena
        // que se ejecuta de verdad, ya resuelta y ordenada. Instanciar el kernel HTTP vuelca alias, grupos y
        // prioridades en el enrutador (lo que hace al atender la primera petición).
        $this->app->make(HttpKernel::class);
        $router = app('router');
        $ejecutadas = fn (string $metodo, string $uri): array => $router->gatherRouteMiddleware(
            $router->getRoutes()->match(Request::create($uri, $metodo))
        );

        $autenticada = $ejecutadas('GET', '/api/auth/me');
        $this->assertSame(
            [AuthenticateJwt::class, ThrottleRequests::class.':api', EnforcePasswordChange::class],
            array_values(array_intersect($autenticada, [AuthenticateJwt::class, ThrottleRequests::class.':api', EnforcePasswordChange::class])),
        );

        // El login es público: solo `throttle:login`, sin `jwt` ni `throttle:api`.
        $login = $ejecutadas('POST', '/api/auth/login');
        $this->assertContains(ThrottleRequests::class.':login', $login);
        $this->assertNotContains(ThrottleRequests::class.':api', $login);
        $this->assertNotContains(AuthenticateJwt::class, $login);
    }

    public function test_throttle_api_sin_usuario_autenticado_responde_401_y_no_cuenta_por_ip(): void
    {
        // Una ruta mal armada (limite sin `jwt`) falla de forma visible en vez de limitar por IP en silencio.
        Route::middleware(['api', 'throttle:api'])->get('/_prueba/sin-jwt', fn () => response()->json(['ok' => true]));

        $this->getJson('/_prueba/sin-jwt')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
    }
}
