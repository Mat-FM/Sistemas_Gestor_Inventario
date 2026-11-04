<?php

namespace Tests\Feature;

use App\Models\Rol;
use App\Models\Usuario;
use App\Rules\ContrasenaValida;
use App\Support\Roles;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Gestión de usuarios y roles del Gateway (RF07, Tabla 6): /api/usuarios y /api/roles, solo para ADMINISTRADOR.
 */
class UsuariosTest extends TestCase
{
    use ApiHelpers;

    private const FECHA_ISO_8601 = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/';

    private const CAMPOS_DEL_USUARIO = [
        'id_usuario', 'nombre', 'correo', 'id_rol', 'rol', 'id_bodega', 'activo', 'debe_cambiar_contrasena', 'fecha_creacion',
    ];

    // ---------------------------------------------------------------------------------------------------------
    // Quién puede usar las rutas
    // ---------------------------------------------------------------------------------------------------------

    public function test_solo_el_administrador_puede_usar_estas_rutas(): void
    {
        $objetivo = $this->usuario(Roles::VEN, ['nombre' => 'Objetivo', 'correo' => 'objetivo@example.test']);
        $operaciones = $this->operaciones($objetivo->id_usuario);

        // Sin token: 401. Va antes de cualquier conSesion(), porque el token de la prueba persiste entre peticiones.
        foreach ($operaciones as [$metodo, $ruta, $cuerpo]) {
            $this->json($metodo, $ruta, $cuerpo)
                ->assertStatus(401)
                ->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        }

        // Los otros tres roles: 403 SIN_PERMISO en las ocho operaciones.
        foreach ([Roles::OPE, Roles::VEN, Roles::CON] as $rol) {
            $this->conSesion($this->usuario($rol));

            foreach ($operaciones as [$metodo, $ruta, $cuerpo]) {
                $this->json($metodo, $ruta, $cuerpo)
                    ->assertStatus(403)
                    ->assertJsonPath('error.codigo', 'SIN_PERMISO');
            }
        }

        // Ninguna de esas peticiones rechazadas cambió nada.
        $this->assertSame(4, Usuario::count(), 'No debió crearse ningún usuario.');
        $despues = $objetivo->fresh();
        $this->assertSame('Objetivo', $despues->nombre);
        $this->assertTrue($despues->activo);
        $this->assertSame($objetivo->contrasena_cifrada, $despues->contrasena_cifrada);

        // Control positivo: el administrador sí pasa en las ocho, con el estado que dice la Tabla 6.
        $this->conSesion($this->usuario(Roles::ADM));

        foreach ($operaciones as [$metodo, $ruta, $cuerpo, $esperado]) {
            $this->json($metodo, $ruta, $cuerpo)->assertStatus($esperado);
        }
    }

    public function test_un_id_malo_no_oculta_el_401_ni_el_403(): void
    {
        $this->getJson('/api/usuarios/abc')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');

        $this->conSesion($this->usuario(Roles::OPE));
        $this->getJson('/api/usuarios/abc')->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');
        $this->postJson('/api/usuarios/1abc/inactivar')->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');

        // Solo el administrador llega a saber que ese id no existe.
        $this->conSesion($this->usuario(Roles::ADM));
        $this->getJson('/api/usuarios/abc')->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
    }

    public function test_el_administrador_con_el_cambio_de_contrasena_pendiente_no_puede_usarlas(): void
    {
        $objetivo = $this->usuario(Roles::VEN);
        $this->conSesion($this->usuario(Roles::ADM, ['debe_cambiar_contrasena' => true]));

        foreach ($this->operaciones($objetivo->id_usuario) as [$metodo, $ruta, $cuerpo]) {
            $this->json($metodo, $ruta, $cuerpo)
                ->assertStatus(403)
                ->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
        }
    }

