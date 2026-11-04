<?php

namespace Tests\Feature;

use App\Exceptions\ApiException;
use App\Http\Middleware\AssignRequestId;
use App\Http\Middleware\AuthenticateJwt;
use App\Http\Middleware\EnforcePasswordChange;
use App\Http\Middleware\LogRequest;
use App\Http\Middleware\RequireRole;
use App\Models\Rol;
use App\Models\Usuario;
use App\Support\Roles;
use Closure;
use Firebase\JWT\JWT;
use Illuminate\Contracts\Http\Kernel as HttpKernel;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use InvalidArgumentException;
use Monolog\Formatter\JsonFormatter;
use Monolog\Handler\NullHandler;
use Monolog\Handler\StreamHandler;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\HttpFoundation\Response;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

class MiddlewareTest extends TestCase
{
    use ApiHelpers;

    private const UUID_V4 = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';

    /** Siempre el mismo cuerpo: la respuesta no delata por qué se rechazó la credencial. */
    private const NO_AUTENTICADO = ['error' => ['codigo' => 'NO_AUTENTICADO', 'mensaje' => 'No autenticado.', 'detalles' => []]];

    private const SIN_PERMISO = ['error' => ['codigo' => 'SIN_PERMISO', 'mensaje' => 'No tiene permiso para realizar esta acción.', 'detalles' => []]];

    protected function setUp(): void
    {
        parent::setUp();

        // Ruta pública con el grupo `api` y nada más (como será el inicio de sesión).
        Route::middleware('api')->get('/api/_publica', fn () => response()->json(['ok' => true]));

        Route::middleware(['api', 'jwt', 'cambio.contrasena'])->group(function (): void {
            Route::get('/api/_probe', function (Request $request) {
                $usuario = $request->attributes->get('usuario');

                return response()->json([
                    'request_id' => $request->attributes->get('request_id'),
                    'cabecera_request_id' => $request->header('X-Request-Id'),
                    'id_usuario' => $usuario->id_usuario,
                    'id_usuario_de_la_peticion' => $request->user()?->getKey(),
                    'rol' => $usuario->rol->nombre,
                    'id_bodega' => $usuario->id_bodega,
                    'cabeceras_de_identidad' => [
                        'X-User-Id' => $request->header('X-User-Id'),
                        'X-User-Rol' => $request->header('X-User-Rol'),
                        'X-User-Bodega' => $request->header('X-User-Bodega'),
                    ],
                ]);
            });

            // Sustitutos de las rutas reales de AuthController (misma dirección y método, registrados después
            // y por tanto con prioridad): estas pruebas solo miden la cadena de middleware, no el controlador.
            Route::get('/api/auth/me', fn () => response()->json(['ok' => true]));
            Route::put('/api/auth/contrasena', fn () => response()->noContent());
            Route::post('/api/auth/logout', fn () => response()->noContent());
        });

        Route::middleware(['api', 'jwt', 'cambio.contrasena', 'rol:ADMINISTRADOR'])
            ->get('/api/_solo-admin', fn () => response()->json(['ok' => true]));

        Route::middleware(['api', 'jwt', 'rol:ADMINISTRADOR,CONTADOR'])
            ->get('/api/_admin-o-contador', fn () => response()->json(['ok' => true]));
    }

    // ---------------------------------------------------------------------------------------------------------
    // AssignRequestId
    // ---------------------------------------------------------------------------------------------------------

