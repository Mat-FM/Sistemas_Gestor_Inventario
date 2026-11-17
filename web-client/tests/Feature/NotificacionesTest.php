<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class NotificacionesTest extends TestCase
{
    private function alerta(array $campos = []): array
    {
        return $campos + ['id_notificacion' => 3, 'tipo' => 'STOCK_BAJO', 'mensaje' => 'Stock bajo del producto 1 tras un movimiento en la bodega 1: quedan 74 unidades en total y el mínimo es 80.',
            'id_producto' => 1, 'id_bodega' => 1, 'rol_destinatario' => 'ADMINISTRADOR', 'leida' => false, 'correo_enviado' => false, 'fecha' => '2026-11-17T03:30:00.000000Z'];
    }

    private function gatewayDeAlertas(array $mas = []): void
    {
        $this->fingirGateway($mas + [
            'GET notificaciones' => self::listado([$this->alerta(), $this->alerta(['id_notificacion' => 2, 'tipo' => 'ORDEN_RECIBIDA', 'mensaje' => 'La orden OC-0001 se recibió completa.', 'id_producto' => null, 'leida' => true])]),
            'GET productos/1' => self::producto(1, 'Café molido 500 g'),
            'GET bodegas' => self::bodegas(),
        ]);
    }

    public function test_las_alertas_hablan_de_productos_y_bodegas_por_su_nombre(): void
    {
        $this->gatewayDeAlertas();

        $this->conSesion('ADMINISTRADOR')->get('/notificaciones')->assertOk()
            ->assertSee('Stock bajo del producto «Café molido 500 g» tras un movimiento en la bodega «Bodega Centro»')
            ->assertSee('Poco stock')->assertSee('Marcar leída')->assertSee('Orden recibida');
    }

    public function test_las_alertas_ya_leidas_no_ofrecen_marcarlas_otra_vez(): void
    {
        $this->gatewayDeAlertas(['GET notificaciones' => self::listado([$this->alerta(['leida' => true])])]);

        $this->conSesion('ADMINISTRADOR')->get('/notificaciones?ver=todas')->assertOk()->assertDontSee('Marcar leída');
    }

    public function test_por_defecto_se_piden_solo_las_sin_leer_y_los_filtros_viajan_al_servicio(): void
    {
        $this->gatewayDeAlertas();

        $this->conSesion('ADMINISTRADOR')->get('/notificaciones?tipo=VENCIMIENTO');
        $this->assertTrue($this->seEnvio('GET', 'notificaciones', fn (Request $p) => str_contains($p->url(), 'leida=false') && str_contains($p->url(), 'tipo=VENCIMIENTO')));

        $this->conSesion('ADMINISTRADOR')->get('/notificaciones?ver=todas');
        $this->assertTrue($this->seEnvio('GET', 'notificaciones', fn (Request $p) => ! str_contains($p->url(), 'leida=')));
    }

    public function test_todos_los_roles_ven_sus_alertas_sin_error(): void
    {
        $this->gatewayDeAlertas(['GET notificaciones' => self::listado([])]);

        foreach (['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'] as $rol) {
            $this->conSesion($rol, 1)->get('/notificaciones')->assertOk()->assertSee('No tienes alertas sin leer');
        }
    }

    public function test_marcar_una_alerta_como_leida_actualiza_la_campana_y_una_ya_inexistente_no_da_error(): void
    {
        $this->gatewayDeAlertas(['POST notificaciones/3/leida' => Http::response($this->alerta(['leida' => true]))]);
        cache()->put('alertas.sin_leer.7', 5, 30);

        $this->conSesion('ADMINISTRADOR')->post('/notificaciones/3/leida')->assertRedirect();
        $this->assertNull(cache()->get('alertas.sin_leer.7'));

        $this->gatewayDeAlertas(['POST notificaciones/9/leida' => self::error(404, 'NO_ENCONTRADO')]);
        $this->conSesion('ADMINISTRADOR')->post('/notificaciones/9/leida')->assertRedirect();
    }

    public function test_si_el_servicio_de_alertas_falla_la_pantalla_lo_dice(): void
    {
        $this->gatewayDeAlertas(['GET notificaciones' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->get('/notificaciones')->assertOk()->assertSee('No pudimos cargar las alertas');
    }

    // ---------- La campana ----------

    public function test_la_campana_muestra_cuantas_alertas_hay_sin_leer_y_se_guarda_30_segundos(): void
    {
        $this->gatewayDeAlertas(['GET notificaciones' => self::listado([$this->alerta()], 12)]);

        $this->conSesion('ADMINISTRADOR')->get('/stock')->assertOk()->assertSee('aria-label="Alertas (12 sin leer)"', false);
        $this->conSesion('ADMINISTRADOR')->get('/stock');
        $this->assertCount(1, Http::recorded(fn (Request $p) => str_contains($p->url(), '/api/notificaciones')), 'la segunda pantalla usó el valor guardado');
    }

    public function test_si_las_alertas_no_responden_la_pantalla_se_muestra_igual_sin_numero(): void
    {
        $this->fingirGateway(['GET notificaciones' => self::error(503, 'SERVICIO_NO_DISPONIBLE'), 'GET saldos' => self::listado([]), 'GET bodegas' => self::bodegas()]);

        $this->conSesion('VENDEDOR')->get('/stock')->assertOk()->assertSee('aria-label="Alertas"', false)->assertDontSee('sin leer)');
    }

    public function test_la_campana_no_pregunta_nada_mientras_hay_que_cambiar_la_contrasena(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('VENDEDOR', null, true)->get('/contrasena')->assertOk();
        $this->assertCount(0, Http::recorded());
    }

    // ---------- Preferencia de correo ----------

    public function test_la_preferencia_de_correo_se_muestra_y_se_guarda(): void
    {
        $this->fingirGateway([
            'GET preferencias/mia' => Http::response(['id_usuario' => 7, 'rol' => 'VENDEDOR', 'correo' => 'ana@x.co', 'recibir_correo' => true]),
            'PUT preferencias/mia' => Http::response(['id_usuario' => 7, 'rol' => 'VENDEDOR', 'correo' => 'luis@x.co', 'recibir_correo' => true]),
        ]);

        $this->conSesion('VENDEDOR')->get('/preferencias')->assertOk()->assertSee('value="ana@x.co"', false)->assertSee('checked', false);
        $this->conSesion('VENDEDOR')->put('/preferencias', ['recibir_correo' => '1', 'correo' => ' Luis@X.co '])->assertRedirect('/preferencias')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('PUT', 'preferencias/mia', fn (Request $p) => $p->data() === ['recibir_correo' => true, 'correo' => 'luis@x.co']));
    }

    public function test_para_recibir_correo_hay_que_escribir_uno_valido_y_apagarlo_no_lo_exige(): void
    {
        $this->fingirGateway(['PUT preferencias/mia' => Http::response(['id_usuario' => 7, 'rol' => 'VENDEDOR', 'correo' => null, 'recibir_correo' => false])]);

        $this->conSesion('VENDEDOR')->from('/preferencias')->put('/preferencias', ['recibir_correo' => '1', 'correo' => ''])
            ->assertSessionHasErrors(['correo' => 'Escribe el correo al que quieres recibir las alertas.']);
        $this->conSesion('VENDEDOR')->from('/preferencias')->put('/preferencias', ['recibir_correo' => '1', 'correo' => 'no es correo'])
            ->assertSessionHasErrors('correo');
        $this->assertFalse($this->seEnvio('PUT', 'preferencias/mia'));

        $this->conSesion('VENDEDOR')->put('/preferencias', ['recibir_correo' => '0', 'correo' => ''])->assertRedirect('/preferencias');
        $this->assertTrue($this->seEnvio('PUT', 'preferencias/mia', fn (Request $p) => $p->data() === ['recibir_correo' => false, 'correo' => null]));
    }

    // ---------- Configuración de las alertas (administrador) ----------

    public function test_el_administrador_configura_los_dias_y_la_hora_de_la_revision(): void
    {
        $this->fingirGateway([
            'GET configuracion-alertas' => Http::response(['dias_anticipacion_vencimiento' => 30, 'hora_revision_diaria' => '06:00']),
            'PUT configuracion-alertas' => Http::response(['dias_anticipacion_vencimiento' => 60, 'hora_revision_diaria' => '07:30']),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/administrar/alertas')->assertOk()->assertSee('value="30"', false)->assertSee('value="06:00"', false);
        $this->conSesion('ADMINISTRADOR')->put('/administrar/alertas', ['dias_anticipacion_vencimiento' => '60', 'hora_revision_diaria' => '07:30'])->assertRedirect('/administrar/alertas')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('PUT', 'configuracion-alertas', fn (Request $p) => $p->data() === ['dias_anticipacion_vencimiento' => 60, 'hora_revision_diaria' => '07:30']));
    }

    public function test_la_configuracion_valida_dias_y_hora_en_espanol_y_es_solo_del_administrador(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('ADMINISTRADOR')->from('/administrar/alertas')->put('/administrar/alertas', ['dias_anticipacion_vencimiento' => '400', 'hora_revision_diaria' => '25:99'])
            ->assertSessionHasErrors(['dias_anticipacion_vencimiento' => 'El máximo son 365 días.', 'hora_revision_diaria' => 'La hora debe tener el formato 06:00.']);
        $this->assertFalse($this->seEnvio('PUT', 'configuracion-alertas'));

        foreach (['OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'] as $rol) {
            $this->conSesion($rol, 1)->get('/administrar/alertas')->assertForbidden();
            $this->conSesion($rol, 1)->put('/administrar/alertas', ['dias_anticipacion_vencimiento' => '30', 'hora_revision_diaria' => '06:00'])->assertForbidden();
        }
    }
}
