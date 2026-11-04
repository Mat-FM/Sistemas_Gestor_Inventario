<?php

namespace Tests\Feature;

use App\Models\Rol;
use App\Models\Usuario;
use Database\Seeders\AdminSeeder;
use Database\Seeders\DatabaseSeeder;
use Database\Seeders\RolSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

class SeedersTest extends TestCase
{
    use RefreshDatabase;

    private const CUATRO_ROLES = ['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'];

    private function admin(?string $correo = 'admin@example.test', ?string $contrasena = 'Temporal123'): void
    {
        config(['gateway.admin' => ['correo' => $correo, 'contrasena' => $contrasena]]);
    }

    public function test_rol_seeder_crea_exactamente_los_cuatro_roles_y_es_idempotente(): void
    {
        $this->seed(RolSeeder::class);
        $this->seed(RolSeeder::class);

        $this->assertEqualsCanonicalizing(self::CUATRO_ROLES, Rol::pluck('nombre')->all());
        $this->assertSame(4, Rol::count());
    }

    public function test_rol_seeder_repetido_conserva_los_id_y_restablece_la_descripcion(): void
    {
        $this->seed(RolSeeder::class);
        $antes = Rol::pluck('id_rol', 'nombre')->all();

        Rol::where('nombre', 'VENDEDOR')->update(['descripcion' => 'alterada']);
        $this->seed(RolSeeder::class);

        $this->assertSame($antes, Rol::pluck('id_rol', 'nombre')->all());
        $this->assertNotSame('alterada', Rol::where('nombre', 'VENDEDOR')->value('descripcion'));
    }

    public function test_rol_seeder_deja_una_descripcion_en_cada_rol(): void
    {
        $this->seed(RolSeeder::class);

        foreach (Rol::all() as $rol) {
            $this->assertIsString($rol->descripcion, "El rol {$rol->nombre} no tiene descripción.");
            $this->assertNotSame('', trim($rol->descripcion), "El rol {$rol->nombre} tiene la descripción vacía.");
        }
    }

    public function test_admin_seeder_crea_el_primer_administrador_con_cambio_pendiente(): void
    {
        $this->admin();
        $this->seed(RolSeeder::class);
        $this->seed(AdminSeeder::class);

        $u = Usuario::where('correo', 'admin@example.test')->firstOrFail();
        $this->assertTrue($u->debe_cambiar_contrasena);
        $this->assertTrue($u->activo);
        $this->assertNull($u->id_bodega);
        $this->assertSame('ADMINISTRADOR', $u->rol->nombre);
        $this->assertSame('bcrypt', Hash::info($u->contrasena_cifrada)['algoName']);
        $this->assertTrue(Hash::check('Temporal123', $u->contrasena_cifrada));
        $this->assertNotSame('Temporal123', $u->contrasena_cifrada);
    }

    public function test_admin_seeder_repetido_no_duplica_ni_pisa_una_contrasena_ya_cambiada(): void
    {
        $this->admin();
        $this->seed(RolSeeder::class);
        $this->seed(AdminSeeder::class);

        // El administrador ya entró: cambió su contraseña y, después, alguien lo inactivó y le cambió el nombre.
        $u = Usuario::where('correo', 'admin@example.test')->firstOrFail();
        $u->contrasena_cifrada = Hash::make('Nueva4567');
        $u->debe_cambiar_contrasena = false;
        $u->activo = false;
        $u->nombre = 'Otro nombre';
        $u->save();

        // Se vuelve a sembrar, incluso con otra contraseña en el entorno.
        $this->admin('admin@example.test', 'OtraDistinta789');
        $this->seed(AdminSeeder::class);

        $this->assertSame(1, Usuario::count());
        $u = Usuario::where('correo', 'admin@example.test')->firstOrFail();
        $this->assertTrue(Hash::check('Nueva4567', $u->contrasena_cifrada));
        $this->assertFalse(Hash::check('OtraDistinta789', $u->contrasena_cifrada));
        $this->assertFalse(Hash::check('Temporal123', $u->contrasena_cifrada));
        $this->assertFalse($u->debe_cambiar_contrasena);
        $this->assertFalse($u->activo);
        $this->assertSame('Otro nombre', $u->nombre);
    }

    public function test_admin_seeder_no_toca_a_un_usuario_existente_con_ese_correo_aunque_tenga_otro_rol(): void
    {
        $this->seed(RolSeeder::class);
        $vendedor = Rol::where('nombre', 'VENDEDOR')->firstOrFail();
        Usuario::forceCreate([
            'nombre' => 'Previo',
            'correo' => 'admin@example.test',
            'contrasena_cifrada' => Hash::make('Previa12345'),
            'id_rol' => $vendedor->id_rol,
        ]);

        $this->admin();
        $this->seed(AdminSeeder::class);

        $this->assertSame(1, Usuario::count());
        $u = Usuario::firstOrFail();
        $this->assertSame('VENDEDOR', $u->rol->nombre);
        $this->assertSame('Previo', $u->nombre);
        $this->assertTrue(Hash::check('Previa12345', $u->contrasena_cifrada));
        $this->assertFalse($u->debe_cambiar_contrasena);
    }

