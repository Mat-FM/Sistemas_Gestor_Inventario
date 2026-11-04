<?php

namespace Tests\Feature;

use App\Http\Controllers\AuthController;
use App\Models\Usuario;
use App\Rules\ContrasenaValida;
use App\Services\Jwt\JwtService;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Contracts\Hashing\Hasher;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use ApiHelpers;

    private const FECHA_ISO_8601 = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/';

    /** Cuerpo único de todo rechazo de credenciales: no delata si el correo existe ni si la cuenta está activa. */
    private const CREDENCIALES_INVALIDAS = [
        'error' => [
            'codigo' => 'CREDENCIALES_INVALIDAS',
            'mensaje' => 'Correo o contraseña incorrectos.',
            'detalles' => [],
        ],
    ];

    /** @param  list<string>  $campos */
    private function assertDatosNoValidos(TestResponse $respuesta, array $campos): void
    {
        $respuesta->assertStatus(422)->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS');

        $detalles = $respuesta->json('error.detalles');
        $this->assertEqualsCanonicalizing($campos, array_values(array_unique(array_column($detalles, 'campo'))));
        foreach ($detalles as $detalle) {
            $this->assertSame(['campo', 'mensaje'], array_keys($detalle));
            $this->assertNotSame('', trim($detalle['mensaje']));
        }
    }

    /**
     * Registra cada Hash::check (valor, hash) y cuenta cada Hash::make, y delega en el hasher real.
     */
    private function espiarHash(): object
    {
        $espia = new class(Hash::getFacadeRoot()) implements Hasher
        {
            /** @var list<array{string, string}> */
            public array $comprobaciones = [];

            public int $fabricaciones = 0;

            public function __construct(private readonly Hasher $real) {}

            public function info($hashedValue)
            {
                return $this->real->info($hashedValue);
            }

            public function make(#[\SensitiveParameter] $value, array $options = [])
            {
                $this->fabricaciones++;

                return $this->real->make($value, $options);
            }

            public function check(#[\SensitiveParameter] $value, $hashedValue, array $options = [])
            {
                $this->comprobaciones[] = [$value, $hashedValue];

                return $this->real->check($value, $hashedValue, $options);
            }

            public function needsRehash($hashedValue, array $options = [])
            {
                return $this->real->needsRehash($hashedValue, $options);
            }
        };

        Hash::swap($espia);

        return $espia;
    }

    // ---------------------------------------------------------------- POST /api/auth/login

    public function test_login_correcto(): void
    {
        $u = $this->usuario('OPERADOR_BODEGA', ['correo' => 'op@example.test', 'id_bodega' => 3, 'contrasena' => 'Clave1234']);

        $r = $this->postJson('/api/auth/login', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234'])->assertOk()
            ->assertJsonPath('expira_en', 3600)->assertJsonPath('usuario.rol', 'OPERADOR_BODEGA')
            ->assertJsonPath('usuario.id_bodega', 3)->assertJsonStructure(['token', 'usuario' => ['id_usuario', 'nombre', 'rol', 'id_bodega', 'debe_cambiar_contrasena']]);

        $this->assertSame(['token', 'expira_en', 'usuario'], array_keys($r->json()));
        $this->assertSame(
            ['id_usuario' => $u->id_usuario, 'nombre' => 'Usuario de prueba', 'rol' => 'OPERADOR_BODEGA', 'id_bodega' => 3, 'debe_cambiar_contrasena' => false],
            $r->json('usuario'),
        );
    }

    public function test_el_token_del_login_identifica_al_usuario_y_sirve_en_las_rutas_autenticadas(): void
    {
        $u = $this->usuario('CONTADOR', ['correo' => 'con@example.test', 'contrasena' => 'Clave1234']);

        $r = $this->postJson('/api/auth/login', ['correo' => 'con@example.test', 'contrasena' => 'Clave1234'])->assertOk();

        $reclamos = app(JwtService::class)->verificar($r->json('token'));
        $this->assertSame((string) $u->id_usuario, $reclamos->sub);
        $this->assertSame('CONTADOR', $reclamos->rol);
        $this->assertNull($reclamos->id_bodega);

        $this->withToken($r->json('token'))->getJson('/api/auth/me')->assertOk()->assertJsonPath('id_usuario', $u->id_usuario);
    }

    public function test_login_de_un_rol_sin_bodega_devuelve_id_bodega_nulo(): void
    {
        $this->usuario('VENDEDOR', ['correo' => 'ven@example.test', 'contrasena' => 'Clave1234']);

        $this->postJson('/api/auth/login', ['correo' => 'ven@example.test', 'contrasena' => 'Clave1234'])->assertOk()
            ->assertJsonPath('usuario.rol', 'VENDEDOR')->assertJsonPath('usuario.id_bodega', null);
    }

    public function test_login_nunca_expone_la_contrasena_ni_el_correo_ni_otros_datos_del_usuario(): void
    {
        $u = $this->usuario('ADMINISTRADOR', ['correo' => 'adm@example.test', 'contrasena' => 'Clave1234']);

        $r = $this->postJson('/api/auth/login', ['correo' => 'adm@example.test', 'contrasena' => 'Clave1234'])->assertOk();

        $this->assertStringNotContainsString($u->contrasena_cifrada, $r->getContent());
        $this->assertStringNotContainsString('Clave1234', $r->getContent());
        $this->assertStringNotContainsString('contrasena_cifrada', $r->getContent());
        $this->assertArrayNotHasKey('correo', $r->json('usuario'));
        $this->assertArrayNotHasKey('activo', $r->json('usuario'));
    }

    public function test_login_con_el_cambio_de_contrasena_pendiente_entra_y_avisa(): void
    {
        $this->usuario('ADMINISTRADOR', ['correo' => 'adm@example.test', 'contrasena' => 'Temporal123', 'debe_cambiar_contrasena' => true]);

        $this->postJson('/api/auth/login', ['correo' => 'adm@example.test', 'contrasena' => 'Temporal123'])->assertOk()
            ->assertJsonPath('usuario.debe_cambiar_contrasena', true);
    }

    public function test_login_es_publico_y_no_le_importa_un_bearer_invalido(): void
    {
        $this->usuario('VENDEDOR', ['correo' => 'ven@example.test', 'contrasena' => 'Clave1234']);

        $this->withToken('esto.no.es.un.jwt')
            ->postJson('/api/auth/login', ['correo' => 'ven@example.test', 'contrasena' => 'Clave1234'])->assertOk();
    }

    public function test_login_normaliza_el_correo_recortando_y_pasando_a_minusculas(): void  // Ruling 15
    {
        $u = $this->usuario('VENDEDOR', ['correo' => 'ana@x.com', 'contrasena' => 'Clave1234']);

        foreach (['Ana@X.com', 'ANA@X.COM', '  ana@x.com  ', " Ana@X.com\t"] as $correo) {
            $this->postJson('/api/auth/login', ['correo' => $correo, 'contrasena' => 'Clave1234'])->assertOk()
                ->assertJsonPath('usuario.id_usuario', $u->id_usuario);
        }
    }

    public function test_correo_inexistente_y_contrasena_erronea_dan_la_misma_respuesta(): void  // [RF-3]
    {
        $this->usuario('OPERADOR_BODEGA', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234']);   // el correo SÍ existe en el segundo caso
        $a = $this->postJson('/api/auth/login', ['correo' => 'nadie@example.test', 'contrasena' => 'Clave1234']);
        $b = $this->postJson('/api/auth/login', ['correo' => 'op@example.test', 'contrasena' => 'otra-cosa']);
        $this->assertSame(401, $a->status());
        $this->assertSame($a->getContent(), $b->getContent());   // codigo CREDENCIALES_INVALIDAS

        $this->assertSame(401, $b->status());
        $this->assertSame(self::CREDENCIALES_INVALIDAS, $a->json());
        $this->assertSame($a->headers->get('Content-Type'), $b->headers->get('Content-Type'));
        $this->assertArrayNotHasKey('token', $a->json());
        $this->assertArrayNotHasKey('token', $b->json());
    }

    public function test_el_rechazo_es_el_mismo_con_cualquier_causa_de_credenciales_invalidas(): void
    {
        $this->usuario('OPERADOR_BODEGA', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234']);
        $this->usuario('VENDEDOR', ['correo' => 'inactivo@example.test', 'contrasena' => 'Clave1234', 'activo' => false]);

        $casos = [
            'correo inexistente' => ['nadie@example.test', 'Clave1234'],
            'contraseña errónea' => ['op@example.test', 'otra-cosa'],
            'contraseña con otras mayúsculas' => ['op@example.test', 'clave1234'],
            'usuario inactivo con contraseña errónea' => ['inactivo@example.test', 'otra-cosa'],
        ];

        foreach ($casos as $nombre => [$correo, $contrasena]) {
            $r = $this->postJson('/api/auth/login', ['correo' => $correo, 'contrasena' => $contrasena]);
            $this->assertSame(401, $r->status(), $nombre);
            $this->assertSame(self::CREDENCIALES_INVALIDAS, $r->json(), $nombre);
        }
    }

    public function test_cada_login_hace_una_sola_operacion_bcrypt_exista_o_no_el_correo(): void  // Ruling 22
    {
        $real = $this->usuario('OPERADOR_BODEGA', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234']);
        $espia = $this->espiarHash();

        // Un correo inexistente: cero Hash::make (el hash falso no se calcula por petición) y un Hash::check.
        $this->postJson('/api/auth/login', ['correo' => 'nadie@example.test', 'contrasena' => 'Clave1234'])->assertStatus(401);
        $this->assertSame(0, $espia->fabricaciones, 'Calcular un hash por petición delata que el correo no existe.');
        $this->assertCount(1, $espia->comprobaciones);
        $this->assertSame(['Clave1234', AuthController::HASH_FALSO], $espia->comprobaciones[0]);

        // Un correo existente con la contraseña errónea: lo mismo.
        $espia->comprobaciones = [];
        $this->postJson('/api/auth/login', ['correo' => 'op@example.test', 'contrasena' => 'otra-cosa'])->assertStatus(401);
        $this->assertSame(0, $espia->fabricaciones);
        $this->assertCount(1, $espia->comprobaciones);
        $this->assertSame(['otra-cosa', $real->contrasena_cifrada], $espia->comprobaciones[0]);

        // Y con la contraseña correcta.
        $espia->comprobaciones = [];
        $this->postJson('/api/auth/login', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234'])->assertOk();
        $this->assertSame(0, $espia->fabricaciones);
        $this->assertCount(1, $espia->comprobaciones);
        $this->assertSame(['Clave1234', $real->contrasena_cifrada], $espia->comprobaciones[0]);
    }

    public function test_el_hash_falso_es_un_bcrypt_valido_con_el_costo_de_bcrypt_rounds_de_env_example(): void  // Ruling 22
    {
        $info = Hash::info(AuthController::HASH_FALSO);
        $this->assertSame('bcrypt', $info['algoName']);

        // El costo de producción es el de .env.example; si alguien cambia uno sin el otro, esta prueba avisa.
        $this->assertMatchesRegularExpression('/^BCRYPT_ROUNDS=(\d+)$/m', file_get_contents(base_path('.env.example')));
        preg_match('/^BCRYPT_ROUNDS=(\d+)$/m', file_get_contents(base_path('.env.example')), $coincidencias);
        $this->assertSame((int) $coincidencias[1], $info['options']['cost']);

        // Es un hash que nadie conoce: no corresponde a ninguna contraseña de uso común ni a las de las pruebas.
        foreach (['password', 'Contrasena123', 'Clave1234'] as $candidata) {
            $this->assertFalse(Hash::check($candidata, AuthController::HASH_FALSO));
        }
    }

    public function test_usuario_inactivo_con_la_contrasena_correcta_es_403_usuario_inactivo(): void
    {
        $this->usuario('VENDEDOR', ['correo' => 'ven@example.test', 'contrasena' => 'Clave1234', 'activo' => false]);

        $correcta = $this->postJson('/api/auth/login', ['correo' => 'ven@example.test', 'contrasena' => 'Clave1234']);
        $correcta->assertStatus(403)->assertJsonPath('error.codigo', 'USUARIO_INACTIVO');
        $this->assertSame([], $correcta->json('error.detalles'));
        $this->assertArrayNotHasKey('token', $correcta->json());

        // Y con la incorrecta sigue siendo 401: no se revela que la cuenta está inactiva sin conocer la contraseña.
        $incorrecta = $this->postJson('/api/auth/login', ['correo' => 'ven@example.test', 'contrasena' => 'otra-cosa']);
        $incorrecta->assertStatus(401)->assertJsonPath('error.codigo', 'CREDENCIALES_INVALIDAS');
        $this->assertSame(self::CREDENCIALES_INVALIDAS, $incorrecta->json());
    }

    public function test_login_sin_campos_es_422(): void
    {
        $this->assertDatosNoValidos($this->postJson('/api/auth/login', []), ['correo', 'contrasena']);
        $this->assertDatosNoValidos($this->postJson('/api/auth/login', ['correo' => 'a@example.test']), ['contrasena']);
        $this->assertDatosNoValidos($this->postJson('/api/auth/login', ['contrasena' => 'Clave1234']), ['correo']);

        $r = $this->postJson('/api/auth/login', []);
        $this->assertSame(
            [
                ['campo' => 'correo', 'mensaje' => 'El correo es obligatorio.'],
                ['campo' => 'contrasena', 'mensaje' => 'La contraseña es obligatoria.'],
            ],
            $r->json('error.detalles'),
        );
    }

    /** @return array<string, array{array<string, mixed>, list<string>}> */
    public static function cuerposDeLoginNoValidos(): array
    {
        return [
            'campos vacíos' => [['correo' => '', 'contrasena' => ''], ['correo', 'contrasena']],
            'campos solo con espacios' => [['correo' => '   ', 'contrasena' => '   '], ['correo', 'contrasena']],
            'campos nulos' => [['correo' => null, 'contrasena' => null], ['correo', 'contrasena']],
            'correo arreglo' => [['correo' => ['a@example.test'], 'contrasena' => 'Clave1234'], ['correo']],
            'contraseña arreglo' => [['correo' => 'a@example.test', 'contrasena' => ['Clave1234']], ['contrasena']],
            'contraseña número' => [['correo' => 'a@example.test', 'contrasena' => 12345678], ['contrasena']],
            'correo larguísimo' => [['correo' => str_repeat('a', 256), 'contrasena' => 'Clave1234'], ['correo']],
            'contraseña larguísima' => [['correo' => 'a@example.test', 'contrasena' => str_repeat('a', 256)], ['contrasena']],
        ];
    }

    /**
     * @param  array<string, mixed>  $cuerpo
     * @param  list<string>  $campos
     */
    #[DataProvider('cuerposDeLoginNoValidos')]
    public function test_login_con_datos_no_validos_es_422_y_nunca_500(array $cuerpo, array $campos): void
    {
        $this->assertDatosNoValidos($this->postJson('/api/auth/login', $cuerpo), $campos);
    }

    public function test_login_con_el_cuerpo_json_mal_formado_no_es_500(): void
    {
        $r = $this->call('POST', '/api/auth/login', [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'], '{"correo": ');

        $this->assertDatosNoValidos($r, ['correo', 'contrasena']);
    }

    public function test_solo_se_acepta_post_en_el_login(): void
    {
        // Otro método cae en el comodín de reenvío (Tarea 9): 401 sin token y 404 con token, nunca 405, para no
        // revelar qué rutas existen. Nunca llega a un servicio ni al controlador del login.
        Http::preventStrayRequests();
        Http::fake();

        $this->getJson('/api/auth/login')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        $this->conSesion($this->usuario())->getJson('/api/auth/login')->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');

        Http::assertNothingSent();
    }

    public function test_el_administrador_sembrado_puede_entrar_y_esta_obligado_a_cambiar_su_contrasena(): void
    {
        config(['gateway.admin' => ['correo' => '  Admin@Example.TEST ', 'contrasena' => 'Temporal123']]);
        $this->seed(DatabaseSeeder::class);

        $login = $this->postJson('/api/auth/login', ['correo' => 'ADMIN@example.test', 'contrasena' => 'Temporal123'])->assertOk()
            ->assertJsonPath('usuario.rol', 'ADMINISTRADOR')->assertJsonPath('usuario.debe_cambiar_contrasena', true);
        $token = $login->json('token');

        $this->withToken($token)->getJson('/api/auth/me')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');

        $this->withToken($token)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Temporal123', 'contrasena_nueva' => 'Definitiva456'])->assertNoContent();

        $this->withToken($token)->getJson('/api/auth/me')->assertOk()->assertJsonPath('debe_cambiar_contrasena', false);
    }

    // ---------------------------------------------------------------- GET /api/auth/me

    public function test_me_devuelve_el_usuario_con_su_rol_sin_datos_de_contrasena(): void
    {
        $u = $this->usuario('OPERADOR_BODEGA', ['nombre' => 'Olga Operadora', 'correo' => 'olga@example.test', 'id_bodega' => 7, 'contrasena' => 'Clave1234']);
        $otro = $this->usuario('ADMINISTRADOR', ['correo' => 'otro@example.test']);

        $r = $this->conSesion($u)->getJson('/api/auth/me')->assertOk();

        // Sin envoltorio "data": el usuario va directo, con exactamente los campos del contrato.
        $this->assertSame(
            ['id_usuario', 'nombre', 'correo', 'id_rol', 'rol', 'id_bodega', 'activo', 'debe_cambiar_contrasena', 'fecha_creacion'],
            array_keys($r->json()),
        );
        $r->assertJsonPath('id_usuario', $u->id_usuario)
            ->assertJsonPath('nombre', 'Olga Operadora')
            ->assertJsonPath('correo', 'olga@example.test')
            ->assertJsonPath('id_rol', $u->id_rol)
            ->assertJsonPath('rol', 'OPERADOR_BODEGA')
            ->assertJsonPath('id_bodega', 7)
            ->assertJsonPath('activo', true)
            ->assertJsonPath('debe_cambiar_contrasena', false);
        $this->assertMatchesRegularExpression(self::FECHA_ISO_8601, $r->json('fecha_creacion'));
        $this->assertNotSame($otro->id_usuario, $r->json('id_usuario'));

        // Ni la contraseña en claro, ni su hash, ni el nombre de la columna salen en la respuesta.
        $this->assertStringNotContainsString('contrasena_cifrada', $r->getContent());
        $this->assertStringNotContainsString($u->contrasena_cifrada, $r->getContent());
        $this->assertStringNotContainsString('Clave1234', $r->getContent());
        $this->assertStringNotContainsString('$2y$', $r->getContent());
    }

    public function test_me_de_un_rol_sin_bodega_devuelve_id_bodega_nulo(): void
    {
        $this->conSesion($this->usuario('CONTADOR'))->getJson('/api/auth/me')->assertOk()
            ->assertJsonPath('rol', 'CONTADOR')->assertJsonPath('id_bodega', null);
    }

    public function test_me_sin_token_o_con_token_invalido_es_401(): void
    {
        $this->getJson('/api/auth/me')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        $this->withToken('esto.no.es.un.jwt')->getJson('/api/auth/me')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
    }

    public function test_me_con_el_cambio_de_contrasena_pendiente_es_403(): void
    {
        $u = $this->usuario('ADMINISTRADOR', ['debe_cambiar_contrasena' => true]);

        $this->conSesion($u)->getJson('/api/auth/me')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
    }

    // ---------------------------------------------------------------- POST /api/auth/logout

    public function test_logout_es_204(): void
    {
        $u = $this->usuario('VENDEDOR');
        $token = $this->tokenDe($u);

        $r = $this->withToken($token)->postJson('/api/auth/logout')->assertNoContent();
        $this->assertSame('', $r->getContent());

        // Sin revocación: el token sigue vigente hasta su vencimiento; el cliente es quien lo borra.
        $this->withToken($token)->getJson('/api/auth/me')->assertOk()->assertJsonPath('id_usuario', $u->id_usuario);
    }

    public function test_logout_sin_token_es_401(): void
    {
        $this->postJson('/api/auth/logout')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
    }

    public function test_logout_con_el_cambio_de_contrasena_pendiente_es_204(): void
    {
        $this->conSesion($this->usuario('ADMINISTRADOR', ['debe_cambiar_contrasena' => true]))
            ->postJson('/api/auth/logout')->assertNoContent();
    }

    // ---------------------------------------------------------------- PUT /api/auth/contrasena

    public function test_cambiar_contrasena_204_limpia_la_bandera_e_invalida_la_anterior(): void
    {
        $u = $this->usuario('OPERADOR_BODEGA', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234', 'debe_cambiar_contrasena' => true]);

        $r = $this->conSesion($u)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => 'Nueva56789'])->assertNoContent();
        $this->assertSame('', $r->getContent());

        $u->refresh();
        $this->assertFalse($u->debe_cambiar_contrasena);
        $this->assertTrue($u->activo);
        $this->assertSame('OPERADOR_BODEGA', $u->rol->nombre);
        $this->assertSame('bcrypt', Hash::info($u->contrasena_cifrada)['algoName']);
        $this->assertNotSame('Nueva56789', $u->contrasena_cifrada);
        $this->assertTrue(Hash::check('Nueva56789', $u->contrasena_cifrada));

        // La contraseña anterior deja de servir y la nueva sí.
        $this->postJson('/api/auth/login', ['correo' => 'op@example.test', 'contrasena' => 'Clave1234'])->assertStatus(401);
        $this->postJson('/api/auth/login', ['correo' => 'op@example.test', 'contrasena' => 'Nueva56789'])->assertOk()
            ->assertJsonPath('usuario.debe_cambiar_contrasena', false);
    }

    public function test_cambiar_contrasena_sin_cambio_pendiente_tambien_funciona_y_solo_toca_al_usuario_autenticado(): void
    {
        $u = $this->usuario('VENDEDOR', ['contrasena' => 'Clave1234']);
        $otro = $this->usuario('VENDEDOR', ['correo' => 'otro@example.test', 'contrasena' => 'Clave1234', 'debe_cambiar_contrasena' => true]);
        $hashOtro = $otro->contrasena_cifrada;

        $this->conSesion($u)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => 'Nueva56789'])->assertNoContent();

        $otro->refresh();
        $this->assertSame($hashOtro, $otro->contrasena_cifrada);
        $this->assertTrue($otro->debe_cambiar_contrasena);
    }

    public function test_cambiar_contrasena_acepta_la_contrasena_en_el_limite_de_d4(): void
    {
        $u = $this->usuario('VENDEDOR', ['contrasena' => 'Clave1234']);

        $this->conSesion($u)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => 'abcdefg1'])->assertNoContent();
        $this->assertTrue(Hash::check('abcdefg1', $u->refresh()->contrasena_cifrada));
    }

    public function test_contrasena_actual_incorrecta_es_401_contrasena_actual_incorrecta(): void
    {
        $u = $this->usuario('VENDEDOR', ['contrasena' => 'Clave1234', 'debe_cambiar_contrasena' => true]);
        $hash = $u->contrasena_cifrada;

        $r = $this->conSesion($u)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'no-es-esta1', 'contrasena_nueva' => 'Nueva56789']);

        $r->assertStatus(401)->assertJsonPath('error.codigo', 'CONTRASENA_ACTUAL_INCORRECTA');
        $this->assertSame([], $r->json('error.detalles'));

        // No cambia nada: ni el hash ni la bandera.
        $u->refresh();
        $this->assertSame($hash, $u->contrasena_cifrada);
        $this->assertTrue($u->debe_cambiar_contrasena);
    }

    /** @return array<string, array{string, string}> */
    public static function contrasenasNuevasNoValidas(): array
    {
        return [
            'corta' => ['corta1', ContrasenaValida::MENSAJE],
            'siete caracteres' => ['abcdef1', ContrasenaValida::MENSAJE],
            'solo letras' => ['sololetras', ContrasenaValida::MENSAJE],
            'solo números' => ['12345678', ContrasenaValida::MENSAJE],
            'más de 72 bytes' => [str_repeat('a', 72).'1', ContrasenaValida::MENSAJE],
            'igual a la actual' => ['Clave1234', 'La contraseña nueva debe ser distinta de la actual.'],
        ];
    }

    #[DataProvider('contrasenasNuevasNoValidas')]
    public function test_contrasena_nueva_debil_o_igual_a_la_actual_es_422(string $nueva, string $mensaje): void
    {
        $u = $this->usuario('VENDEDOR', ['contrasena' => 'Clave1234', 'debe_cambiar_contrasena' => true]);
        $hash = $u->contrasena_cifrada;

        $r = $this->conSesion($u)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => $nueva]);

        $this->assertDatosNoValidos($r, ['contrasena_nueva']);
        $this->assertSame([['campo' => 'contrasena_nueva', 'mensaje' => $mensaje]], $r->json('error.detalles'));

        $u->refresh();
        $this->assertSame($hash, $u->contrasena_cifrada);
        $this->assertTrue($u->debe_cambiar_contrasena);
        $this->assertStringNotContainsString($nueva, $r->getContent());
    }

    public function test_cambiar_contrasena_sin_campos_o_con_tipos_equivocados_es_422(): void
    {
        $u = $this->usuario('VENDEDOR', ['contrasena' => 'Clave1234']);

        $this->assertDatosNoValidos($this->conSesion($u)->putJson('/api/auth/contrasena', []), ['contrasena_actual', 'contrasena_nueva']);
        $this->assertDatosNoValidos($this->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234']), ['contrasena_nueva']);
        $this->assertDatosNoValidos($this->putJson('/api/auth/contrasena', ['contrasena_nueva' => 'Nueva56789']), ['contrasena_actual']);
        $this->assertDatosNoValidos(
            $this->putJson('/api/auth/contrasena', ['contrasena_actual' => ['Clave1234'], 'contrasena_nueva' => ['Nueva56789']]),
            ['contrasena_actual', 'contrasena_nueva'],
        );
        $this->assertDatosNoValidos(
            $this->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => 12345678]),
            ['contrasena_nueva'],
        );
        $this->assertTrue(Hash::check('Clave1234', $u->refresh()->contrasena_cifrada));
    }

    public function test_cambiar_contrasena_sin_token_es_401(): void
    {
        $this->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => 'Nueva56789'])
            ->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
    }

    public function test_el_token_anterior_sigue_valido_tras_cambiar_la_contrasena_porque_no_hay_revocacion(): void
    {
        $u = $this->usuario('VENDEDOR', ['contrasena' => 'Clave1234']);
        $token = $this->tokenDe($u);

        $this->withToken($token)->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Clave1234', 'contrasena_nueva' => 'Nueva56789'])->assertNoContent();

        $this->withToken($token)->getJson('/api/auth/me')->assertOk();
    }

    public function test_las_rutas_de_auth_estan_registradas_con_el_middleware_esperado(): void
    {
        $esperadas = [
            'POST api/auth/login' => [],
            'POST api/auth/logout' => ['jwt', 'cambio.contrasena'],
            'GET|HEAD api/auth/me' => ['jwt', 'cambio.contrasena'],
            'PUT api/auth/contrasena' => ['jwt', 'cambio.contrasena'],
        ];

        $encontradas = [];
        foreach (app('router')->getRoutes() as $ruta) {
            if (str_starts_with($ruta->uri(), 'api/auth/')) {
                $clave = implode('|', $ruta->methods()).' '.$ruta->uri();
                $encontradas[$clave] = array_values(array_intersect($ruta->gatherMiddleware(), ['jwt', 'cambio.contrasena']));
            }
        }

        $this->assertEquals($esperadas, $encontradas);
    }
}
