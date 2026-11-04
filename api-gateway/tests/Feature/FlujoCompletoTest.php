<?php

namespace Tests\Feature;

use Database\Seeders\AdminSeeder;
use Illuminate\Http\Client\Request as PeticionAlServicio;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Flujo completo solo por HTTP, como lo vería un cliente: el administrador sembrado inicia sesión, cambia su
 * contraseña temporal, crea un operador de bodega, le cambia el rol y lo inactiva; cada token sale del login, nunca
 * de JwtService. Los microservicios son falsos (Http::fake) y cualquier otra salida a la red falla.
 */
class FlujoCompletoTest extends TestCase
{
    use ApiHelpers;

    private const CORREO_ADMIN = 'admin@example.test';

    private const TEMPORAL_ADMIN = 'Temporal123';

    private const NUEVA_ADMIN = 'Definitiva456';

    private const CORREO_OPERADOR = 'operador@example.test';

    private const TEMPORAL_OPERADOR = 'Operador123';

    private const NUEVA_OPERADOR = 'Bodeguero789';

    private const URL_PRODUCTOS = 'http://ms-catalogo:8000/productos';

    /** Cabeceras que un cliente malicioso intenta colar; ninguna debe llegar al servicio tal cual. */
    private const CABECERAS_DEL_CLIENTE = [
        'Cookie' => 'sesion=robada',
        'X-User-Id' => '999',
        'X-User-Rol' => 'ADMINISTRADOR',
        'X-User-Bodega' => '42',
        'X-Request-Id' => 'id-del-cliente',
    ];

    protected function setUp(): void
    {
        parent::setUp();

        Http::preventStrayRequests();
        Http::fake([self::URL_PRODUCTOS => Http::response(['datos' => [], 'meta' => ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]])]);