    public function test_siempre_genera_un_request_id_y_descarta_el_del_cliente(): void    // [RF-1]
    {
        $r = $this->withHeader('X-Request-Id', 'evil')->getJson('/api/_probe');

        $this->assertNotSame('evil', $r->headers->get('X-Request-Id'));
        $this->assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $r->headers->get('X-Request-Id'));
        $this->assertMatchesRegularExpression(self::UUID_V4, $r->headers->get('X-Request-Id'));
    }

    public function test_un_uuid_valido_del_cliente_tambien_se_descarta_y_cada_peticion_tiene_el_suyo(): void
    {
        $delCliente = '123e4567-e89b-42d3-a456-426614174000';

        $primera = $this->withHeader('X-Request-Id', $delCliente)->getJson('/api/_publica');
        $segunda = $this->withHeader('X-Request-Id', $delCliente)->getJson('/api/_publica');

        $this->assertNotSame($delCliente, $primera->headers->get('X-Request-Id'));
        $this->assertNotSame($delCliente, $segunda->headers->get('X-Request-Id'));
        $this->assertNotSame($primera->headers->get('X-Request-Id'), $segunda->headers->get('X-Request-Id'));
    }

    public function test_el_request_id_generado_es_el_de_la_respuesta_el_del_atributo_y_el_de_la_cabecera_de_la_peticion(): void
    {
        $r = $this->conSesion($this->usuario())->withHeader('X-Request-Id', 'evil')->getJson('/api/_probe')->assertOk();

        $id = $r->headers->get('X-Request-Id');
        $this->assertMatchesRegularExpression(self::UUID_V4, $id);
        // Quien lea la cabecera de la petición (p. ej. el proxy de la Tarea 9) ve el valor del Gateway, nunca 'evil'.
        $this->assertSame($id, $r->json('request_id'));
        $this->assertSame($id, $r->json('cabecera_request_id'));
    }

    public function test_las_respuestas_de_error_y_las_rutas_publicas_tambien_llevan_request_id(): void
    {
        $publica = $this->getJson('/api/_publica')->assertOk();
        $sinToken = $this->getJson('/api/_probe')->assertStatus(401);
        $sinPermiso = $this->conSesion($this->usuario(Roles::VEN))->getJson('/api/_solo-admin')->assertStatus(403);

        foreach ([$publica, $sinToken, $sinPermiso] as $respuesta) {
            $this->assertMatchesRegularExpression(self::UUID_V4, $respuesta->headers->get('X-Request-Id'));
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // LogRequest y canal de registro
    // ---------------------------------------------------------------------------------------------------------

    public function test_registra_una_linea_json_por_peticion(): void
    {
        Log::spy();
        $this->conSesion($this->usuario())->getJson('/api/_probe');

        Log::shouldHaveReceived('info')->withArgs(fn ($m, $c) => $m === 'peticion' && $c['servicio'] === 'api-gateway'
            && isset($c['request_id']) && $c['estado'] === 200 && $c['metodo'] === 'GET');
    }

    public function test_el_registro_tiene_exactamente_las_claves_del_contrato_y_ningun_dato_sensible(): void
    {
        Log::spy();
        $usuario = $this->usuario();
        $respuesta = $this->conSesion($usuario)->getJson('/api/_probe?clave=secreto-en-la-url');
        $token = substr($this->defaultHeaders['Authorization'], strlen('Bearer '));

        $contexto = $this->contextoDelRegistro();

        $this->assertEqualsCanonicalizing(
            ['servicio', 'request_id', 'metodo', 'ruta', 'estado', 'id_usuario', 'duracion_ms'],
            array_keys($contexto),
        );
        $this->assertSame('api-gateway', $contexto['servicio']);
        $this->assertSame($respuesta->headers->get('X-Request-Id'), $contexto['request_id']);
        $this->assertSame('GET', $contexto['metodo']);
        $this->assertSame('/api/_probe', $contexto['ruta'], 'La ruta no incluye la cadena de consulta.');
        $this->assertSame(200, $contexto['estado']);
        $this->assertSame($usuario->id_usuario, $contexto['id_usuario']);
        $this->assertIsNumeric($contexto['duracion_ms']);
        $this->assertGreaterThanOrEqual(0, $contexto['duracion_ms']);

        $linea = json_encode($contexto, JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString($token, $linea);
        $this->assertStringNotContainsString('secreto-en-la-url', $linea);
    }

    public function test_una_peticion_rechazada_se_registra_con_su_estado_y_sin_usuario_si_no_hubo_sesion(): void
    {
        Log::spy();
        $sinToken = $this->getJson('/api/_probe');
        $contexto = $this->contextoDelRegistro();

        $this->assertSame(401, $contexto['estado']);
        $this->assertNull($contexto['id_usuario']);
        $this->assertArrayHasKey('id_usuario', $contexto, 'La clave existe aunque no haya usuario.');
        $this->assertSame($sinToken->headers->get('X-Request-Id'), $contexto['request_id']);
    }

    public function test_una_peticion_prohibida_se_registra_con_el_usuario_y_el_estado_403(): void
    {
        Log::spy();
        $usuario = $this->usuario(Roles::VEN);
        $respuesta = $this->conSesion($usuario)->getJson('/api/_solo-admin');
        $contexto = $this->contextoDelRegistro();

        $this->assertSame(403, $contexto['estado']);
        $this->assertSame($usuario->id_usuario, $contexto['id_usuario']);
        $this->assertSame($respuesta->headers->get('X-Request-Id'), $contexto['request_id']);
    }

    public function test_el_canal_por_defecto_formatea_en_json(): void
    {
        $this->assertSame(JsonFormatter::class, config('logging.channels.json_stderr.formatter'));

        // El canal construido de verdad: un StreamHandler a stderr con el formateador JSON (sin escribir nada).
        $manejador = Log::channel('json_stderr')->getLogger()->getHandlers()[0];
        $this->assertInstanceOf(StreamHandler::class, $manejador);
        $this->assertSame('php://stderr', $manejador->getUrl());
        $this->assertInstanceOf(JsonFormatter::class, $manejador->getFormatter());
    }

    public function test_sin_variable_de_entorno_el_canal_por_defecto_es_json_stderr(): void
    {
        // phpunit.xml fija LOG_CHANNEL=null para que las pruebas no escriban en stderr; aquí se evalúa
        // config/logging.php como si la variable no existiera.
        $variables = ['LOG_CHANNEL' => getenv('LOG_CHANNEL'), 'env' => $_ENV['LOG_CHANNEL'] ?? null, 'server' => $_SERVER['LOG_CHANNEL'] ?? null];
        putenv('LOG_CHANNEL');
        unset($_ENV['LOG_CHANNEL'], $_SERVER['LOG_CHANNEL']);

        try {
            $configuracion = require config_path('logging.php');
        } finally {
            if ($variables['LOG_CHANNEL'] !== false) {
                putenv('LOG_CHANNEL='.$variables['LOG_CHANNEL']);
            }
            if ($variables['env'] !== null) {
                $_ENV['LOG_CHANNEL'] = $variables['env'];
            }
            if ($variables['server'] !== null) {
                $_SERVER['LOG_CHANNEL'] = $variables['server'];
            }
        }

        $this->assertSame('json_stderr', $configuracion['default']);

        // Y las pruebas no escriben en stderr: env() convierte «null» en null y, bajo PHPUnit, Laravel resuelve
        // el canal por defecto nulo al canal `null`.
        $this->assertInstanceOf(NullHandler::class, Log::driver()->getLogger()->getHandlers()[0]);
    }

    // ---------------------------------------------------------------------------------------------------------
    // AuthenticateJwt
    // ---------------------------------------------------------------------------------------------------------

    /** @return array<string, array{?string}> */
    public static function cabecerasDeAutorizacionInvalidas(): array
    {
        return [
            'sin cabecera' => [null],
            'cabecera vacía' => [''],
            'Bearer sin token' => ['Bearer'],
            'Bearer con espacio y sin token' => ['Bearer '],
            'basura' => ['Bearer garbage'],
            'esquema Basic' => ['Basic dXNlcjpwYXNz'],
            'token sin esquema' => ['eyJhbGciOiJIUzI1NiJ9.e30.firma'],
            'dos tokens' => ['Bearer aaa bbb'],
        ];
    }

    #[DataProvider('cabecerasDeAutorizacionInvalidas')]
    public function test_sin_token_o_con_basura_es_401_no_autenticado(?string $autorizacion): void
    {
        $peticion = $autorizacion === null ? $this : $this->withHeader('Authorization', $autorizacion);

        $peticion->getJson('/api/_probe')
            ->assertStatus(401)
            ->assertExactJson(self::NO_AUTENTICADO);
    }

    public function test_un_token_vencido_manipulado_o_mal_firmado_es_401_con_la_misma_respuesta(): void      // [RF-2]
    {
        $usuario = $this->usuario(Roles::VEN);
        $secreto = (string) config('gateway.jwt.secret');
        $claims = ['sub' => (string) $usuario->id_usuario, 'rol' => Roles::ADM];

        // Manipulado: payload con rol de administrador y la firma del token original.
        [$cabecera, $carga, $firma] = explode('.', $this->tokenDe($usuario));
        $cargaFalsa = JWT::urlsafeB64Encode((string) json_encode([...(array) json_decode(JWT::urlsafeB64Decode($carga)), 'rol' => Roles::ADM]));

        $casos = [
            'manipulado' => "{$cabecera}.{$cargaFalsa}.{$firma}",
            'firmado con otro secreto' => $this->tokenFirmado($claims, 'otro-secreto-distinto-de-mas-de-32-caracteres'),
            'algoritmo none' => JWT::urlsafeB64Encode((string) json_encode(['alg' => 'none', 'typ' => 'JWT']))
                .'.'.JWT::urlsafeB64Encode((string) json_encode([...$claims, 'iat' => time(), 'exp' => time() + 3600, 'id_bodega' => null])).'.',
            // Firmado a mano: firebase/php-jwt no firma HS512 con una llave de menos de 64 bytes.
            'otro algoritmo (HS512)' => $this->tokenHmac('HS512', 'sha512', $claims, $secreto),
            'otro algoritmo (HS384)' => $this->tokenHmac('HS384', 'sha384', $claims, $secreto),
        ];

        foreach ($casos as $caso => $token) {
            $respuesta = $this->withToken($token)->getJson('/api/_probe');

            $this->assertSame(401, $respuesta->getStatusCode(), "Caso: {$caso}");
            $this->assertSame(self::NO_AUTENTICADO, $respuesta->json(), "Caso: {$caso}");
        }

        // Vencido: el mismo token que hoy sirve deja de servir 61 minutos después.
        $vigente = $this->tokenDe($usuario);
        $this->withToken($vigente)->getJson('/api/_probe')->assertOk();
        Carbon::setTestNow(Carbon::now()->addMinutes(61));
        $this->withToken($vigente)->getJson('/api/_probe')->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);
    }

    /** @return array<string, array{Closure(int): string}> */
    public static function subsQueNoSonEnterosPositivos(): array
    {
        return [
            'cero' => [fn (): string => '0'],
            'negativo' => [fn (): string => '-1'],
            'letras' => [fn (): string => 'abc'],
            'vacío' => [fn (): string => ''],
            'decimal' => [fn (int $id): string => "{$id}.0"],
            'notación científica' => [fn (int $id): string => "{$id}e0"],
            'espacio al inicio' => [fn (int $id): string => " {$id}"],
            'espacio al final' => [fn (int $id): string => "{$id} "],
            'ceros a la izquierda' => [fn (int $id): string => "00{$id}"],
            'signo más' => [fn (int $id): string => "+{$id}"],
            'hexadecimal' => [fn (int $id): string => '0x'.dechex($id)],
            'desbordamiento' => [fn (): string => '99999999999999999999'],
            'inyección SQL' => [fn (int $id): string => "{$id} OR 1=1"],
        ];
    }

    /** @param  Closure(int): string  $sub */
    #[DataProvider('subsQueNoSonEnterosPositivos')]
    public function test_un_sub_que_no_es_un_entero_positivo_es_401(Closure $sub): void
    {
        $usuario = $this->usuario();
        $token = $this->tokenFirmado(['sub' => $sub($usuario->id_usuario), 'rol' => Roles::ADM]);

        // Control: con el sub canónico el mismo token sí entra.
        $this->withToken($this->tokenFirmado(['sub' => (string) $usuario->id_usuario, 'rol' => Roles::ADM]))
            ->getJson('/api/_probe')->assertOk();

        $this->withToken($token)->getJson('/api/_probe')
            ->assertStatus(401)
            ->assertExactJson(self::NO_AUTENTICADO);
    }

    public function test_token_valido_pasa_y_expone_el_usuario(): void
    {
        $usuario = $this->usuario(Roles::OPE, ['id_bodega' => 3]);

        $this->conSesion($usuario)->getJson('/api/_probe')
            ->assertOk()
            ->assertJsonPath('id_usuario', $usuario->id_usuario)
            ->assertJsonPath('id_usuario_de_la_peticion', $usuario->id_usuario)
            ->assertJsonPath('rol', Roles::OPE)
            ->assertJsonPath('id_bodega', 3);
    }

    public function test_token_de_usuario_inactivado_es_401_aunque_no_haya_vencido(): void     // [RF-2]
    {
        $usuario = $this->usuario();
        $this->conSesion($usuario)->getJson('/api/_probe')->assertOk();

        Usuario::query()->whereKey($usuario->id_usuario)->update(['activo' => false]);

        // El mismo token, sin vencer, ya no sirve.
        $this->getJson('/api/_probe')->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);

        // Y vuelve a servir al reactivar al usuario: la decisión sale de la base en cada petición.
        Usuario::query()->whereKey($usuario->id_usuario)->update(['activo' => true]);
        $this->getJson('/api/_probe')->assertOk();
    }

    public function test_token_de_usuario_inexistente_es_401(): void
    {
        $usuario = $this->usuario();
        $this->conSesion($usuario)->getJson('/api/_probe')->assertOk();

        $usuario->delete();

        $this->getJson('/api/_probe')->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);

        // Token bien firmado de un id que nunca existió.
        $this->withToken($this->tokenFirmado(['sub' => '987654', 'rol' => Roles::ADM]))
            ->getJson('/api/_probe')->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);
    }

    public function test_un_usuario_sin_rol_en_la_base_es_401(): void
    {
        $usuario = $this->usuario();
        $this->conSesion($usuario)->getJson('/api/_probe')->assertOk();

        // Estado imposible con la clave foránea activa; se aplaza su comprobación hasta un commit que no llega
        // (la prueba termina con rollback) para poder fabricarlo.
        DB::statement('PRAGMA defer_foreign_keys = ON');
        Usuario::query()->whereKey($usuario->id_usuario)->update(['id_rol' => 999999]);

        $this->getJson('/api/_probe')->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);
    }

    public function test_un_cambio_de_rol_en_la_base_aplica_en_la_siguiente_peticion(): void     // [RF-2]
    {
        $usuario = $this->usuario(Roles::ADM);
        $this->conSesion($usuario);   // un solo token para toda la prueba

        $this->getJson('/api/_solo-admin')->assertOk();

        $this->cambiarRol($usuario, Roles::VEN);
        $this->getJson('/api/_solo-admin')->assertStatus(403)->assertExactJson(self::SIN_PERMISO);

        $this->cambiarRol($usuario, Roles::ADM);
        $this->getJson('/api/_solo-admin')->assertOk();
    }

    public function test_el_rol_y_la_bodega_salen_de_la_base_no_de_las_claims_del_token(): void
    {
        $vendedor = $this->usuario(Roles::VEN);
        $operador = $this->usuario(Roles::OPE, ['id_bodega' => 3]);

        // Token con firma válida pero claims que mienten: rol de administrador y otra bodega.
        $this->withToken($this->tokenFirmado(['sub' => (string) $vendedor->id_usuario, 'rol' => Roles::ADM, 'id_bodega' => 99]))
            ->getJson('/api/_solo-admin')
            ->assertStatus(403)
            ->assertExactJson(self::SIN_PERMISO);

        $this->withToken($this->tokenFirmado(['sub' => (string) $vendedor->id_usuario, 'rol' => Roles::ADM, 'id_bodega' => 99]))
            ->getJson('/api/_probe')
            ->assertOk()
            ->assertJsonPath('rol', Roles::VEN)
            ->assertJsonPath('id_bodega', null);

        $this->withToken($this->tokenFirmado(['sub' => (string) $operador->id_usuario, 'rol' => Roles::OPE, 'id_bodega' => 99]))
            ->getJson('/api/_probe')
            ->assertOk()
            ->assertJsonPath('id_bodega', 3);

        // Un token que dice «operador» de alguien que ya es administrador en la base se trata como administrador.
        $this->cambiarRol($operador, Roles::ADM);
        $this->withToken($this->tokenFirmado(['sub' => (string) $operador->id_usuario, 'rol' => Roles::OPE]))
            ->getJson('/api/_probe')
            ->assertJsonPath('rol', Roles::ADM);
    }

    public function test_las_cabeceras_de_identidad_del_cliente_se_descartan(): void     // [RF-1]
    {
        $vendedor = $this->usuario(Roles::VEN);
        $suplantacion = ['X-User-Id' => '999999', 'X-User-Rol' => Roles::ADM, 'X-User-Bodega' => '77'];

        $r = $this->conSesion($vendedor)->withHeaders($suplantacion)->getJson('/api/_probe')
            ->assertOk()
            ->assertJsonPath('id_usuario', $vendedor->id_usuario)
            ->assertJsonPath('rol', Roles::VEN);

        // Nada de lo que mandó el cliente queda en la petición que ven los controladores y el proxy.
        $this->assertSame(
            ['X-User-Id' => null, 'X-User-Rol' => null, 'X-User-Bodega' => null],
            $r->json('cabeceras_de_identidad'),
        );

        // El cliente que dice ser administrador sigue siendo vendedor para la autorización.
        $this->conSesion($vendedor)->withHeaders($suplantacion)->getJson('/api/_solo-admin')
            ->assertStatus(403)
            ->assertExactJson(self::SIN_PERMISO);
    }

    // ---------------------------------------------------------------------------------------------------------
    // EnforcePasswordChange
    // ---------------------------------------------------------------------------------------------------------

    public function test_cambio_de_contrasena_pendiente_bloquea_todo_salvo_lo_permitido(): void      // [RF-3]
    {
        $usuario = $this->usuario(Roles::ADM, ['debe_cambiar_contrasena' => true]);
        $this->conSesion($usuario);

        $bloqueada = ['error' => [
            'codigo' => 'CAMBIO_CONTRASENA_REQUERIDO',
            'mensaje' => 'Debe cambiar su contraseña antes de continuar.',
            'detalles' => [],
        ]];

        $this->getJson('/api/_probe')->assertStatus(403)->assertExactJson($bloqueada);
        $this->getJson('/api/auth/me')->assertStatus(403)->assertExactJson($bloqueada);
        // También gana a la comprobación de rol: ni siquiera el administrador sembrado llega a otras rutas.
        $this->getJson('/api/_solo-admin')->assertStatus(403)->assertExactJson($bloqueada);

        $this->putJson('/api/auth/contrasena')->assertNoContent();
        $this->postJson('/api/auth/logout')->assertNoContent();

        // Al limpiar la bandera, el mismo token pasa.
        Usuario::query()->whereKey($usuario->id_usuario)->update(['debe_cambiar_contrasena' => false]);
        $this->getJson('/api/_probe')->assertOk();
        $this->getJson('/api/_solo-admin')->assertOk();
    }

    /** @return array<string, array{string, string, bool}> */
    public static function rutasConCambioDeContrasenaPendiente(): array
    {
        return [
            'PUT api/auth/contrasena' => ['PUT', '/api/auth/contrasena', true],
            'POST api/auth/logout' => ['POST', '/api/auth/logout', true],
            'la cadena de consulta no cuenta' => ['PUT', '/api/auth/contrasena?x=1', true],
            'la barra final no cuenta (el enrutador la recorta)' => ['PUT', '/api/auth/contrasena/', true],
            'varias barras finales' => ['POST', '/api/auth/logout//', true],
            'barra de más al inicio' => ['PUT', '//api/auth/contrasena', false],
            'varias barras de más al inicio' => ['POST', '///api/auth/logout', false],
            'barra de más en medio' => ['PUT', '/api//auth/contrasena', false],
            'GET api/auth/me' => ['GET', '/api/auth/me', false],
            'POST api/auth/contrasena' => ['POST', '/api/auth/contrasena', false],
            'GET api/auth/contrasena' => ['GET', '/api/auth/contrasena', false],
            'PATCH api/auth/contrasena' => ['PATCH', '/api/auth/contrasena', false],
            'PUT api/auth/logout' => ['PUT', '/api/auth/logout', false],
            'DELETE api/auth/logout' => ['DELETE', '/api/auth/logout', false],
            'subruta de la contraseña' => ['PUT', '/api/auth/contrasena/otra', false],
            'subruta del cierre de sesión' => ['POST', '/api/auth/logout/todas', false],
            'otro prefijo' => ['PUT', '/api/usuarios/contrasena', false],
            'sin el prefijo api' => ['PUT', '/auth/contrasena', false],
            'otras mayúsculas' => ['PUT', '/API/AUTH/CONTRASENA', false],
            'ruta cualquiera' => ['GET', '/api/_probe', false],
            'el inicio de sesión no es del autenticado' => ['POST', '/api/auth/login', false],
            'ruta con segmento ..' => ['PUT', '/api/auth/contrasena/../../usuarios', false],
            'separador codificado' => ['PUT', '/api/auth%2Fcontrasena', false],
        ];
    }

    #[DataProvider('rutasConCambioDeContrasenaPendiente')]
    public function test_con_cambio_pendiente_solo_pasan_put_contrasena_y_post_logout(string $metodo, string $uri, bool $pasa): void
    {
        $this->assertSame($pasa, $this->pasaPorCambioDeContrasena($this->peticionCruda($metodo, $uri), pendiente: true));
    }

    /** @return array<string, array{string, string}> */
    public static function todasLasRutas(): array
    {
        return array_map(fn (array $caso): array => array_slice($caso, 0, 2), self::rutasConCambioDeContrasenaPendiente());
    }

    #[DataProvider('todasLasRutas')]
    public function test_sin_cambio_pendiente_pasa_cualquier_ruta(string $metodo, string $uri): void
    {
        $this->assertTrue($this->pasaPorCambioDeContrasena($this->peticionCruda($metodo, $uri), pendiente: false));
    }

    public function test_el_cambio_de_contrasena_sin_usuario_autenticado_es_401(): void
    {
        $this->expectException(ApiException::class);
        $this->expectExceptionMessage('No autenticado.');

        (new EnforcePasswordChange)->handle(Request::create('/api/auth/contrasena', 'PUT'), fn () => response()->noContent());
    }

    // ---------------------------------------------------------------------------------------------------------
    // RequireRole
    // ---------------------------------------------------------------------------------------------------------

    public function test_solo_pasan_los_roles_indicados(): void
    {
        foreach ([Roles::ADM => 200, Roles::CON => 200, Roles::VEN => 403, Roles::OPE => 403] as $rol => $estado) {
            $respuesta = $this->conSesion($this->usuario($rol))->getJson('/api/_admin-o-contador')->assertStatus($estado);

            if ($estado === 403) {
                $respuesta->assertExactJson(self::SIN_PERMISO);
            }
        }
    }

    public function test_sin_sesion_la_ruta_con_rol_es_401_antes_que_403(): void
    {
        $this->getJson('/api/_admin-o-contador')->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);
    }

    public function test_el_rol_sin_usuario_autenticado_es_401(): void
    {
        $this->expectException(ApiException::class);
        $this->expectExceptionMessage('No autenticado.');

        (new RequireRole)->handle(Request::create('/api/_solo-admin'), fn () => response()->noContent(), Roles::ADM);
    }

    public function test_el_rol_se_lee_del_modelo_del_usuario(): void
    {
        $this->assertSame(204, $this->conRol(Roles::CON, Roles::ADM, Roles::CON)->getStatusCode());

        try {
            $this->conRol(Roles::VEN, Roles::ADM, Roles::CON);
            $this->fail('Un vendedor no debe pasar.');
        } catch (ApiException $e) {
            $this->assertSame(403, $e->status);
            $this->assertSame('SIN_PERMISO', $e->codigo);
        }
    }

    /** @return array<string, array{list<string>}> */
    public static function indicacionesDeRolInvalidas(): array
    {
        return [
            'ningún rol' => [[]],
            'rol vacío (como `rol:`)' => [['']],
            'rol desconocido' => [['ADMIN']],
            'un rol bueno y otro con error tipográfico' => [[Roles::ADM, 'CONTADRO']],
            'minúsculas' => [['administrador']],
        ];
    }

    /** @param  list<string>  $roles */
    #[DataProvider('indicacionesDeRolInvalidas')]
    public function test_una_ruta_mal_configurada_falla_de_forma_visible_y_no_deja_pasar(array $roles): void
    {
        $peticion = Request::create('/api/_solo-admin');
        $peticion->attributes->set('usuario', $this->usuario(Roles::ADM));

        $this->expectException(InvalidArgumentException::class);

        (new RequireRole)->handle($peticion, fn () => response()->noContent(), ...$roles);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Registro de los middleware
    // ---------------------------------------------------------------------------------------------------------

    public function test_los_alias_y_el_grupo_api_estan_registrados_en_el_orden_del_contrato(): void
    {
        // El núcleo HTTP es quien vuelca alias y grupos en el enrutador, y se resuelve en la primera petición.
        app(HttpKernel::class);
        $router = app('router');

        $this->assertSame(AuthenticateJwt::class, $router->getMiddleware()['jwt'] ?? null);
        $this->assertSame(EnforcePasswordChange::class, $router->getMiddleware()['cambio.contrasena'] ?? null);
        $this->assertSame(RequireRole::class, $router->getMiddleware()['rol'] ?? null);
        $this->assertSame(
            [AssignRequestId::class, LogRequest::class],
            array_slice($router->getMiddlewareGroups()['api'], 0, 2),
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // Utilidades
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Contexto del único `Log::info('peticion', ...)` recibido por el Log espía.
     *
     * @return array<string, mixed>
     */
    private function contextoDelRegistro(): array
    {
        $contexto = null;

        Log::shouldHaveReceived('info')
            ->withArgs(function (string $mensaje, array $recibido) use (&$contexto): bool {
                if ($mensaje !== 'peticion') {
                    return false;
                }
                $contexto = $recibido;

                return true;
            })
            ->once();

        $this->assertIsArray($contexto);

        return $contexto;
    }

    /**
     * Token con una firma HMAC correcta (con el secreto del Gateway) pero con un algoritmo distinto de HS256.
     *
     * @param  array<string, mixed>  $claims
     */
    private function tokenHmac(string $algoritmo, string $hash, array $claims, string $secreto): string
    {
        $cabecera = JWT::urlsafeB64Encode((string) json_encode(['alg' => $algoritmo, 'typ' => 'JWT']));
        $carga = JWT::urlsafeB64Encode((string) json_encode([...$claims, 'iat' => time(), 'exp' => time() + 3600, 'id_bodega' => null]));

        return "{$cabecera}.{$carga}.".JWT::urlsafeB64Encode(hash_hmac($hash, "{$cabecera}.{$carga}", $secreto, true));
    }

    private function cambiarRol(Usuario $usuario, string $rol): void
    {
        Usuario::query()->whereKey($usuario->id_usuario)->update([
            'id_rol' => Rol::query()->where('nombre', $rol)->value('id_rol'),
        ]);
    }

    /**
     * Petición con la dirección tal cual llega al servidor. `Request::create('//api/...')` tomaría `api` por el
     * nombre del servidor, así que no sirve para probar barras repetidas al inicio.
     */
    private function peticionCruda(string $metodo, string $uri): Request
    {
        return new Request(server: ['REQUEST_URI' => $uri, 'REQUEST_METHOD' => $metodo]);
    }

    /**
     * Invoca el middleware directamente. Devuelve si la petición pasó; si no, comprueba que fue el 403 esperado.
     */
    private function pasaPorCambioDeContrasena(Request $peticion, bool $pendiente): bool
    {
        $peticion->attributes->set('usuario', (new Usuario)->forceFill(['debe_cambiar_contrasena' => $pendiente]));

        try {
            (new EnforcePasswordChange)->handle($peticion, fn () => response()->noContent());

            return true;
        } catch (ApiException $e) {
            $this->assertSame(403, $e->status);
            $this->assertSame('CAMBIO_CONTRASENA_REQUERIDO', $e->codigo);

            return false;
        }
    }

    /** Pasa por RequireRole a un usuario en memoria con el rol dado. */
    private function conRol(string $rol, string ...$permitidos): Response
    {
        $usuario = (new Usuario)->setRelation('rol', new Rol(['nombre' => $rol]));
        $peticion = Request::create('/api/_solo-admin');
        $peticion->attributes->set('usuario', $usuario);

        return (new RequireRole)->handle($peticion, fn () => response()->noContent(), ...$permitidos);
    }
}
