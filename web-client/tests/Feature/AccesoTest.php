<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class AccesoTest extends TestCase
{
    private function loginExitoso(array $usuario = []): void
    {
        $this->fingirGateway(['POST auth/login' => Http::response([
            'token' => self::TOKEN,
            'expira_en' => 3600,
            'usuario' => $usuario + ['id_usuario' => 7, 'nombre' => 'Ana María Pérez', 'rol' => 'VENDEDOR', 'id_bodega' => null, 'debe_cambiar_contrasena' => false],
        ])]);
    }

    public function test_sin_sesion_todo_lleva_al_inicio_de_sesion(): void
    {
        foreach (['/', '/stock', '/movimientos', '/traslados'] as $ruta) {
            $this->get($ruta)->assertRedirect('/login');
        }
    }

    public function test_el_inicio_de_sesion_guarda_el_token_en_el_servidor_y_nunca_lo_muestra(): void
    {
        $this->loginExitoso(); // el inicio del vendedor no pide más datos al Gateway

        $respuesta = $this->post('/login', ['correo' => 'ana@elmontanero.test', 'contrasena' => 'Clave12345'])->assertRedirect('/');
        $this->assertStringNotContainsString(self::TOKEN, $this->get('/')->getContent());
        $this->assertStringNotContainsString(self::TOKEN, $respuesta->getContent());
        $this->assertSame(self::TOKEN, session('gateway.token'));

        $this->assertTrue($this->seEnvio('POST', 'auth/login', fn ($p) => ! $p->hasHeader('Authorization') && $p['correo'] === 'ana@elmontanero.test'));
    }

    public function test_iniciar_sesion_borra_la_cookie_de_la_sesion_anterior(): void
    {
        // Con el driver de producción (cookie), los datos de cada sesión van en una cookie cuyo nombre es el id de la sesión.
        // Si al iniciar sesión la anterior no se destruye, su cookie queda en el navegador: tras varios inicios de sesión la
        // cabecera Cookie supera el límite de Apache (8190 bytes) y todo responde 400 Bad Request.
        config(['session.driver' => 'cookie']);
        $this->loginExitoso();

        $formulario = $this->get('/login')->assertOk();
        $nombre = config('session.cookie');
        $idAnterior = $formulario->getCookie($nombre)->getValue();

        $respuesta = $this->withCookie($nombre, $idAnterior)
            ->withCookie($idAnterior, $formulario->getCookie($idAnterior)->getValue())
            ->post('/login', ['correo' => 'ana@elmontanero.test', 'contrasena' => 'Clave12345'])
            ->assertRedirect('/');

        $respuesta->assertCookieExpired($idAnterior);
        $this->assertNotSame($idAnterior, $respuesta->getCookie($nombre)->getValue());
    }

    public function test_una_contrasena_temporal_obliga_a_cambiarla_antes_de_seguir(): void
    {
        $this->loginExitoso(['debe_cambiar_contrasena' => true]);

        $this->post('/login', ['correo' => 'ana@elmontanero.test', 'contrasena' => 'Temporal123'])->assertRedirect('/contrasena');
        $this->get('/stock')->assertRedirect('/contrasena');
        $this->get('/contrasena')->assertOk()->assertSee('Elige tu contraseña');
    }

    public function test_credenciales_incorrectas_no_dicen_cual_fallo(): void
    {
        $this->fingirGateway(['POST auth/login' => self::error(401, 'CREDENCIALES_INVALIDAS', 'Correo o contraseña incorrectos.')]);

        $this->from('/login')->post('/login', ['correo' => 'ana@elmontanero.test', 'contrasena' => 'mala'])
            ->assertRedirect('/login')->assertSessionHasErrors(['correo' => 'Correo o contraseña incorrectos.']);
        $this->assertNull(session('gateway.token'));
    }

    public function test_demasiados_intentos_muestran_cuanto_esperar(): void
    {
        $this->fingirGateway(['POST auth/login' => self::error(429, 'DEMASIADAS_PETICIONES', '', [], ['Retry-After' => '42'])]);

        $this->from('/login')->post('/login', ['correo' => 'ana@elmontanero.test', 'contrasena' => 'x'])
            ->assertSessionHasErrors(['correo' => 'Demasiados intentos. Espera 42 segundos.']);
    }

    public function test_si_el_gateway_no_responde_el_inicio_de_sesion_lo_dice_sin_culpar_al_usuario(): void
    {
        $this->fingirGateway(['POST auth/login' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->from('/login')->post('/login', ['correo' => 'ana@elmontanero.test', 'contrasena' => 'x'])
            ->assertSessionHasErrors(['correo' => 'El sistema no está disponible por ahora. Intenta de nuevo en unos minutos.']);
    }

    public function test_un_401_del_gateway_en_cualquier_pantalla_cierra_la_sesion_y_vuelve_al_inicio_de_sesion(): void
    {
        $this->fingirGateway(['GET saldos' => self::error(401, 'NO_AUTENTICADO', 'Token vencido')]);

        $this->conSesion('VENDEDOR')->get('/stock')->assertRedirect('/login')->assertSessionHas('aviso', 'Tu sesión venció. Entra de nuevo.');
        $this->assertNull(session('gateway.token'));
    }

    public function test_una_sesion_vencida_en_el_servidor_pide_entrar_otra_vez(): void
    {
        $this->withSession(['gateway.token' => self::TOKEN, 'gateway.vence' => time() - 1, 'gateway.usuario' => ['rol' => 'VENDEDOR']])
            ->get('/stock')->assertRedirect('/login');
    }

    public function test_el_gateway_que_exige_cambio_de_contrasena_lleva_a_esa_pantalla(): void
    {
        $this->fingirGateway(['GET saldos' => self::error(403, 'CAMBIO_CONTRASENA_REQUERIDO')]);

        $this->conSesion('VENDEDOR')->get('/stock')->assertRedirect('/contrasena');
    }

    public function test_un_503_del_gateway_se_explica_en_lenguaje_cotidiano(): void
    {
        $this->fingirGateway(['GET saldos' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('VENDEDOR')->get('/stock?q=')->assertOk()->assertSee('No pudimos consultar el stock');
    }

    public function test_un_exito_del_gateway_sin_json_no_se_toma_por_una_lista_vacia(): void
    {
        $this->fingirGateway(['GET saldos' => Http::response('<b>Notice</b> algo salió mal', 200)]);

        $this->conSesion('VENDEDOR')->get('/stock')->assertOk()->assertSee('No pudimos consultar el stock')->assertDontSee('Todavía no hay existencias');
    }

    public function test_cambiar_la_contrasena_valida_la_politica_antes_de_llamar_al_gateway(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('VENDEDOR')->from('/contrasena')->put('/contrasena', [
            'contrasena_actual' => 'Vieja12345', 'contrasena_nueva' => 'solo letras', 'contrasena_nueva_confirmation' => 'solo letras',
        ])->assertSessionHasErrors('contrasena_nueva');
        $this->assertFalse($this->seEnvio('PUT', 'auth/contrasena'));
    }

    public function test_las_contrasenas_escritas_no_se_guardan_en_la_sesion_cuando_la_validacion_falla(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('VENDEDOR')->from('/contrasena')->put('/contrasena', [
            'contrasena_actual' => 'Vieja12345', 'contrasena_nueva' => 'corta', 'contrasena_nueva_confirmation' => 'corta',
        ])->assertSessionHasErrors('contrasena_nueva');

        foreach (['contrasena_actual', 'contrasena_nueva', 'contrasena_nueva_confirmation'] as $campo) {
            $this->assertNull(session()->getOldInput($campo));
        }

        $this->from('/login')->post('/login', ['correo' => '', 'contrasena' => 'Secreta12345']);
        $this->assertNull(session()->getOldInput('contrasena'));
    }

    public function test_los_formularios_que_modifican_datos_cargan_el_script_que_evita_el_doble_toque(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('VENDEDOR')->get('/')->assertSee('js/app.js', false);
        $this->assertStringContainsString('formulario.dataset.enviando', file_get_contents(public_path('js/app.js')));
    }

    public function test_cambiar_la_contrasena_levanta_la_obligacion_y_lleva_al_inicio(): void
    {
        $this->fingirGateway(['PUT auth/contrasena' => Http::response('', 204)]);

        $this->conSesion('VENDEDOR', null, true)->put('/contrasena', [
            'contrasena_actual' => 'Temporal123', 'contrasena_nueva' => 'Definitiva456', 'contrasena_nueva_confirmation' => 'Definitiva456',
        ])->assertRedirect('/');

        $this->assertFalse(session('gateway.usuario')['debe_cambiar_contrasena']);
        $this->assertTrue($this->seEnvio('PUT', 'auth/contrasena', fn ($p) => $p['contrasena_actual'] === 'Temporal123' && $p['contrasena_nueva'] === 'Definitiva456'));
    }

    public function test_una_contrasena_actual_equivocada_no_se_confunde_con_una_sesion_vencida(): void
    {
        $this->fingirGateway(['PUT auth/contrasena' => self::error(401, 'CONTRASENA_ACTUAL_INCORRECTA', 'La contraseña actual es incorrecta.')]);

        $this->conSesion('VENDEDOR')->from('/contrasena')->put('/contrasena', [
            'contrasena_actual' => 'Mala12345', 'contrasena_nueva' => 'Definitiva456', 'contrasena_nueva_confirmation' => 'Definitiva456',
        ])->assertRedirect('/contrasena')->assertSessionHasErrors(['contrasena_actual' => 'La contraseña actual no es correcta.']);
        $this->assertSame(self::TOKEN, session('gateway.token'));
    }

    public function test_salir_borra_la_sesion_aunque_el_gateway_falle(): void
    {
        $this->fingirGateway(['POST auth/logout' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('VENDEDOR')->post('/salir')->assertRedirect('/login');
        $this->assertNull(session('gateway.token'));
    }

    public function test_un_rol_sin_permiso_no_ve_la_pantalla_aunque_conozca_la_direccion(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('VENDEDOR')->get('/movimientos')->assertForbidden();
        $this->conSesion('VENDEDOR')->get('/traslados')->assertForbidden();
        $this->conSesion('CONTADOR')->get('/movimientos/nuevo')->assertForbidden();
        $this->conSesion('CONTADOR')->post('/movimientos', [])->assertForbidden();
    }

    public function test_el_ejemplo_de_entorno_no_pide_base_de_datos_y_guarda_la_sesion_en_cookie(): void
    {
        $entorno = [];
        foreach (file(base_path('.env.example'), FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $linea) {
            if (! str_starts_with($linea, '#') && str_contains($linea, '=')) {
                [$clave, $valor] = explode('=', $linea, 2);
                $entorno[$clave] = $valor;
            }
        }

        $this->assertSame('cookie', $entorno['SESSION_DRIVER']);
        $this->assertSame('file', $entorno['CACHE_STORE']);
        $this->assertSame('sync', $entorno['QUEUE_CONNECTION']);
        $this->assertSame('null', $entorno['DB_CONNECTION']);
        $this->assertArrayHasKey('API_GATEWAY_URL', $entorno);
        $this->assertSame([], array_filter(array_keys($entorno), fn ($clave) => str_starts_with($clave, 'MS_')));
    }
}
