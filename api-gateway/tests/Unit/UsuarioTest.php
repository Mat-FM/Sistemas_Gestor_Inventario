<?php

namespace Tests\Unit;

use App\Models\Rol;
use App\Models\Usuario;
use App\Support\Roles;
use Database\Seeders\RolSeeder;
use Illuminate\Database\Eloquent\MassAssignmentException;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class UsuarioTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed(RolSeeder::class);
    }

    private function idRol(string $nombre): int
    {
        return Rol::where('nombre', $nombre)->firstOrFail()->id_rol;
    }

    /** @param  array<string, mixed>  $atributos */
    private function crear(string $rol = Roles::VEN, array $atributos = []): Usuario
    {
        return Usuario::forceCreate(array_merge([
            'nombre' => 'n',
            'correo' => 'c@example.test',
            'contrasena_cifrada' => 'h',
            'id_rol' => $this->idRol($rol),
        ], $atributos));
    }

    public function test_usuario_nunca_serializa_la_contrasena(): void
    {
        $u = Usuario::forceCreate(['nombre' => 'n', 'correo' => 'c@example.test', 'contrasena_cifrada' => 'h', 'id_rol' => Rol::first()->id_rol]);

        $this->assertArrayNotHasKey('contrasena_cifrada', $u->toArray());
    }

    public function test_la_contrasena_tampoco_sale_en_json_ni_con_el_rol_cargado_ni_al_releer(): void
    {
        $this->crear(Roles::VEN, ['contrasena_cifrada' => 'hash-secreto-que-no-debe-salir']);

        $u = Usuario::with('rol')->firstOrFail();

        $this->assertArrayNotHasKey('contrasena_cifrada', $u->toArray());
        $this->assertArrayNotHasKey('contrasena_cifrada', $u->rol->toArray());
        $this->assertStringNotContainsString('hash-secreto-que-no-debe-salir', $u->toJson());
        // El atributo sigue disponible para el código que verifica la contraseña.
        $this->assertSame('hash-secreto-que-no-debe-salir', $u->contrasena_cifrada);
    }

    public function test_correo_unico_a_nivel_de_base_de_datos(): void
    {
        $this->crear(Roles::VEN, ['correo' => 'repetido@example.test']);

        try {
            $this->crear(Roles::CON, ['correo' => 'repetido@example.test']);
            $this->fail('La base debía rechazar un correo repetido.');
        } catch (QueryException $e) {
            $this->assertMatchesRegularExpression('/unique|duplicate/i', $e->getMessage());
        }

        $this->assertSame(1, Usuario::count());
    }

    public function test_el_rol_del_usuario_debe_existir_a_nivel_de_base_de_datos(): void
    {
        try {
            $this->crear(Roles::VEN, ['id_rol' => 9999]);
            $this->fail('La base debía rechazar un id_rol inexistente.');
        } catch (QueryException $e) {
            $this->assertMatchesRegularExpression('/foreign key/i', $e->getMessage());
        }

        $this->assertSame(0, Usuario::count());
    }

    public function test_un_rol_con_usuarios_no_se_puede_borrar(): void
    {
        $u = $this->crear(Roles::VEN);

        try {
            Rol::whereKey($u->id_rol)->delete();
            $this->fail('La base debía rechazar el borrado de un rol con usuarios.');
        } catch (QueryException $e) {
            $this->assertMatchesRegularExpression('/foreign key/i', $e->getMessage());
        }

        $this->assertSame(1, Rol::whereKey($u->id_rol)->count());
    }

    public function test_los_valores_por_defecto_de_un_usuario_nuevo(): void
    {
        $this->assertTrue((new Usuario)->activo);
        $this->assertFalse((new Usuario)->debe_cambiar_contrasena);

        $u = $this->crear()->fresh();

        $this->assertTrue($u->activo);
        $this->assertFalse($u->debe_cambiar_contrasena);
        $this->assertNull($u->id_bodega);
        $this->assertInstanceOf(Carbon::class, $u->fecha_creacion);
    }

    public function test_los_campos_se_leen_con_su_tipo_y_la_fecha_sale_en_iso_8601(): void
    {
        $this->crear(Roles::OPE, ['id_bodega' => 7, 'activo' => false, 'debe_cambiar_contrasena' => true]);

        $u = Usuario::firstOrFail();

        $this->assertSame(7, $u->id_bodega);
        $this->assertFalse($u->activo);
        $this->assertTrue($u->debe_cambiar_contrasena);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/', $u->toArray()['fecha_creacion']);
    }

    public function test_el_modelo_cumple_el_contrato_de_la_interfaz(): void
    {
        $u = new Usuario;

        $this->assertSame('usuarios', $u->getTable());
        $this->assertSame('id_usuario', $u->getKeyName());
        $this->assertFalse($u->timestamps);

        $r = new Rol;

        $this->assertSame('roles', $r->getTable());
        $this->assertSame('id_rol', $r->getKeyName());
        $this->assertFalse($r->timestamps);
    }

    /** @return array<string, array{string, mixed}> */
    public static function camposSensibles(): array
    {
        return [
            'id_usuario' => ['id_usuario', 99],
            'id_rol' => ['id_rol', 1],
            'contrasena_cifrada' => ['contrasena_cifrada', 'hash-ajeno'],
            'activo' => ['activo', false],
            'debe_cambiar_contrasena' => ['debe_cambiar_contrasena', true],
            'id_bodega' => ['id_bodega', 3],
        ];
    }

    #[DataProvider('camposSensibles')]
    public function test_los_campos_sensibles_no_se_asignan_en_masa_y_el_intento_falla_en_voz_alta(string $campo, mixed $valor): void
    {
        $u = new Usuario;

        try {
            $u->fill([$campo => $valor]);
            $this->fail("El campo {$campo} no debía poder asignarse en masa.");
        } catch (MassAssignmentException) {
            // Esperado: no se descarta en silencio.
        }

        // El intento no dejó rastro: el modelo conserva sus valores por defecto.
        $this->assertNull($u->id_usuario);
        $this->assertNull($u->id_rol);
        $this->assertNull($u->contrasena_cifrada);
        $this->assertNull($u->id_bodega);
        $this->assertTrue($u->activo);
        $this->assertFalse($u->debe_cambiar_contrasena);
    }

    public function test_la_relacion_rol_devuelve_el_rol_del_usuario_y_el_rol_sus_usuarios(): void
    {
        $u = $this->crear(Roles::CON);

        $this->assertInstanceOf(Rol::class, $u->rol);
        $this->assertSame('CONTADOR', $u->rol->nombre);
        $this->assertSame([$u->id_usuario], $u->rol->usuarios->pluck('id_usuario')->all());
    }

    /** @return array<string, array{string, bool}> */
    public static function rolesYSiSonOperador(): array
    {
        return [
            'ADMINISTRADOR' => ['ADMINISTRADOR', false],
            'OPERADOR_BODEGA' => ['OPERADOR_BODEGA', true],
            'VENDEDOR' => ['VENDEDOR', false],
            'CONTADOR' => ['CONTADOR', false],
        ];
    }

    #[DataProvider('rolesYSiSonOperador')]
    public function test_es_operador_solo_para_el_rol_operador_de_bodega(string $rol, bool $esperado): void
    {
        $u = $this->crear($rol);

        $this->assertSame($esperado, $u->esOperador());
        $this->assertSame($esperado, Usuario::findOrFail($u->id_usuario)->esOperador());
    }

    public function test_tiene_rol_acepta_varios_roles_y_basta_con_que_coincida_uno(): void
    {
        $u = $this->crear(Roles::VEN);

        $this->assertTrue($u->tieneRol(Roles::VEN));
        $this->assertTrue($u->tieneRol(Roles::ADM, Roles::VEN));
        $this->assertTrue($u->tieneRol(...Roles::TODOS));
        $this->assertFalse($u->tieneRol(Roles::ADM));
        $this->assertFalse($u->tieneRol(Roles::ADM, Roles::OPE, Roles::CON));
        $this->assertFalse($u->tieneRol('vendedor'), 'La comparación distingue mayúsculas y minúsculas.');
        $this->assertFalse($u->tieneRol('NO_EXISTE'));
    }

    public function test_tiene_rol_sin_argumentos_es_falso(): void
    {
        $this->assertFalse($this->crear(Roles::ADM)->tieneRol());
    }

    public function test_un_usuario_sin_rol_no_tiene_ningun_rol_ni_es_operador(): void
    {
        $u = new Usuario;

        $this->assertFalse($u->esOperador());
        $this->assertFalse($u->tieneRol(...Roles::TODOS));
        // Sin rol el nombre es null: con una comparación laxa, null == '' daría verdadero.
        $this->assertFalse($u->tieneRol(''));
    }
}
