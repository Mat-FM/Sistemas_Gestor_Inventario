<?php

namespace Tests\Feature;

use App\Models\Rol;
use App\Models\Usuario;
use App\Support\Roles;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Revocación de sesiones (Rulings 34 a 37): restablecer la contraseña de un usuario o inactivarlo deja sin efecto los
 * tokens que se le emitieron antes. La marca es `usuarios.sesiones_desde`: un token solo vale si su claim `iat` es
 * igual o posterior a ella (a la resolución de un segundo).
 *
 * Todas las pruebas fijan el reloj (Carbon::setTestNow), porque con el reloj real un token y su revocación caerían
 * en el mismo segundo y, por la frontera de un segundo, el token seguiría valiendo.
 */
class SesionesRevocadasTest extends TestCase
{
    use ApiHelpers;

    private const MIGRACION = '2026_11_04_000000_add_sesiones_desde_to_usuarios.php';

    /** Un instante fijo (UTC) lejos del real, para que ninguna fecha de estas pruebas coincida con `fecha_creacion`. */
    private const AHORA = '2030-03-05 12:00:00';

    /** Siempre el mismo cuerpo: la respuesta no delata por qué se rechazó el token. */
    private const NO_AUTENTICADO = ['error' => ['codigo' => 'NO_AUTENTICADO', 'mensaje' => 'No autenticado.', 'detalles' => []]];

    private function fijarReloj(string $instante = self::AHORA): void
    {
        Carbon::setTestNow(Carbon::parse($instante, 'UTC'));
    }

    private function avanzar(int $segundos): void
    {
        Carbon::setTestNow(Carbon::now()->addSeconds($segundos));
    }

    /** Inicia sesión por HTTP (el token sale del login, no de JwtService) y devuelve el token. */
    private function iniciarSesion(string $correo, string $contrasena): string
    {
        $token = $this->postJson('/api/auth/login', ['correo' => $correo, 'contrasena' => $contrasena])->assertOk()->json('token');
        $this->assertIsString($token);

        return $token;
    }

    /** @param  array<string, mixed>  $cuerpo */
    private function comoPortador(string $token, string $metodo, string $uri, array $cuerpo = []): TestResponse
    {
        return $this->withToken($token)->json($metodo, $uri, $cuerpo);
    }

    private function assertNoAutenticado(TestResponse $respuesta): void
    {
        $respuesta->assertStatus(401)->assertExactJson(self::NO_AUTENTICADO);
    }

    /** El valor tal como queda en la base, sin pasar por el modelo. */
    private function marcaGuardada(Usuario $usuario): ?string
    {
        return DB::table('usuarios')->where('id_usuario', $usuario->id_usuario)->value('sesiones_desde');
    }

    private function fijarMarca(Usuario $usuario, string $marca): void
    {
        DB::table('usuarios')->where('id_usuario', $usuario->id_usuario)->update(['sesiones_desde' => $marca]);
    }

    private function restablecer(string $tokenAdmin, Usuario $usuario, string $temporal = 'Temporal456'): TestResponse
    {
        return $this->comoPortador($tokenAdmin, 'POST', "/api/usuarios/{$usuario->id_usuario}/restablecer-contrasena", ['contrasena_temporal' => $temporal]);
    }

    private function accion(string $tokenAdmin, Usuario $usuario, string $accion): TestResponse
    {
        return $this->comoPortador($tokenAdmin, 'POST', "/api/usuarios/{$usuario->id_usuario}/{$accion}");
    }

    /** @return array<string, mixed> */
    private function cuerpoEdicion(Usuario $usuario, string $rol, string $nombre): array
    {
        return [
            'nombre' => $nombre,
            'correo' => $usuario->correo,
            'id_rol' => Rol::query()->where('nombre', $rol)->value('id_rol'),
            'id_bodega' => $rol === Roles::OPE ? 1 : null,
        ];
    }

    // ---------------------------------------------------------------------------------------------------------
    // Esquema
    // ---------------------------------------------------------------------------------------------------------

    public function test_la_columna_sesiones_desde_existe_es_nullable_y_no_tiene_valor_por_defecto(): void
    {
        $this->assertTrue(Schema::hasColumn('usuarios', 'sesiones_desde'));

        $columna = collect(Schema::getColumns('usuarios'))->firstWhere('name', 'sesiones_desde');

        $this->assertIsArray($columna);
        $this->assertTrue($columna['nullable'], 'Los usuarios existentes no tienen ninguna revocación: debe poder ser nula.');
        $this->assertNull($columna['default']);
        $this->assertContains($columna['type_name'], ['timestamp', 'datetime']);
    }