        config(['gateway.admin.correo' => self::CORREO_ADMIN, 'gateway.admin.contrasena' => self::TEMPORAL_ADMIN]);
        $this->seed(AdminSeeder::class);
    }

    /** Inicia sesión por HTTP y devuelve el token. */
    private function iniciarSesion(string $correo, string $contrasena): string
    {
        $token = $this->postJson('/api/auth/login', ['correo' => $correo, 'contrasena' => $contrasena])
            ->assertOk()
            ->assertJsonPath('expira_en', 3600)
            ->json('token');
        $this->assertIsString($token);

        return $token;
    }

    /** @param  array<string, mixed>  $cuerpo */
    private function comoPortador(string $token, string $metodo, string $uri, array $cuerpo = []): TestResponse
    {
        return $this->withHeaders(['Authorization' => "Bearer {$token}", ...self::CABECERAS_DEL_CLIENTE])->json($metodo, $uri, $cuerpo);
    }

    private function cambiarContrasena(string $token, string $actual, string $nueva): void
    {
        $this->comoPortador($token, 'PUT', '/api/auth/contrasena', ['contrasena_actual' => $actual, 'contrasena_nueva' => $nueva])
            ->assertNoContent();
    }

    /** @return list<PeticionAlServicio> */
    private function peticionesAlServicio(): array
    {
        return array_map(fn (array $par): PeticionAlServicio => $par[0], Http::recorded()->all());
    }

    /**
     * La única petición nueva al servicio desde `$antes` es GET /productos con la identidad indicada y el mismo
     * X-Request-Id que recibió el cliente, sin credenciales ni cabeceras de identidad del cliente.
     */
    private function assertReenviadoCon(TestResponse $respuesta, int $antes, int $idUsuario, string $rol, ?int $idBodega): void
    {
        $respuesta->assertOk()->assertJsonPath('meta.total', 0);

        $peticiones = $this->peticionesAlServicio();
        $this->assertCount($antes + 1, $peticiones, 'El Gateway debía reenviar exactamente una petición.');
        $peticion = $peticiones[$antes];

        $this->assertSame('GET', $peticion->method());
        $this->assertSame(self::URL_PRODUCTOS, $peticion->url());
        $this->assertSame([(string) $idUsuario], $peticion->header('X-User-Id'));
        $this->assertSame([$rol], $peticion->header('X-User-Rol'));
        $this->assertSame([$respuesta->headers->get('X-Request-Id')], $peticion->header('X-Request-Id'));
        $this->assertNotSame('id-del-cliente', $respuesta->headers->get('X-Request-Id'));
        $this->assertFalse($peticion->hasHeader('Authorization'), 'El token no debe llegar al servicio.');
        $this->assertFalse($peticion->hasHeader('Cookie'), 'Las cookies del cliente no deben llegar al servicio.');

        if ($idBodega === null) {
            $this->assertFalse($peticion->hasHeader('X-User-Bodega'), 'Solo el operador de bodega lleva X-User-Bodega.');
        } else {
            $this->assertSame([(string) $idBodega], $peticion->header('X-User-Bodega'));
        }
    }

    private function idDelRol(string $tokenAdmin, string $nombre): int
    {
        $roles = collect($this->comoPortador($tokenAdmin, 'GET', '/api/roles')->assertOk()->json('datos'));
        $id = $roles->firstWhere('nombre', $nombre)['id_rol'] ?? null;
        $this->assertIsInt($id, "No existe el rol {$nombre}.");

        return $id;
    }

    /** El administrador sembrado entra, cambia su contraseña temporal y deja listo su token. @return array{string, int} */
    private function administradorListo(): array
    {
        $login = $this->postJson('/api/auth/login', ['correo' => self::CORREO_ADMIN, 'contrasena' => self::TEMPORAL_ADMIN])
            ->assertOk()
            ->assertJsonPath('usuario.rol', 'ADMINISTRADOR')
            ->assertJsonPath('usuario.debe_cambiar_contrasena', true);
        $token = $login->json('token');
        $idAdmin = $login->json('usuario.id_usuario');
        $this->assertIsInt($idAdmin);

        // Con el cambio pendiente no se reenvía nada; el mismo token sirve después de cambiarla.
        $this->comoPortador($token, 'GET', '/api/productos')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
        $this->assertSame([], $this->peticionesAlServicio());
        $this->cambiarContrasena($token, self::TEMPORAL_ADMIN, self::NUEVA_ADMIN);

        return [$token, $idAdmin];
    }

    /** El administrador crea el operador de la bodega 7, que entra y cambia su temporal. @return array{string, int} */
    private function operadorListo(string $tokenAdmin): array
    {
        $idOperador = $this->comoPortador($tokenAdmin, 'POST', '/api/usuarios', [
            'nombre' => 'Olga Operadora',
            'correo' => self::CORREO_OPERADOR,
            'id_rol' => $this->idDelRol($tokenAdmin, 'OPERADOR_BODEGA'),
            'id_bodega' => 7,
            'contrasena_temporal' => self::TEMPORAL_OPERADOR,
        ])->assertStatus(201)->assertJsonPath('rol', 'OPERADOR_BODEGA')->json('id_usuario');
        $this->assertIsInt($idOperador);

        $token = $this->iniciarSesion(self::CORREO_OPERADOR, self::TEMPORAL_OPERADOR);
        $this->cambiarContrasena($token, self::TEMPORAL_OPERADOR, self::NUEVA_OPERADOR);

        return [$token, $idOperador];
    }

    public function test_a_el_administrador_sembrado_entra_y_su_peticion_llega_al_servicio_con_su_identidad(): void
    {
        [$token, $idAdmin] = $this->administradorListo();

        $this->assertReenviadoCon($this->comoPortador($token, 'GET', '/api/productos'), 0, $idAdmin, 'ADMINISTRADOR', null);

        // La contraseña nueva es la que vale desde ahora.
        $this->postJson('/api/auth/login', ['correo' => self::CORREO_ADMIN, 'contrasena' => self::TEMPORAL_ADMIN])->assertStatus(401);
        $this->iniciarSesion(self::CORREO_ADMIN, self::NUEVA_ADMIN);
    }

    public function test_b_el_operador_creado_por_la_api_envia_su_bodega_y_no_puede_salir_de_su_rol(): void
    {
        [$tokenAdmin] = $this->administradorListo();
        [$token, $idOperador] = $this->operadorListo($tokenAdmin);

        $this->assertReenviadoCon($this->comoPortador($token, 'GET', '/api/productos'), 0, $idOperador, 'OPERADOR_BODEGA', 7);

        // Lo que su rol no permite es 403 y el servicio no recibe nada.
        $this->comoPortador($token, 'POST', '/api/productos', ['nombre' => 'Clavos'])->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');
        $this->comoPortador($token, 'GET', '/api/usuarios')->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');
        $this->assertCount(1, $this->peticionesAlServicio());
    }

    public function test_c_un_cambio_de_rol_por_la_api_se_refleja_con_el_mismo_token(): void
    {
        [$tokenAdmin] = $this->administradorListo();
        [$token, $idOperador] = $this->operadorListo($tokenAdmin);
        $this->assertReenviadoCon($this->comoPortador($token, 'GET', '/api/productos'), 0, $idOperador, 'OPERADOR_BODEGA', 7);

        $this->comoPortador($tokenAdmin, 'PUT', "/api/usuarios/{$idOperador}", [
            'nombre' => 'Olga Vendedora',
            'correo' => self::CORREO_OPERADOR,
            'id_rol' => $this->idDelRol($tokenAdmin, 'VENDEDOR'),
            'id_bodega' => null,
        ])->assertOk()->assertJsonPath('rol', 'VENDEDOR');

        // El mismo token, sin volver a iniciar sesión: el rol sale de la base, no de las claims.
        $this->assertReenviadoCon($this->comoPortador($token, 'GET', '/api/productos'), 1, $idOperador, 'VENDEDOR', null);
    }

    public function test_d_tras_inactivar_al_usuario_su_token_deja_de_servir(): void
    {
        [$tokenAdmin] = $this->administradorListo();
        [$token, $idOperador] = $this->operadorListo($tokenAdmin);
        $this->assertReenviadoCon($this->comoPortador($token, 'GET', '/api/productos'), 0, $idOperador, 'OPERADOR_BODEGA', 7);

        $this->comoPortador($tokenAdmin, 'POST', "/api/usuarios/{$idOperador}/inactivar")->assertOk()->assertJsonPath('activo', false);

        $this->comoPortador($token, 'GET', '/api/productos')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        $this->assertCount(1, $this->peticionesAlServicio(), 'Un token de usuario inactivo no debe llegar al servicio.');
    }

    public function test_e_restablecer_la_contrasena_revoca_la_sesion_anterior_y_la_nueva_llega_al_servicio(): void
    {
        [$tokenAdmin] = $this->administradorListo();
        [$token, $idOperador] = $this->operadorListo($tokenAdmin);
        $this->assertReenviadoCon($this->comoPortador($token, 'GET', '/api/productos'), 0, $idOperador, 'OPERADOR_BODEGA', 7);

        // La revocación se mide en segundos: se deja pasar un rato para que el token anterior sea anterior de verdad.
        $this->travel(5)->seconds();
        $this->comoPortador($tokenAdmin, 'POST', "/api/usuarios/{$idOperador}/restablecer-contrasena", ['contrasena_temporal' => 'Reinicio456'])
            ->assertNoContent();

        // El token anterior (el que habría robado un atacante) ya no llega al servicio.
        $this->comoPortador($token, 'GET', '/api/productos')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        $this->assertCount(1, $this->peticionesAlServicio(), 'Un token revocado no debe llegar al servicio.');

        // La sesión nueva, con la temporal, no llega al servicio hasta que el usuario cambie la contraseña...
        $this->travel(5)->seconds();
        $nuevo = $this->iniciarSesion(self::CORREO_OPERADOR, 'Reinicio456');
        $this->comoPortador($nuevo, 'GET', '/api/productos')->assertStatus(403)->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');
        $this->cambiarContrasena($nuevo, 'Reinicio456', self::NUEVA_OPERADOR);

        // ... y después sí, con su identidad. El token anterior sigue muerto: cambiar la contraseña no lo revive.
        $this->assertReenviadoCon($this->comoPortador($nuevo, 'GET', '/api/productos'), 1, $idOperador, 'OPERADOR_BODEGA', 7);
        $this->comoPortador($token, 'GET', '/api/productos')->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        $this->assertCount(2, $this->peticionesAlServicio());
    }
}