    /** @return array<string, array{?string, ?string, list<string>, list<string>}> */
    public static function variablesIncompletas(): array
    {
        return [
            'correo nulo' => [null, 'Temporal123', ['ADMIN_EMAIL'], ['ADMIN_PASSWORD']],
            'correo vacío' => ['', 'Temporal123', ['ADMIN_EMAIL'], ['ADMIN_PASSWORD']],
            'correo solo espacios' => ['   ', 'Temporal123', ['ADMIN_EMAIL'], ['ADMIN_PASSWORD']],
            'contraseña nula' => ['admin@example.test', null, ['ADMIN_PASSWORD'], ['ADMIN_EMAIL']],
            'contraseña vacía' => ['admin@example.test', '', ['ADMIN_PASSWORD'], ['ADMIN_EMAIL']],
            'contraseña solo espacios' => ['admin@example.test', '   ', ['ADMIN_PASSWORD'], ['ADMIN_EMAIL']],
            'ninguna de las dos' => [null, null, ['ADMIN_EMAIL', 'ADMIN_PASSWORD'], []],
            'las dos vacías, como en .env.example' => ['', '', ['ADMIN_EMAIL', 'ADMIN_PASSWORD'], []],
        ];
    }

    /**
     * @param  list<string>  $debenAparecer
     * @param  list<string>  $noDebenAparecer
     */
    #[DataProvider('variablesIncompletas')]
    public function test_admin_seeder_sin_variables_falla_con_un_mensaje_claro(?string $correo, ?string $contrasena, array $debenAparecer, array $noDebenAparecer): void
    {
        $this->admin($correo, $contrasena);
        // Con los roles ya sembrados, el fallo solo puede deberse a las variables.
        $this->seed(RolSeeder::class);

        try {
            $this->seed(AdminSeeder::class);
            $this->fail('El AdminSeeder debía fallar sin ADMIN_EMAIL o ADMIN_PASSWORD.');
        } catch (RuntimeException $e) {
            foreach ($debenAparecer as $variable) {
                $this->assertStringContainsString($variable, $e->getMessage());
            }
            foreach ($noDebenAparecer as $variable) {
                $this->assertStringNotContainsString($variable, $e->getMessage());
            }
            if ($contrasena !== null && trim($contrasena) !== '') {
                $this->assertStringNotContainsString($contrasena, $e->getMessage());
            }
        }

        $this->assertSame(0, Usuario::count());
    }

    public function test_admin_seeder_sin_el_rol_administrador_falla_y_pide_ejecutar_rol_seeder(): void
    {
        $this->admin();

        try {
            $this->seed(AdminSeeder::class);
            $this->fail('El AdminSeeder debía fallar sin el rol ADMINISTRADOR.');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('RolSeeder', $e->getMessage());
            $this->assertStringContainsString('ADMINISTRADOR', $e->getMessage());
        }

        $this->assertSame(0, Usuario::count());
    }

    public function test_database_seeder_crea_los_roles_y_el_primer_administrador_y_es_repetible(): void
    {
        $this->admin();

        $this->seed(DatabaseSeeder::class);
        $this->seed(DatabaseSeeder::class);

        $this->assertEqualsCanonicalizing(self::CUATRO_ROLES, Rol::pluck('nombre')->all());
        $this->assertSame(1, Usuario::count());
        $u = Usuario::firstOrFail();
        $this->assertSame('admin@example.test', $u->correo);
        $this->assertSame('ADMINISTRADOR', $u->rol->nombre);
        $this->assertTrue($u->debe_cambiar_contrasena);
    }

    public function test_database_seeder_sin_variables_del_administrador_falla_con_un_mensaje_claro(): void
    {
        $this->admin(null, null);

        try {
            $this->seed(DatabaseSeeder::class);
            $this->fail('El DatabaseSeeder debía fallar sin las variables del administrador.');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('ADMIN_EMAIL', $e->getMessage());
            $this->assertStringContainsString('ADMIN_PASSWORD', $e->getMessage());
        }

        $this->assertSame(0, Usuario::count());
    }

    public function test_config_gateway_lee_admin_email_y_admin_password_del_entorno(): void
    {
        $anterior = [];
        foreach (['ADMIN_EMAIL', 'ADMIN_PASSWORD'] as $variable) {
            $anterior[$variable] = [
                'env' => array_key_exists($variable, $_ENV) ? $_ENV[$variable] : null,
                'server' => array_key_exists($variable, $_SERVER) ? $_SERVER[$variable] : null,
            ];
        }

        try {
            $_ENV['ADMIN_EMAIL'] = $_SERVER['ADMIN_EMAIL'] = 'desde-entorno@example.test';
            $_ENV['ADMIN_PASSWORD'] = $_SERVER['ADMIN_PASSWORD'] = 'ClaveDelEntorno1';

            $config = require base_path('config/gateway.php');
        } finally {
            foreach ($anterior as $variable => $valores) {
                if ($valores['env'] === null) {
                    unset($_ENV[$variable]);
                } else {
                    $_ENV[$variable] = $valores['env'];
                }
                if ($valores['server'] === null) {
                    unset($_SERVER[$variable]);
                } else {
                    $_SERVER[$variable] = $valores['server'];
                }
            }
        }

        $this->assertSame(
            ['admin' => ['correo' => 'desde-entorno@example.test', 'contrasena' => 'ClaveDelEntorno1']],
            $config,
        );
    }
}