    public function test_las_rutas_son_exactamente_las_de_la_tabla_6_y_exigen_sesion_y_administrador(): void
    {
        $rutas = collect(Route::getRoutes()->getRoutes())
            ->filter(fn ($ruta) => preg_match('#^api/(usuarios|roles)(/|$)#', $ruta->uri()) === 1);

        $registradas = $rutas
            ->flatMap(fn ($ruta) => collect($ruta->methods())->reject(fn ($m) => $m === 'HEAD')->map(fn ($m) => "{$m} /{$ruta->uri()}"))
            ->sort()->values()->all();

        $esperadas = [
            'GET /api/usuarios', 'POST /api/usuarios', 'GET /api/usuarios/{id}', 'PUT /api/usuarios/{id}',
            'POST /api/usuarios/{id}/inactivar', 'POST /api/usuarios/{id}/activar',
            'POST /api/usuarios/{id}/restablecer-contrasena', 'GET /api/roles',
        ];
        sort($esperadas);

        // Sin PATCH ni DELETE: los usuarios no se borran, se inactivan.
        $this->assertSame($esperadas, $registradas);

        foreach ($rutas as $ruta) {
            $middleware = $ruta->gatherMiddleware();
            $this->assertContains('jwt', $middleware, $ruta->uri());
            $this->assertContains('cambio.contrasena', $middleware, $ruta->uri());
            $this->assertContains('rol:ADMINISTRADOR', $middleware, $ruta->uri());
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Listado
    // ---------------------------------------------------------------------------------------------------------

    public function test_listado_pagina_filtra_por_id_rol_y_activo_y_no_expone_contrasenas(): void
    {
        $admin = $this->usuario(Roles::ADM, ['nombre' => 'Admin']);
        $vendedora = $this->usuario(Roles::VEN, ['nombre' => 'Vendedora']);
        $vendedorInactivo = $this->usuario(Roles::VEN, ['nombre' => 'Vendedor inactivo', 'activo' => false]);
        $operador = $this->usuario(Roles::OPE, ['nombre' => 'Operador', 'id_bodega' => 5]);
        $contador = $this->usuario(Roles::CON, ['nombre' => 'Contador']);
        $this->conSesion($admin);

        $ids = fn (TestResponse $r): array => array_column($r->json('datos'), 'id_usuario');
        $todos = [$admin->id_usuario, $vendedora->id_usuario, $vendedorInactivo->id_usuario, $operador->id_usuario, $contador->id_usuario];

        // Sin parámetros: todos, ordenados por id_usuario, con los valores por omisión en meta.
        $respuesta = $this->getJson('/api/usuarios')->assertOk();
        $this->assertSame($todos, $ids($respuesta));
        $respuesta->assertJsonPath('meta', ['pagina' => 1, 'por_pagina' => 20, 'total' => 5]);

        // Forma de cada usuario y ni rastro de contraseñas: ni el hash, ni su prefijo bcrypt, ni el texto plano.
        $primero = $respuesta->json('datos.0');
        $this->assertEqualsCanonicalizing(self::CAMPOS_DEL_USUARIO, array_keys($primero));
        $this->assertSame('ADMINISTRADOR', $primero['rol']);
        $this->assertMatchesRegularExpression(self::FECHA_ISO_8601, $primero['fecha_creacion']);
        $this->assertSame(5, $respuesta->json('datos.3.id_bodega'));
        $this->assertSinContrasenas($respuesta, self::CONTRASENA_DE_PRUEBA, $admin->contrasena_cifrada);

        // Paginación.
        $pagina2 = $this->getJson('/api/usuarios?pagina=2&por_pagina=2')->assertOk();
        $this->assertSame([$vendedorInactivo->id_usuario, $operador->id_usuario], $ids($pagina2));
        $pagina2->assertJsonPath('meta', ['pagina' => 2, 'por_pagina' => 2, 'total' => 5]);

        $ultima = $this->getJson('/api/usuarios?pagina=3&por_pagina=2')->assertOk();
        $this->assertSame([$contador->id_usuario], $ids($ultima));

        $this->getJson('/api/usuarios?pagina=4&por_pagina=2')->assertOk()
            ->assertJsonPath('datos', [])
            ->assertJsonPath('meta', ['pagina' => 4, 'por_pagina' => 2, 'total' => 5]);

        // El tope de por_pagina es 100: 100 pasa, 101 no.
        $this->getJson('/api/usuarios?por_pagina=100')->assertOk()->assertJsonPath('meta.por_pagina', 100);
        $this->getJson('/api/usuarios?por_pagina=101')
            ->assertStatus(422)
            ->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS')
            ->assertJsonPath('error.detalles.0.campo', 'por_pagina');

        // Filtro por rol: meta.total cuenta solo los que cumplen el filtro.
        $filtrado = $this->getJson('/api/usuarios?id_rol='.$vendedora->id_rol)->assertOk();
        $this->assertSame([$vendedora->id_usuario, $vendedorInactivo->id_usuario], $ids($filtrado));
        $filtrado->assertJsonPath('meta.total', 2);

        // Filtro por estado, con las cuatro formas booleanas que acepta.
        foreach (['false', '0'] as $inactivo) {
            $this->assertSame([$vendedorInactivo->id_usuario], $ids($this->getJson("/api/usuarios?activo={$inactivo}")->assertOk()));
        }
        foreach (['true', '1'] as $activo) {
            $respuestaActivos = $this->getJson("/api/usuarios?activo={$activo}")->assertOk();
            $this->assertSame([$admin->id_usuario, $vendedora->id_usuario, $operador->id_usuario, $contador->id_usuario], $ids($respuestaActivos));
            $respuestaActivos->assertJsonPath('meta.total', 4);
        }

        // Los filtros se combinan; un filtro vacío equivale a no filtrar.
        $this->assertSame([$vendedorInactivo->id_usuario], $ids($this->getJson("/api/usuarios?id_rol={$vendedora->id_rol}&activo=false")->assertOk()));
        $this->assertSame($todos, $ids($this->getJson('/api/usuarios?activo=&id_rol=&pagina=&por_pagina=')->assertOk()));

        // Un rol sin usuarios (no existe) da una página vacía, no un error.
        $this->getJson('/api/usuarios?id_rol=999')->assertOk()->assertJsonPath('datos', [])->assertJsonPath('meta.total', 0);
    }

    /** @return array<string, array{string, string}> */
    public static function filtrosInvalidos(): array
    {
        return [
            'por_pagina 101' => ['por_pagina=101', 'por_pagina'],
            'por_pagina 0' => ['por_pagina=0', 'por_pagina'],
            'por_pagina negativo' => ['por_pagina=-5', 'por_pagina'],
            'por_pagina no numérico' => ['por_pagina=muchos', 'por_pagina'],
            'por_pagina decimal' => ['por_pagina=2.5', 'por_pagina'],
            'por_pagina arreglo' => ['por_pagina[]=5', 'por_pagina'],
            'pagina 0' => ['pagina=0', 'pagina'],
            'pagina negativa' => ['pagina=-1', 'pagina'],
            'pagina no numérica' => ['pagina=abc', 'pagina'],
            'pagina que desborda el desplazamiento' => ['pagina=99999999999999999999', 'pagina'],
            'pagina mayor que el tope' => ['pagina=2147483648', 'pagina'],
            'activo con un valor que no es booleano' => ['activo=quizas', 'activo'],
            'activo 2' => ['activo=2', 'activo'],
            'activo arreglo' => ['activo[]=1', 'activo'],
            'id_rol no numérico' => ['id_rol=abc', 'id_rol'],
            'id_rol decimal' => ['id_rol=1.5', 'id_rol'],
            'id_rol booleano' => ['id_rol=true', 'id_rol'],
            'id_rol arreglo' => ['id_rol[]=1', 'id_rol'],
        ];
    }

    #[DataProvider('filtrosInvalidos')]
    public function test_listado_con_filtros_o_paginacion_invalidos_es_422(string $consulta, string $campo): void
    {
        $this->conSesion($this->usuario());

        // Control positivo: la misma ruta sin la consulta mala responde 200.
        $this->getJson('/api/usuarios')->assertOk();

        $respuesta = $this->getJson("/api/usuarios?{$consulta}");

        $this->assertDatosNoValidos($respuesta, [$campo]);
    }

    public function test_listado_no_hace_una_consulta_por_usuario(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $this->usuario(Roles::VEN);

        $consultas = function (): int {
            DB::flushQueryLog();
            DB::enableQueryLog();
            $this->getJson('/api/usuarios?por_pagina=100')->assertOk();
            $cantidad = count(DB::getQueryLog());
            DB::disableQueryLog();

            return $cantidad;
        };

        $conDos = $consultas();
        foreach (range(1, 6) as $i) {
            $this->usuario(Roles::OPE, ['correo' => "operador{$i}@example.test"]);
        }

        $this->assertSame($conDos, $consultas(), 'El número de consultas no debe crecer con la cantidad de usuarios.');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Crear
    // ---------------------------------------------------------------------------------------------------------

    public function test_crear_usuario_201_con_cambio_de_contrasena_pendiente(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));

        $respuesta = $this->postJson('/api/usuarios', $this->cuerpoNuevo(['nombre' => 'Ana Torres']))
            ->assertStatus(201)
            ->assertJsonPath('nombre', 'Ana Torres')
            ->assertJsonPath('correo', 'ana@example.test')
            ->assertJsonPath('id_rol', $this->idRol(Roles::VEN))
            ->assertJsonPath('rol', 'VENDEDOR')
            ->assertJsonPath('id_bodega', null)
            ->assertJsonPath('activo', true)
            ->assertJsonPath('debe_cambiar_contrasena', true);

        $this->assertEqualsCanonicalizing(self::CAMPOS_DEL_USUARIO, array_keys($respuesta->json()));
        $this->assertIsInt($respuesta->json('id_usuario'));
        $this->assertMatchesRegularExpression(self::FECHA_ISO_8601, $respuesta->json('fecha_creacion'));
        $this->assertSinContrasenas($respuesta, 'Temporal123');

        // Guardado: bcrypt de la temporal, activo y con el cambio pendiente.
        $guardado = Usuario::query()->findOrFail($respuesta->json('id_usuario'));
        $this->assertSame('bcrypt', Hash::info($guardado->contrasena_cifrada)['algoName']);
        $this->assertNotSame('Temporal123', $guardado->contrasena_cifrada);
        $this->assertTrue(Hash::check('Temporal123', $guardado->contrasena_cifrada));
        $this->assertTrue($guardado->activo);
        $this->assertTrue($guardado->debe_cambiar_contrasena);

        // El usuario nuevo entra con la temporal, y mientras no la cambie solo puede cambiarla o cerrar sesión.
        $login = $this->postJson('/api/auth/login', ['correo' => 'ana@example.test', 'contrasena' => 'Temporal123'])
            ->assertOk()
            ->assertJsonPath('usuario.debe_cambiar_contrasena', true);

        $this->withToken($login->json('token'))->getJson('/api/auth/me')
            ->assertStatus(403)
            ->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
    }

    public function test_crear_guarda_el_correo_normalizado_y_el_login_lo_encuentra_con_otras_mayusculas(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));

        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['correo' => 'Ana.TORRES@Example.Test']))
            ->assertStatus(201)
            ->assertJsonPath('correo', 'ana.torres@example.test');

        $this->assertDatabaseHas('usuarios', ['correo' => 'ana.torres@example.test']);
        $this->postJson('/api/auth/login', ['correo' => 'ANA.torres@EXAMPLE.test', 'contrasena' => 'Temporal123'])->assertOk();
    }

    public function test_crear_ignora_los_campos_que_no_son_del_contrato(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));

        $respuesta = $this->postJson('/api/usuarios', $this->cuerpoNuevo([
            'id_usuario' => 999,
            'activo' => false,
            'debe_cambiar_contrasena' => false,
            'contrasena_cifrada' => 'hash-impuesto-por-el-cliente',
            'fecha_creacion' => '2000-01-01T00:00:00Z',
        ]))->assertStatus(201);

        $this->assertNotSame(999, $respuesta->json('id_usuario'));
        $this->assertTrue($respuesta->json('activo'));
        $this->assertTrue($respuesta->json('debe_cambiar_contrasena'));
        $this->assertStringStartsNotWith('2000', $respuesta->json('fecha_creacion'));

        $guardado = Usuario::query()->findOrFail($respuesta->json('id_usuario'));
        $this->assertNotSame('hash-impuesto-por-el-cliente', $guardado->contrasena_cifrada);
        $this->assertTrue(Hash::check('Temporal123', $guardado->contrasena_cifrada));
    }

    public function test_crear_sin_datos_da_422_con_un_detalle_por_campo_y_en_espanol(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));

        $this->postJson('/api/usuarios', [])
            ->assertStatus(422)
            ->assertExactJson(['error' => [
                'codigo' => 'DATOS_NO_VALIDOS',
                'mensaje' => 'Los datos enviados no son válidos.',
                'detalles' => [
                    ['campo' => 'nombre', 'mensaje' => 'El campo nombre es obligatorio.'],
                    ['campo' => 'correo', 'mensaje' => 'El campo correo es obligatorio.'],
                    ['campo' => 'id_rol', 'mensaje' => 'El campo id_rol es obligatorio.'],
                    ['campo' => 'contrasena_temporal', 'mensaje' => 'El campo contraseña temporal es obligatorio.'],
                ],
            ]]);

        $this->assertSame(1, Usuario::count());
    }

    /** @return array<string, array{string, Closure(array<string, mixed>): array<string, mixed>}> */
    public static function cuerposNoValidos(): array
    {
        $con = static fn (string $campo, mixed $valor): Closure => static fn (array $c): array => [...$c, $campo => $valor];
        $sin = static fn (string $campo): Closure => static fn (array $c): array => array_diff_key($c, [$campo => true]);

        return [
            'sin nombre' => ['nombre', $sin('nombre')],
            'nombre vacío' => ['nombre', $con('nombre', '')],
            'nombre de 101 caracteres' => ['nombre', $con('nombre', str_repeat('a', 101))],
            'nombre que no es texto' => ['nombre', $con('nombre', ['Ana'])],
            'sin correo' => ['correo', $sin('correo')],
            'correo sin forma de correo' => ['correo', $con('correo', 'no-es-un-correo')],
            'correo de más de 255 caracteres' => ['correo', $con('correo', str_repeat('a', 251).'@x.co')],
            'sin id_rol' => ['id_rol', $sin('id_rol')],
            'id_rol no numérico' => ['id_rol', $con('id_rol', 'abc')],
            'id_rol booleano (true pasaría por 1)' => ['id_rol', $con('id_rol', true)],
            'id_rol decimal' => ['id_rol', $con('id_rol', 1.5)],
            'id_bodega cero' => ['id_bodega', $con('id_bodega', 0)],
            'id_bodega negativa' => ['id_bodega', $con('id_bodega', -1)],
            'id_bodega no numérica' => ['id_bodega', $con('id_bodega', 'abc')],
            'id_bodega booleana (true pasaría por 1)' => ['id_bodega', $con('id_bodega', true)],
            'id_bodega que no cabe en la columna' => ['id_bodega', $con('id_bodega', 4294967296)],
        ];
    }

    /** @param  Closure(array<string, mixed>): array<string, mixed>  $mutar */
    #[DataProvider('cuerposNoValidos')]
    public function test_crear_valida_la_forma_del_cuerpo(string $campo, Closure $mutar): void
    {
        $this->conSesion($this->usuario(Roles::ADM));

        $respuesta = $this->postJson('/api/usuarios', $mutar($this->cuerpoNuevo()));

        $this->assertDatosNoValidos($respuesta, [$campo]);
        $this->assertSame(1, Usuario::count(), 'No debió crearse ningún usuario.');
    }

    public function test_crear_con_id_rol_inexistente_es_404(): void
    {
        $this->usuario(Roles::VEN, ['correo' => 'ana@example.test']);
        $this->conSesion($this->usuario(Roles::ADM));
        $antes = Usuario::count();

        // D8: 404 NO_EXISTE y no 422; el rol se comprueba antes que el correo repetido.
        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['id_rol' => 9999, 'correo' => 'libre@example.test']))
            ->assertStatus(404)
            ->assertJsonPath('error.codigo', 'NO_EXISTE');
        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['id_rol' => 9999]))
            ->assertStatus(404)
            ->assertJsonPath('error.codigo', 'NO_EXISTE');
        $this->assertSame($antes, Usuario::count());

        // Control positivo: el mismo cuerpo con un rol que existe se crea.
        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['correo' => 'libre@example.test']))->assertStatus(201);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Correo duplicado
    // ---------------------------------------------------------------------------------------------------------

    public function test_correo_duplicado_es_409_correo_duplicado_al_crear_y_al_editar(): void
    {
        $existente = $this->usuario(Roles::VEN, ['nombre' => 'Existente', 'correo' => 'ana@example.test']);
        $otro = $this->usuario(Roles::VEN, ['nombre' => 'Otro', 'correo' => 'otro@example.test']);
        $this->conSesion($this->usuario(Roles::ADM));
        $antes = Usuario::count();

        // Al crear, incluso con otras mayúsculas: Ana@X.com y ana@x.com son el mismo correo.
        foreach (['ana@example.test', 'ANA@Example.TEST'] as $correo) {
            $this->postJson('/api/usuarios', $this->cuerpoNuevo(['correo' => $correo]))
                ->assertStatus(409)
                ->assertJsonPath('error.codigo', 'CORREO_DUPLICADO')
                ->assertJsonPath('error.detalles', []);
        }
        $this->assertSame($antes, Usuario::count());

        // Al editar a otro usuario con ese correo.
        foreach (['ana@example.test', 'ANA@Example.TEST'] as $correo) {
            $this->putJson("/api/usuarios/{$otro->id_usuario}", $this->cuerpoEdicion(['nombre' => 'Otro', 'correo' => $correo]))
                ->assertStatus(409)
                ->assertJsonPath('error.codigo', 'CORREO_DUPLICADO');
        }
        $this->assertSame('otro@example.test', $otro->fresh()->correo);

        // Editar sin cambiar el correo propio es 200, también si solo cambia el uso de mayúsculas (se guarda normalizado).
        $this->putJson("/api/usuarios/{$existente->id_usuario}", $this->cuerpoEdicion(['nombre' => 'Existente editado']))
            ->assertOk()->assertJsonPath('nombre', 'Existente editado');
        $this->putJson("/api/usuarios/{$existente->id_usuario}", $this->cuerpoEdicion(['correo' => 'ANA@EXAMPLE.TEST']))
            ->assertOk()->assertJsonPath('correo', 'ana@example.test');
        $this->assertSame('ana@example.test', $existente->fresh()->correo);

        // Control positivo: un correo libre sí se puede usar al editar.
        $this->putJson("/api/usuarios/{$otro->id_usuario}", $this->cuerpoEdicion(['correo' => 'libre@example.test']))->assertOk();
    }

    public function test_si_otro_proceso_toma_el_correo_entre_la_comprobacion_y_el_guardado_es_409_y_no_500(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $editado = $this->usuario(Roles::VEN, ['correo' => 'viejo@example.test']);

        // La carrera: justo antes de guardar, otro proceso inserta un usuario con ese mismo correo.
        $competidor = fn (string $correo): array => [
            'nombre' => 'Competidor', 'correo' => $correo, 'contrasena_cifrada' => 'x', 'id_rol' => $this->idRol(Roles::VEN),
        ];
        Usuario::creating(fn (Usuario $u) => DB::table('usuarios')->insert($competidor($u->correo)));

        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['correo' => 'carrera@example.test']))
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'CORREO_DUPLICADO');
        $this->assertSame(1, Usuario::query()->where('correo', 'carrera@example.test')->count());

        Usuario::updating(fn (Usuario $u) => DB::table('usuarios')->insert($competidor($u->correo)));

        $this->putJson("/api/usuarios/{$editado->id_usuario}", $this->cuerpoEdicion(['correo' => 'otra-carrera@example.test']))
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'CORREO_DUPLICADO');
        $this->assertSame('viejo@example.test', $editado->fresh()->correo);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Bodega (D9)
    // ---------------------------------------------------------------------------------------------------------

    public function test_operador_sin_bodega_es_422_y_otros_roles_guardan_id_bodega_null(): void
    {
        Http::fake();
        $this->conSesion($this->usuario(Roles::ADM));
        $operador = $this->idRol(Roles::OPE);

        // OPERADOR_BODEGA exige id_bodega: ausente o nulo es 422 con el detalle en id_bodega.
        $this->assertDatosNoValidos($this->postJson('/api/usuarios', $this->cuerpoNuevo(['id_rol' => $operador])), ['id_bodega']);
        $this->assertDatosNoValidos($this->postJson('/api/usuarios', $this->cuerpoNuevo(['id_rol' => $operador, 'id_bodega' => null])), ['id_bodega']);
        $this->assertSame(1, Usuario::count());

        // Con bodega se crea y la guarda como entero.
        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['id_rol' => $operador, 'id_bodega' => 5]))
            ->assertStatus(201)
            ->assertJsonPath('rol', 'OPERADOR_BODEGA')
            ->assertJsonPath('id_bodega', 5);
        $this->assertDatabaseHas('usuarios', ['correo' => 'ana@example.test', 'id_bodega' => 5]);

        // Los demás roles guardan null aunque venga una bodega.
        foreach ([Roles::ADM, Roles::VEN, Roles::CON] as $i => $rol) {
            $respuesta = $this->postJson('/api/usuarios', $this->cuerpoNuevo([
                'correo' => "otro{$i}@example.test",
                'id_rol' => $this->idRol($rol),
                'id_bodega' => 7,
            ]))->assertStatus(201)->assertJsonPath('id_bodega', null);

            $this->assertNull(Usuario::query()->findOrFail($respuesta->json('id_usuario'))->id_bodega, $rol);
        }

        // La bodega no se valida contra ms-inventario (la Tabla 2 no define esa llamada).
        Http::assertNothingSent();
    }

    public function test_editar_aplica_la_regla_de_la_bodega(): void
    {
        Http::fake();
        $this->conSesion($this->usuario(Roles::ADM));
        $operador = $this->usuario(Roles::OPE, ['nombre' => 'Operador', 'correo' => 'operador@example.test', 'id_bodega' => 3]);
        $edicion = fn (string $rol, array $extra = []): array => $this->cuerpoEdicion([
            'nombre' => 'Operador', 'correo' => 'operador@example.test', 'id_rol' => $this->idRol($rol), ...$extra,
        ]);
        $url = "/api/usuarios/{$operador->id_usuario}";

        // Un operador sin bodega es 422 (PUT reemplaza: no cae al valor guardado) y no cambia nada.
        $this->assertDatosNoValidos($this->putJson($url, $edicion(Roles::OPE)), ['id_bodega']);
        $this->assertSame(3, $operador->fresh()->id_bodega);

        // Con otra bodega se actualiza.
        $this->putJson($url, $edicion(Roles::OPE, ['id_bodega' => 9]))->assertOk()->assertJsonPath('id_bodega', 9);

        // De operador a otro rol: id_bodega pasa a null aunque venga una.
        $this->putJson($url, $edicion(Roles::VEN, ['id_bodega' => 4]))
            ->assertOk()
            ->assertJsonPath('rol', 'VENDEDOR')
            ->assertJsonPath('id_bodega', null);
        $this->assertNull($operador->fresh()->id_bodega);

        // De otro rol a operador: la bodega es obligatoria.
        $this->assertDatosNoValidos($this->putJson($url, $edicion(Roles::OPE)), ['id_bodega']);
        $this->assertSame($this->idRol(Roles::VEN), $operador->fresh()->id_rol);
        $this->putJson($url, $edicion(Roles::OPE, ['id_bodega' => 2]))->assertOk()->assertJsonPath('id_bodega', 2);

        Http::assertNothingSent();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Contraseña temporal (D4)
    // ---------------------------------------------------------------------------------------------------------

    /** @return array<string, array{string}> */
    public static function contrasenasDebiles(): array
    {
        return [
            'solo letras' => ['solo-letras'],
            'solo números' => ['12345678'],
            'siete caracteres' => ['Abcdef1'],
            'corta' => ['Ab1'],
            'más de 72 bytes' => [str_repeat('a', 72).'1'],
        ];
    }

    #[DataProvider('contrasenasDebiles')]
    public function test_contrasena_temporal_debil_es_422(string $debil): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $objetivo = $this->usuario(Roles::VEN, ['correo' => 'objetivo@example.test']);
        $antes = $objetivo->contrasena_cifrada;

        // Al crear: 422 con la política (D4) y ningún usuario nuevo.
        $crear = $this->postJson('/api/usuarios', $this->cuerpoNuevo(['contrasena_temporal' => $debil]));
        $this->assertDatosNoValidos($crear, ['contrasena_temporal']);
        $this->assertSame([ContrasenaValida::MENSAJE], array_column($crear->json('error.detalles'), 'mensaje'));
        $this->assertStringNotContainsString($debil, $crear->getContent(), 'La contraseña rechazada no debe volver en la respuesta.');
        $this->assertSame(2, Usuario::count());

        // Al restablecer: lo mismo, y la contraseña y el estado del usuario siguen como estaban.
        $restablecer = $this->postJson("/api/usuarios/{$objetivo->id_usuario}/restablecer-contrasena", ['contrasena_temporal' => $debil]);
        $this->assertDatosNoValidos($restablecer, ['contrasena_temporal']);
        $this->assertStringNotContainsString($debil, $restablecer->getContent());
        $despues = $objetivo->fresh();
        $this->assertSame($antes, $despues->contrasena_cifrada);
        $this->assertFalse($despues->debe_cambiar_contrasena);
    }

    public function test_contrasena_temporal_ausente_o_que_no_es_texto_es_422_y_los_limites_validos_pasan(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $objetivo = $this->usuario(Roles::VEN);
        $restablecer = "/api/usuarios/{$objetivo->id_usuario}/restablecer-contrasena";

        $this->assertDatosNoValidos($this->postJson($restablecer, []), ['contrasena_temporal']);
        $this->assertDatosNoValidos($this->postJson($restablecer, ['contrasena_temporal' => ['Temporal123']]), ['contrasena_temporal']);
        $this->assertDatosNoValidos($this->postJson($restablecer, ['contrasena_temporal' => 12345678]), ['contrasena_temporal']);
        $this->assertDatosNoValidos($this->postJson('/api/usuarios', $this->cuerpoNuevo(['contrasena_temporal' => ['Temporal123']])), ['contrasena_temporal']);

        // Los límites de la política sí pasan: 8 caracteres y 72 bytes exactos.
        $this->postJson($restablecer, ['contrasena_temporal' => 'abcdefg1'])->assertNoContent();
        $this->postJson('/api/usuarios', $this->cuerpoNuevo(['contrasena_temporal' => str_repeat('a', 71).'1']))->assertStatus(201);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Ver y editar
    // ---------------------------------------------------------------------------------------------------------

    public function test_ver_usuario_devuelve_su_representacion_sin_contrasenas(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $operador = $this->usuario(Roles::OPE, ['nombre' => 'Operador', 'id_bodega' => 6, 'activo' => false, 'debe_cambiar_contrasena' => true]);

        $respuesta = $this->getJson("/api/usuarios/{$operador->id_usuario}")
            ->assertOk()
            ->assertJsonPath('id_usuario', $operador->id_usuario)
            ->assertJsonPath('nombre', 'Operador')
            ->assertJsonPath('correo', $operador->correo)
            ->assertJsonPath('id_rol', $operador->id_rol)
            ->assertJsonPath('rol', 'OPERADOR_BODEGA')
            ->assertJsonPath('id_bodega', 6)
            ->assertJsonPath('activo', false)
            ->assertJsonPath('debe_cambiar_contrasena', true);

        $this->assertEqualsCanonicalizing(self::CAMPOS_DEL_USUARIO, array_keys($respuesta->json()));
        $this->assertMatchesRegularExpression(self::FECHA_ISO_8601, $respuesta->json('fecha_creacion'));
        $this->assertSinContrasenas($respuesta, self::CONTRASENA_DE_PRUEBA, $operador->contrasena_cifrada);
    }

    public function test_editar_actualiza_nombre_correo_rol_y_bodega(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $usuario = $this->usuario(Roles::VEN, [
            'nombre' => 'Nombre viejo', 'correo' => 'viejo@example.test', 'activo' => true, 'debe_cambiar_contrasena' => false,
        ]);

        $this->putJson("/api/usuarios/{$usuario->id_usuario}", [
            'nombre' => 'Nombre nuevo',
            'correo' => 'Nuevo@Example.test',
            'id_rol' => $this->idRol(Roles::OPE),
            'id_bodega' => 8,
        ])
            ->assertOk()
            ->assertJsonPath('id_usuario', $usuario->id_usuario)
            ->assertJsonPath('nombre', 'Nombre nuevo')
            ->assertJsonPath('correo', 'nuevo@example.test')
            ->assertJsonPath('id_rol', $this->idRol(Roles::OPE))
            // El nombre del rol sale del rol nuevo, no del que tenía antes de editar.
            ->assertJsonPath('rol', 'OPERADOR_BODEGA')
            ->assertJsonPath('id_bodega', 8);

        $guardado = $usuario->fresh();
        $this->assertSame('Nombre nuevo', $guardado->nombre);
        $this->assertSame('nuevo@example.test', $guardado->correo);
        $this->assertSame($this->idRol(Roles::OPE), $guardado->id_rol);
        $this->assertSame(8, $guardado->id_bodega);

        // Editar no toca la contraseña, el estado ni el cambio pendiente.
        $this->assertSame($usuario->contrasena_cifrada, $guardado->contrasena_cifrada);
        $this->assertTrue($guardado->activo);
        $this->assertFalse($guardado->debe_cambiar_contrasena);

        // Y el cambio de rol surte efecto de inmediato (D3): el usuario ya entra con su rol nuevo.
        $this->postJson('/api/auth/login', ['correo' => 'nuevo@example.test', 'contrasena' => self::CONTRASENA_DE_PRUEBA])
            ->assertOk()->assertJsonPath('usuario.rol', 'OPERADOR_BODEGA');
    }

    public function test_editar_ignora_los_campos_que_no_son_del_contrato(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $usuario = $this->usuario(Roles::VEN);

        $this->putJson("/api/usuarios/{$usuario->id_usuario}", $this->cuerpoEdicion([
            'id_usuario' => 999,
            'activo' => false,
            'debe_cambiar_contrasena' => true,
            'contrasena_cifrada' => 'hash-impuesto-por-el-cliente',
            'contrasena_temporal' => 'Temporal999',
        ]))->assertOk()->assertJsonPath('id_usuario', $usuario->id_usuario);

        $guardado = $usuario->fresh();
        $this->assertTrue($guardado->activo);
        $this->assertFalse($guardado->debe_cambiar_contrasena);
        $this->assertSame($usuario->contrasena_cifrada, $guardado->contrasena_cifrada);
        $this->assertNull(Usuario::query()->find(999));
    }

    /** @param  Closure(array<string, mixed>): array<string, mixed>  $mutar */
    #[DataProvider('cuerposNoValidos')]
    public function test_editar_valida_la_forma_del_cuerpo(string $campo, Closure $mutar): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $usuario = $this->usuario(Roles::VEN, ['nombre' => 'Sin cambios', 'correo' => 'sincambios@example.test']);

        $respuesta = $this->putJson("/api/usuarios/{$usuario->id_usuario}", $mutar($this->cuerpoEdicion()));

        $this->assertDatosNoValidos($respuesta, [$campo]);
        $this->assertSame('Sin cambios', $usuario->fresh()->nombre);
    }

    public function test_editar_con_id_rol_inexistente_es_404(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $usuario = $this->usuario(Roles::VEN, ['nombre' => 'Sin cambios']);
        $url = "/api/usuarios/{$usuario->id_usuario}";

        $this->putJson($url, $this->cuerpoEdicion(['nombre' => 'Cambiado', 'id_rol' => 9999]))
            ->assertStatus(404)
            ->assertJsonPath('error.codigo', 'NO_EXISTE');
        $this->assertSame('Sin cambios', $usuario->fresh()->nombre);

        // Control positivo: con un rol que existe, el mismo cuerpo edita.
        $this->putJson($url, $this->cuerpoEdicion(['nombre' => 'Cambiado']))->assertOk();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Inactivar y activar
    // ---------------------------------------------------------------------------------------------------------

    public function test_inactivar_y_activar(): void
    {
        $admin = $this->usuario(Roles::ADM);
        $usuario = $this->usuario(Roles::VEN, ['correo' => 'vendedora@example.test']);
        $tokenAnterior = $this->tokenDe($usuario);
        $credenciales = ['correo' => 'vendedora@example.test', 'contrasena' => self::CONTRASENA_DE_PRUEBA];
        $this->conSesion($admin);

        // Control: antes de inactivarla entra.
        $this->postJson('/api/auth/login', $credenciales)->assertOk();

        $this->postJson("/api/usuarios/{$usuario->id_usuario}/inactivar")
            ->assertOk()
            ->assertJsonPath('id_usuario', $usuario->id_usuario)
            ->assertJsonPath('activo', false);
        $this->assertFalse($usuario->fresh()->activo);

        // Ya no puede iniciar sesión, y el token que ya tenía deja de servir en la petición siguiente (D3).
        $this->postJson('/api/auth/login', $credenciales)
            ->assertStatus(403)
            ->assertJsonPath('error.codigo', 'USUARIO_INACTIVO');
        $this->withToken($tokenAnterior)->getJson('/api/auth/me')->assertStatus(401);

        // Es idempotente: inactivar a quien ya está inactivo no es un error.
        $this->conSesion($admin);
        $this->postJson("/api/usuarios/{$usuario->id_usuario}/inactivar")->assertOk()->assertJsonPath('activo', false);

        $this->postJson("/api/usuarios/{$usuario->id_usuario}/activar")
            ->assertOk()
            ->assertJsonPath('id_usuario', $usuario->id_usuario)
            ->assertJsonPath('activo', true);
        $this->assertTrue($usuario->fresh()->activo);

        $this->postJson('/api/auth/login', $credenciales)->assertOk();
        $this->withToken($tokenAnterior)->getJson('/api/auth/me')->assertOk();

        $this->conSesion($admin);
        $this->postJson("/api/usuarios/{$usuario->id_usuario}/activar")->assertOk()->assertJsonPath('activo', true);
    }

    public function test_un_administrador_no_puede_inactivarse_a_si_mismo(): void
    {
        $admin = $this->usuario(Roles::ADM);
        $otroAdmin = $this->usuario(Roles::ADM);

        // D10: 409 CONFLICTO y sigue activo (el id de la ruta llega como texto: se compara con el del token).
        $this->conSesion($admin)->postJson("/api/usuarios/{$admin->id_usuario}/inactivar")
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'CONFLICTO');
        $this->assertTrue($admin->fresh()->activo);
        $this->conSesion($admin)->getJson('/api/usuarios')->assertOk();

        // Otro administrador sí puede inactivarlo, y entonces su token deja de servir.
        $this->conSesion($otroAdmin)->postJson("/api/usuarios/{$admin->id_usuario}/inactivar")
            ->assertOk()->assertJsonPath('activo', false);
        $this->conSesion($admin)->getJson('/api/usuarios')->assertStatus(401);
    }

    public function test_un_administrador_no_puede_cambiarse_a_si_mismo_a_otro_rol(): void
    {
        $admin = $this->usuario(Roles::ADM, ['nombre' => 'Admin', 'correo' => 'admin@example.test']);
        $otroAdmin = $this->usuario(Roles::ADM, ['nombre' => 'Otro admin', 'correo' => 'otro@example.test']);
        $propio = fn (string $rol, array $extra = []): array => $this->cuerpoEdicion([
            'nombre' => 'Admin', 'correo' => 'admin@example.test', 'id_rol' => $this->idRol($rol), ...$extra,
        ]);

        // Ruling 23: pasarse a cualquier rol distinto de ADMINISTRADOR es 409 CONFLICTO y no cambia nada.
        $this->conSesion($admin);
        foreach ([Roles::VEN, Roles::CON, Roles::OPE] as $rol) {
            $this->putJson("/api/usuarios/{$admin->id_usuario}", $propio($rol, ['id_bodega' => 1, 'nombre' => 'Cambiado']))
                ->assertStatus(409)
                ->assertJsonPath('error.codigo', 'CONFLICTO');
        }
        $guardado = $admin->fresh();
        $this->assertSame($this->idRol(Roles::ADM), $guardado->id_rol);
        $this->assertSame('Admin', $guardado->nombre);

        // Seguir siendo ADMINISTRADOR y editar el resto de sus datos sí se puede.
        $this->putJson("/api/usuarios/{$admin->id_usuario}", $propio(Roles::ADM, ['nombre' => 'Admin renombrado']))
            ->assertOk()->assertJsonPath('nombre', 'Admin renombrado')->assertJsonPath('rol', 'ADMINISTRADOR');

        // Otro administrador sí puede cambiarle el rol; el token de ese usuario ya tiene el rol nuevo (D3).
        $this->conSesion($otroAdmin)->putJson("/api/usuarios/{$admin->id_usuario}", $propio(Roles::VEN, ['nombre' => 'Admin renombrado']))
            ->assertOk()->assertJsonPath('rol', 'VENDEDOR');
        $this->conSesion($admin)->getJson('/api/usuarios')->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Restablecer contraseña
    // ---------------------------------------------------------------------------------------------------------

    public function test_restablecer_contrasena_204_deja_la_temporal_y_el_cambio_pendiente(): void
    {
        $usuario = $this->usuario(Roles::VEN, ['correo' => 'vendedora@example.test', 'contrasena' => 'Anterior123']);
        $tokenAnterior = $this->tokenDe($usuario);
        $this->conSesion($this->usuario(Roles::ADM));

        // Control: antes de restablecer, la contraseña anterior entra y no hay cambio pendiente.
        $this->postJson('/api/auth/login', ['correo' => 'vendedora@example.test', 'contrasena' => 'Anterior123'])
            ->assertOk()->assertJsonPath('usuario.debe_cambiar_contrasena', false);

        $respuesta = $this->postJson("/api/usuarios/{$usuario->id_usuario}/restablecer-contrasena", ['contrasena_temporal' => 'Temporal456'])
            ->assertNoContent();
        $this->assertSame('', $respuesta->getContent());

        // Guardado: bcrypt de la temporal (no el texto plano) y el cambio pendiente.
        $guardado = $usuario->fresh();
        $this->assertSame('bcrypt', Hash::info($guardado->contrasena_cifrada)['algoName']);
        $this->assertNotSame('Temporal456', $guardado->contrasena_cifrada);
        $this->assertTrue(Hash::check('Temporal456', $guardado->contrasena_cifrada));
        $this->assertFalse(Hash::check('Anterior123', $guardado->contrasena_cifrada));
        $this->assertTrue($guardado->debe_cambiar_contrasena);
        $this->assertTrue($guardado->activo);

        // La anterior deja de servir; con la temporal entra y le queda el cambio pendiente.
        $this->postJson('/api/auth/login', ['correo' => 'vendedora@example.test', 'contrasena' => 'Anterior123'])
            ->assertStatus(401)->assertJsonPath('error.codigo', 'CREDENCIALES_INVALIDAS');
        $login = $this->postJson('/api/auth/login', ['correo' => 'vendedora@example.test', 'contrasena' => 'Temporal456'])
            ->assertOk()->assertJsonPath('usuario.debe_cambiar_contrasena', true);

        // El cambio pendiente aplica ya, también al token que tenía antes: solo puede cambiar la contraseña.
        $this->withToken($tokenAnterior)->getJson('/api/auth/me')
            ->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');

        $this->withToken($login->json('token'))
            ->putJson('/api/auth/contrasena', ['contrasena_actual' => 'Temporal456', 'contrasena_nueva' => 'Definitiva789'])
            ->assertNoContent();
        $this->assertFalse($usuario->fresh()->debe_cambiar_contrasena);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Usuario inexistente
    // ---------------------------------------------------------------------------------------------------------

    public function test_usuario_inexistente_es_404_en_ver_editar_inactivar_activar_y_restablecer(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $existente = $this->usuario(Roles::VEN);

        $operaciones = [
            ['GET', '', [], 200],
            ['PUT', '', $this->cuerpoEdicion(['correo' => 'editado@example.test']), 200],
            ['POST', '/inactivar', [], 200],
            ['POST', '/activar', [], 200],
            ['POST', '/restablecer-contrasena', ['contrasena_temporal' => 'Temporal123'], 204],
        ];
        // Un id que no existe, y ids que no son un número entero: ninguno debe resolverse a un usuario ('1abc' a
        // veces se castea a 1 en MySQL, y un número enorme no cabe en un entero).
        $ids = ['99999', '0', '-1', 'abc', '1abc', '99999999999999999999'];

        foreach ($operaciones as [$metodo, $sufijo, $cuerpo, $esperado]) {
            // Control positivo: con un usuario que sí existe, la misma operación sale bien.
            $this->json($metodo, "/api/usuarios/{$existente->id_usuario}{$sufijo}", $cuerpo)->assertStatus($esperado);

            foreach ($ids as $id) {
                $this->json($metodo, "/api/usuarios/{$id}{$sufijo}", $cuerpo)
                    ->assertStatus(404)
                    ->assertJsonPath('error.codigo', 'NO_EXISTE')
                    ->assertJsonPath('error.detalles', []);
            }
        }
    }

    public function test_usuario_inexistente_es_404_aunque_el_cuerpo_sea_invalido(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));
        $existente = $this->usuario(Roles::VEN);

        // Control positivo: con un usuario que sí existe, ese mismo cuerpo vacío es 422.
        $this->putJson("/api/usuarios/{$existente->id_usuario}", [])->assertStatus(422);
        $this->postJson("/api/usuarios/{$existente->id_usuario}/restablecer-contrasena", [])->assertStatus(422);

        $this->putJson('/api/usuarios/99999', [])->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
        $this->postJson('/api/usuarios/99999/restablecer-contrasena', [])->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------------------------------------------

    public function test_get_roles_devuelve_los_cuatro(): void
    {
        $this->conSesion($this->usuario(Roles::ADM));

        $respuesta = $this->getJson('/api/roles')
            ->assertOk()
            ->assertJsonCount(4, 'datos')
            ->assertJsonPath('meta', ['pagina' => 1, 'por_pagina' => 4, 'total' => 4]);

        $roles = $respuesta->json('datos');
        $this->assertSame(Roles::TODOS, array_column($roles, 'nombre'));
        $this->assertSame(array_map(fn (string $n): int => $this->idRol($n), Roles::TODOS), array_column($roles, 'id_rol'));

        foreach ($roles as $rol) {
            $this->assertSame(['id_rol', 'nombre', 'descripcion'], array_keys($rol));
            $this->assertNotSame('', trim((string) $rol['descripcion']));
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Utilidades
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Las ocho operaciones de la Tabla 6 sobre /api/usuarios y /api/roles, con un cuerpo válido y el estado que
     * recibe un administrador.
     *
     * @return list<array{string, string, array<string, mixed>, int}>
     */
    private function operaciones(int $idObjetivo): array
    {
        return [
            ['GET', '/api/usuarios', [], 200],
            ['POST', '/api/usuarios', $this->cuerpoNuevo(['correo' => 'nuevo@example.test']), 201],
            ['GET', "/api/usuarios/{$idObjetivo}", [], 200],
            ['PUT', "/api/usuarios/{$idObjetivo}", $this->cuerpoEdicion(['nombre' => 'Editado', 'correo' => 'editado@example.test']), 200],
            ['POST', "/api/usuarios/{$idObjetivo}/inactivar", [], 200],
            ['POST', "/api/usuarios/{$idObjetivo}/activar", [], 200],
            ['POST', "/api/usuarios/{$idObjetivo}/restablecer-contrasena", ['contrasena_temporal' => 'Temporal123'], 204],
            ['GET', '/api/roles', [], 200],
        ];
    }

    private function idRol(string $nombre): int
    {
        return (int) Rol::query()->where('nombre', $nombre)->value('id_rol');
    }

    /**
     * Cuerpo válido de POST /api/usuarios (un VENDEDOR).
     *
     * @param  array<string, mixed>  $cambios
     * @return array<string, mixed>
     */
    private function cuerpoNuevo(array $cambios = []): array
    {
        return [
            'nombre' => 'Ana Torres',
            'correo' => 'ana@example.test',
            'id_rol' => $this->idRol(Roles::VEN),
            'contrasena_temporal' => 'Temporal123',
            ...$cambios,
        ];
    }

    /**
     * Cuerpo válido de PUT /api/usuarios/{id} (un VENDEDOR).
     *
     * @param  array<string, mixed>  $cambios
     * @return array<string, mixed>
     */
    private function cuerpoEdicion(array $cambios = []): array
    {
        return [
            'nombre' => 'Ana Torres',
            'correo' => 'ana@example.test',
            'id_rol' => $this->idRol(Roles::VEN),
            ...$cambios,
        ];
    }

    /** 422 DATOS_NO_VALIDOS con exactamente esos campos, cada uno con su mensaje (sin claves de traducción crudas). */
    private function assertDatosNoValidos(TestResponse $respuesta, array $campos): void
    {
        $respuesta->assertStatus(422)->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS');

        $detalles = $respuesta->json('error.detalles');
        $this->assertEqualsCanonicalizing($campos, array_values(array_unique(array_column($detalles, 'campo'))));
        foreach ($detalles as $detalle) {
            $this->assertSame(['campo', 'mensaje'], array_keys($detalle));
            $this->assertNotSame('', trim($detalle['mensaje']));
            $this->assertStringNotContainsString('validation.', $detalle['mensaje'], 'Falta la traducción de una regla.');
        }
    }

    /**
     * Ni `contrasena_cifrada`, ni algún hash bcrypt (`$2y$`), ni las contraseñas en texto plano ni los hashes
     * que se indiquen. (No se busca "contrasena" a secas: `debe_cambiar_contrasena` es un campo legítimo.)
     */
    private function assertSinContrasenas(TestResponse $respuesta, string ...$prohibidos): void
    {
        $contenido = $respuesta->getContent();

        $this->assertStringNotContainsString('contrasena_cifrada', $contenido);
        $this->assertStringNotContainsString('$2y$', $contenido);
        foreach ($prohibidos as $prohibido) {
            $this->assertStringNotContainsString($prohibido, $contenido);
        }
    }
}