    public function test_un_usuario_nuevo_no_tiene_sesiones_revocadas(): void
    {
        $this->assertNull($this->usuario()->fresh()->sesiones_desde);
    }

    public function test_la_migracion_se_puede_revertir_y_volver_a_aplicar(): void
    {
        $migracion = require database_path('migrations/'.self::MIGRACION);

        $migracion->down();
        $this->assertFalse(Schema::hasColumn('usuarios', 'sesiones_desde'));
        // Lo demás de la tabla sigue en su sitio.
        $this->assertTrue(Schema::hasColumns('usuarios', ['id_usuario', 'correo', 'contrasena_cifrada', 'activo', 'debe_cambiar_contrasena']));

        $migracion->up();
        $this->assertTrue(Schema::hasColumn('usuarios', 'sesiones_desde'));
    }

    public function test_sesiones_desde_no_aparece_en_openapi(): void
    {
        // Es un dato interno (Ruling 36): ni como esquema, ni como propiedad, ni mencionado en una descripción.
        $this->assertStringNotContainsString('sesiones_desde', File::get(base_path('openapi.yaml')));
    }

    public function test_sesiones_desde_no_sale_en_ninguna_respuesta_de_la_api(): void
    {
        $this->fijarReloj();
        $tokenAdmin = $this->tokenDe($this->usuario(Roles::ADM));
        $objetivo = $this->usuario(Roles::VEN, ['correo' => 'objetivo@example.test']);
        // Con un valor no nulo y distinguible, anterior al reloj: así los tokens de `objetivo` valen.
        $this->fijarMarca($objetivo, '2030-03-05 07:08:09');
        $id = $objetivo->id_usuario;

        $this->comoPortador($tokenAdmin, 'GET', '/api/usuarios')->assertOk();
        $respuestas = [
            'listado' => $this->comoPortador($tokenAdmin, 'GET', '/api/usuarios'),
            'ver' => $this->comoPortador($tokenAdmin, 'GET', "/api/usuarios/{$id}"),
            'login' => $this->postJson('/api/auth/login', ['correo' => 'objetivo@example.test', 'contrasena' => self::CONTRASENA_DE_PRUEBA]),
            'me' => $this->comoPortador($this->tokenDe($objetivo), 'GET', '/api/auth/me'),
            'editar' => $this->comoPortador($tokenAdmin, 'PUT', "/api/usuarios/{$id}", $this->cuerpoEdicion($objetivo, Roles::VEN, 'Editado')),
            'crear' => $this->comoPortador($tokenAdmin, 'POST', '/api/usuarios', [
                ...$this->cuerpoEdicion($objetivo, Roles::VEN, 'Nuevo'), 'correo' => 'nuevo@example.test', 'contrasena_temporal' => 'Temporal456',
            ]),
            'activar' => $this->accion($tokenAdmin, $objetivo, 'activar'),
            // La última: inactivar mueve la marca a «ahora».
            'inactivar' => $this->accion($tokenAdmin, $objetivo, 'inactivar'),
        ];

        foreach ($respuestas as $nombre => $respuesta) {
            $this->assertContains($respuesta->getStatusCode(), [200, 201], "La respuesta «{$nombre}» debía ser correcta para que la prueba valga.");

            $contenido = $respuesta->getContent();
            $this->assertStringNotContainsString('sesiones_desde', $contenido, "«{$nombre}» expone la marca de revocación.");
            $this->assertStringNotContainsString('07:08:09', $contenido, "«{$nombre}» expone el valor de la marca de revocación.");
            $this->assertStringNotContainsString('2030-03-05', $contenido, "«{$nombre}» expone una fecha de la marca de revocación.");
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Restablecer la contraseña revoca
    // ---------------------------------------------------------------------------------------------------------

    public function test_restablecer_la_contrasena_revoca_las_sesiones_anteriores_y_el_atacante_no_revive(): void
    {
        $this->fijarReloj();
        $tokenAdmin = $this->tokenDe($this->usuario(Roles::ADM));
        $ana = $this->usuario(Roles::VEN, ['correo' => 'ana@example.test', 'contrasena' => 'Anterior123']);

        // T1 es la sesión robada. Control: antes de restablecer sirve.
        $t1 = $this->iniciarSesion('ana@example.test', 'Anterior123');
        $this->comoPortador($t1, 'GET', '/api/auth/me')->assertOk()->assertJsonPath('id_usuario', $ana->id_usuario);

        $this->avanzar(10);
        $this->restablecer($tokenAdmin, $ana)->assertNoContent();
        $this->assertSame('2030-03-05 12:00:10', $this->marcaGuardada($ana));

        // T1 murió, con el mismo cuerpo genérico que un token manipulado y en cualquier ruta, también en las dos
        // que el cambio pendiente deja pasar (nadie puede usarlo para cambiar la contraseña).
        $revocado = $this->comoPortador($t1, 'GET', '/api/auth/me');
        $manipulado = $this->comoPortador($t1.'x', 'GET', '/api/auth/me');
        $this->assertNoAutenticado($revocado);
        $this->assertNoAutenticado($manipulado);
        $this->assertSame($manipulado->getContent(), $revocado->getContent());
        $this->assertNoAutenticado($this->comoPortador($t1, 'POST', '/api/auth/logout'));
        $this->assertNoAutenticado($this->comoPortador($t1, 'PUT', '/api/auth/contrasena', [
            'contrasena_actual' => 'Temporal456', 'contrasena_nueva' => 'Atacante789',
        ]));

        // T2, con la temporal, vale: queda el cambio pendiente (403, no 401) y puede cambiar la contraseña.
        $this->avanzar(10);
        $t2 = $this->iniciarSesion('ana@example.test', 'Temporal456');
        $this->comoPortador($t2, 'GET', '/api/auth/me')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
        $this->comoPortador($t2, 'PUT', '/api/auth/contrasena', ['contrasena_actual' => 'Temporal456', 'contrasena_nueva' => 'Definitiva789'])
            ->assertNoContent();

        // Cambiar la contraseña no revoca T2 (decisión de contrato) y tampoco resucita a T1.
        $this->comoPortador($t2, 'GET', '/api/auth/me')->assertOk()->assertJsonPath('id_usuario', $ana->id_usuario);
        $this->assertNoAutenticado($this->comoPortador($t1, 'GET', '/api/auth/me'));
        $this->assertSame('2030-03-05 12:00:10', $this->marcaGuardada($ana));

        // Revocar a Ana no toca a nadie más.
        $this->comoPortador($tokenAdmin, 'GET', '/api/usuarios')->assertOk();
    }

    public function test_un_administrador_que_restablece_su_propia_contrasena_pierde_su_sesion_actual(): void
    {
        $this->fijarReloj();
        $admin = $this->usuario(Roles::ADM, ['correo' => 'admin@example.test']);
        $a = $this->iniciarSesion('admin@example.test', self::CONTRASENA_DE_PRUEBA);
        $this->comoPortador($a, 'GET', '/api/usuarios')->assertOk();

        $this->avanzar(10);
        // Ruling 37: la petición misma sale bien, pero su token ya no sirve.
        $this->restablecer($a, $admin)->assertNoContent();
        $this->assertNoAutenticado($this->comoPortador($a, 'GET', '/api/usuarios'));

        // Debe iniciar sesión de nuevo, con la temporal.
        $this->avanzar(10);
        $b = $this->iniciarSesion('admin@example.test', 'Temporal456');
        $this->comoPortador($b, 'GET', '/api/usuarios')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
        $this->comoPortador($b, 'PUT', '/api/auth/contrasena', ['contrasena_actual' => 'Temporal456', 'contrasena_nueva' => 'Definitiva789'])
            ->assertNoContent();
        $this->comoPortador($b, 'GET', '/api/usuarios')->assertOk();
        $this->assertNoAutenticado($this->comoPortador($a, 'GET', '/api/usuarios'));
    }

    public function test_la_peticion_con_un_token_revocado_se_registra_como_401_sin_usuario(): void
    {
        $this->fijarReloj();
        $tokenAdmin = $this->tokenDe($this->usuario(Roles::ADM));
        $ana = $this->usuario(Roles::VEN);
        $t1 = $this->tokenDe($ana);
        $this->avanzar(10);
        $this->restablecer($tokenAdmin, $ana)->assertNoContent();

        // Igual que con un usuario inactivo: el rechazo ocurre antes de dejar al usuario en la petición, así que el
        // registro no atribuye la petición a nadie.
        Log::spy();
        $this->assertNoAutenticado($this->comoPortador($t1, 'GET', '/api/auth/me'));

        Log::shouldHaveReceived('info')->withArgs(
            fn ($mensaje, $contexto) => $mensaje === 'peticion' && $contexto['estado'] === 401 && $contexto['id_usuario'] === null
        )->once();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Inactivar revoca y activar no rehabilita
    // ---------------------------------------------------------------------------------------------------------

    public function test_inactivar_revoca_las_sesiones_anteriores_y_reactivar_no_las_rehabilita(): void
    {
        $this->fijarReloj();
        $tokenAdmin = $this->tokenDe($this->usuario(Roles::ADM));
        $ana = $this->usuario(Roles::VEN, ['correo' => 'ana@example.test']);

        $t1 = $this->iniciarSesion('ana@example.test', self::CONTRASENA_DE_PRUEBA);
        $this->comoPortador($t1, 'GET', '/api/auth/me')->assertOk();

        $this->avanzar(10);
        $this->accion($tokenAdmin, $ana, 'inactivar')->assertOk()->assertJsonPath('activo', false);
        $this->assertSame('2030-03-05 12:00:10', $this->marcaGuardada($ana));
        $this->assertNoAutenticado($this->comoPortador($t1, 'GET', '/api/auth/me'));

        // Reactivarla no limpia la marca ni rehabilita el token anterior a la inactivación.
        $this->avanzar(10);
        $this->accion($tokenAdmin, $ana, 'activar')->assertOk()->assertJsonPath('activo', true);
        $this->assertSame('2030-03-05 12:00:10', $this->marcaGuardada($ana));
        $this->assertNoAutenticado($this->comoPortador($t1, 'GET', '/api/auth/me'));

        // Un token emitido después de reactivar vale, y T1 sigue muerto.
        $this->avanzar(10);
        $t2 = $this->iniciarSesion('ana@example.test', self::CONTRASENA_DE_PRUEBA);
        $this->comoPortador($t2, 'GET', '/api/auth/me')->assertOk()->assertJsonPath('id_usuario', $ana->id_usuario);
        $this->assertNoAutenticado($this->comoPortador($t1, 'GET', '/api/auth/me'));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Frontera de un segundo
    // ---------------------------------------------------------------------------------------------------------

    /** @return array<string, array{string}> */
    public static function operacionesQueRevocan(): array
    {
        return [
            'restablecer la contraseña' => ['restablecer'],
            'inactivar y volver a activar' => ['inactivar'],
        ];
    }

    #[DataProvider('operacionesQueRevocan')]
    public function test_un_token_del_mismo_segundo_de_la_revocacion_vale_y_uno_del_segundo_anterior_no(string $operacion): void
    {
        // 12:00:00.900: la marca se guarda truncada al segundo, igual que el iat de los tokens.
        $this->fijarReloj('2030-03-05 12:00:00.900000');
        $segundo = Carbon::parse('2030-03-05 12:00:00', 'UTC')->getTimestamp();
        $this->assertSame($segundo, Carbon::now()->getTimestamp());

        $tokenAdmin = $this->tokenDe($this->usuario(Roles::ADM));
        $objetivo = $this->usuario(Roles::VEN);

        if ($operacion === 'restablecer') {
            $this->restablecer($tokenAdmin, $objetivo)->assertNoContent();
        } else {
            $this->accion($tokenAdmin, $objetivo, 'inactivar')->assertOk();
            $this->accion($tokenAdmin, $objetivo, 'activar')->assertOk();
        }
        $this->assertSame('2030-03-05 12:00:00', $this->marcaGuardada($objetivo));

        // `logout` es la ruta que sirve en los dos casos (con el cambio pendiente también deja pasar).
        $conIat = fn (int $iat): string => $this->tokenFirmado(['sub' => (string) $objetivo->id_usuario, 'iat' => $iat, 'exp' => $iat + 3600]);

        $this->comoPortador($conIat($segundo), 'POST', '/api/auth/logout')->assertNoContent();
        $this->assertNoAutenticado($this->comoPortador($conIat($segundo - 1), 'POST', '/api/auth/logout'));

        // Ventana aceptada: el token que emite el Gateway en ese mismo segundo (quien entra con la temporal justo al
        // restablecer) no queda bloqueado.
        $this->comoPortador($this->tokenDe($objetivo), 'POST', '/api/auth/logout')->assertNoContent();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Lo que NO fija ni mueve la marca
    // ---------------------------------------------------------------------------------------------------------

    public function test_cambiar_la_propia_contrasena_no_revoca_ninguna_sesion(): void
    {
        $this->fijarReloj();
        $ana = $this->usuario(Roles::VEN, ['correo' => 'ana@example.test']);
        $a = $this->iniciarSesion('ana@example.test', self::CONTRASENA_DE_PRUEBA);
        $b = $this->iniciarSesion('ana@example.test', self::CONTRASENA_DE_PRUEBA);

        $this->avanzar(10);
        $this->comoPortador($a, 'PUT', '/api/auth/contrasena', ['contrasena_actual' => self::CONTRASENA_DE_PRUEBA, 'contrasena_nueva' => 'Definitiva789'])
            ->assertNoContent();

        // No fija la marca: ni su token ni el de la otra sesión mueren.
        $this->assertNull($this->marcaGuardada($ana));
        $this->comoPortador($a, 'GET', '/api/auth/me')->assertOk();
        $this->comoPortador($b, 'GET', '/api/auth/me')->assertOk();

        // Con una marca anterior tampoco la mueve.
        $this->fijarMarca($ana, '2030-03-05 11:00:00');
        $this->avanzar(10);
        $this->comoPortador($a, 'PUT', '/api/auth/contrasena', ['contrasena_actual' => 'Definitiva789', 'contrasena_nueva' => 'Tercera321'])
            ->assertNoContent();
        $this->assertSame('2030-03-05 11:00:00', $this->marcaGuardada($ana));
        $this->comoPortador($a, 'GET', '/api/auth/me')->assertOk();
        $this->comoPortador($b, 'GET', '/api/auth/me')->assertOk();
    }

    public function test_activar_cambiar_el_rol_y_editar_los_datos_no_tocan_la_marca(): void
    {
        $this->fijarReloj();
        $tokenAdmin = $this->tokenDe($this->usuario(Roles::ADM));
        $sinMarca = $this->usuario(Roles::VEN);
        $conMarca = $this->usuario(Roles::VEN);
        $this->fijarMarca($conMarca, '2030-03-05 11:00:00');
        $this->avanzar(10);

        foreach ([[$sinMarca, null], [$conMarca, '2030-03-05 11:00:00']] as [$usuario, $esperada]) {
            $this->accion($tokenAdmin, $usuario, 'activar')->assertOk();
            $this->assertSame($esperada, $this->marcaGuardada($usuario), 'activar movió la marca.');

            $this->comoPortador($tokenAdmin, 'PUT', "/api/usuarios/{$usuario->id_usuario}", $this->cuerpoEdicion($usuario, Roles::VEN, 'Otro nombre'))
                ->assertOk()->assertJsonPath('nombre', 'Otro nombre');
            $this->assertSame($esperada, $this->marcaGuardada($usuario), 'editar los datos movió la marca.');

            $this->comoPortador($tokenAdmin, 'PUT', "/api/usuarios/{$usuario->id_usuario}", $this->cuerpoEdicion($usuario, Roles::CON, 'Otro nombre'))
                ->assertOk()->assertJsonPath('rol', 'CONTADOR');
            $this->assertSame($esperada, $this->marcaGuardada($usuario), 'cambiar el rol movió la marca.');
        }
    }

    public function test_los_rechazos_no_fijan_la_marca(): void
    {
        $this->fijarReloj();
        $admin = $this->usuario(Roles::ADM);
        $tokenAdmin = $this->tokenDe($admin);
        $otro = $this->usuario(Roles::VEN);
        $hashAntes = $otro->contrasena_cifrada;
        $this->avanzar(10);

        // 409: el administrador no puede inactivarse a sí mismo, y su sesión sigue en pie.
        $this->accion($tokenAdmin, $admin, 'inactivar')->assertStatus(409)->assertJsonPath('error.codigo', 'CONFLICTO');
        $this->assertNull($this->marcaGuardada($admin));
        $this->comoPortador($tokenAdmin, 'GET', '/api/usuarios')->assertOk();

        // 404: un usuario inexistente no tiene efectos en nadie.
        foreach (['99999', 'abc'] as $id) {
            $this->comoPortador($tokenAdmin, 'POST', "/api/usuarios/{$id}/inactivar")->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
            $this->comoPortador($tokenAdmin, 'POST', "/api/usuarios/{$id}/restablecer-contrasena", ['contrasena_temporal' => 'Temporal456'])
                ->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
        }

        // 422: una temporal que no cumple la política no restablece nada.
        $this->restablecer($tokenAdmin, $otro, 'corta')->assertStatus(422);

        $this->assertSame(0, Usuario::query()->whereNotNull('sesiones_desde')->count());
        $this->assertSame($hashAntes, $otro->fresh()->contrasena_cifrada);

        // Control positivo: la misma operación sobre un usuario que existe y con datos válidos sí la fija.
        $this->restablecer($tokenAdmin, $otro)->assertNoContent();
        $this->assertSame('2030-03-05 12:00:10', $this->marcaGuardada($otro));
        $this->assertSame(1, Usuario::query()->whereNotNull('sesiones_desde')->count());
    }
}
