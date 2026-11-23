<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class TrasladosTest extends TestCase
{
    private function traslado(int $id, int $origen, int $destino, string $estado = 'EN_TRANSITO'): array
    {
        return ['id_traslado' => $id, 'id_producto' => 1, 'id_bodega_origen' => $origen, 'id_bodega_destino' => $destino, 'cantidad' => 12,
            'estado' => $estado, 'fecha_envio' => '2026-11-16T15:00:00Z', 'fecha_recepcion' => null];
    }

    private function gatewayBase(array $mas = []): void
    {
        $this->fingirGateway($mas + ['GET productos/1' => self::producto(1, 'Café molido 500 g'), 'GET bodegas' => self::bodegas()]);
    }

    public function test_solo_se_ofrece_recibir_en_la_bodega_de_destino(): void
    {
        $this->gatewayBase(['GET traslados' => self::listado([$this->traslado(5, 2, 1), $this->traslado(6, 1, 2)])]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/traslados')->assertOk()
            ->assertSee(route('traslados.recibir', 5))->assertDontSee(route('traslados.recibir', 6))->assertSee('En camino');
    }

    public function test_el_administrador_puede_recibir_en_cualquier_bodega(): void
    {
        $this->gatewayBase(['GET traslados' => self::listado([$this->traslado(5, 2, 1), $this->traslado(6, 1, 2)])]);

        $this->conSesion('ADMINISTRADOR')->get('/traslados')->assertSee(route('traslados.recibir', 5))->assertSee(route('traslados.recibir', 6));
    }

    public function test_recibir_envia_la_clave_y_confirma(): void
    {
        $this->gatewayBase(['POST traslados/5/recepcion' => Http::response(['id_traslado' => 5, 'estado' => 'RECIBIDO'])]);

        $this->conSesion('OPERADOR_BODEGA', 1)->post('/traslados/5/recepcion', ['clave' => 'rec-1'])
            ->assertRedirect('/traslados')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('POST', 'traslados/5/recepcion', fn (Request $p) => $p->header('Idempotency-Key') === ['rec-1'] && $p->body() === '{}'));
    }

    public function test_recibir_dos_veces_un_traslado_ya_recibido_no_es_un_error_para_el_usuario(): void
    {
        $this->gatewayBase(['POST traslados/5/recepcion' => self::error(409, 'TRASLADO_YA_RECIBIDO')]);

        $this->conSesion('OPERADOR_BODEGA', 1)->post('/traslados/5/recepcion', ['clave' => 'rec-2'])
            ->assertRedirect('/traslados')->assertSessionHas('aviso', 'Ese traslado ya se había recibido.');
    }

    public function test_si_el_gateway_no_responde_al_recibir_se_pide_revisar_antes_de_repetir(): void
    {
        $this->gatewayBase(['POST traslados/5/recepcion' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('OPERADOR_BODEGA', 1)->from('/traslados')->post('/traslados/5/recepcion', ['clave' => 'rec-3'])
            ->assertSessionHas('error');
    }

    public function test_crear_un_traslado_como_operador_sale_de_su_bodega_y_envia_la_clave(): void
    {
        $this->gatewayBase(['POST traslados' => Http::response(['id_traslado' => 8, 'estado' => 'EN_TRANSITO'], 201)]);

        $this->conSesion('OPERADOR_BODEGA', 1)->post('/traslados', [
            'id_producto' => 1, 'id_bodega_origen' => 2, 'id_bodega_destino' => 2, 'cantidad' => '12', 'clave' => 'tras-1',
        ])->assertRedirect('/traslados');

        $this->assertTrue($this->seEnvio('POST', 'traslados', fn (Request $p) => $p->header('Idempotency-Key') === ['tras-1']
            && $p->data() === ['id_producto' => 1, 'id_bodega_origen' => 1, 'id_bodega_destino' => 2, 'cantidad' => 12]));
    }

    public function test_el_destino_debe_ser_otra_bodega(): void
    {
        $this->gatewayBase([]);

        $this->conSesion('ADMINISTRADOR')->from('/x')->post('/traslados', [
            'id_producto' => 1, 'id_bodega_origen' => 1, 'id_bodega_destino' => 1, 'cantidad' => '3', 'clave' => 'tras-2',
        ])->assertSessionHasErrors('id_bodega_destino');
        $this->assertFalse($this->seEnvio('POST', 'traslados'));
    }

    public function test_el_formulario_de_traslado_del_operador_no_deja_elegir_el_origen(): void
    {
        $this->gatewayBase([
            'GET saldos' => self::listado([['id_saldo' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad_disponible' => 40]]),
            'GET lotes' => self::listado([]),
        ]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/traslados/nuevo?id_producto=1')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('Sale de')->assertSee('disabled', false)
            ->assertDontSee('Cambiar la bodega de origen');
    }

    /** Saldo de 100 en la bodega 1: 50 + 30 en lotes, un lote agotado y 20 sin lote. */
    private function gatewayConLotes(array $mas = []): void
    {
        $this->gatewayBase($mas + [
            'GET saldos' => self::listado([['id_saldo' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad_disponible' => 100]]),
            'GET lotes' => self::listado([
                ['id_lote' => 7, 'id_producto' => 1, 'id_bodega' => 1, 'codigo_lote' => 'L-TARDE', 'fecha_vencimiento' => '2027-06-30', 'cantidad_disponible' => 30],
                ['id_lote' => 8, 'id_producto' => 1, 'id_bodega' => 1, 'codigo_lote' => 'L-PRONTO', 'fecha_vencimiento' => '2027-01-15', 'cantidad_disponible' => 50],
                ['id_lote' => 9, 'id_producto' => 1, 'id_bodega' => 1, 'codigo_lote' => 'L-AGOTADO', 'fecha_vencimiento' => '2026-12-01', 'cantidad_disponible' => 0],
            ]),
        ]);
    }

    public function test_el_formulario_ofrece_los_lotes_del_origen_primero_el_que_vence_antes_y_el_stock_sin_lote(): void
    {
        $this->gatewayConLotes();

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/traslados/nuevo?id_producto=1')->assertOk()
            ->assertSee('¿De qué lote?')
            ->assertSeeInOrder(['Lote L-PRONTO', '50 disponibles', 'Lote L-TARDE', '30 disponibles', 'Sin lote · 20 disponibles'])
            ->assertSee('<option value="8" selected', false)
            ->assertDontSee('L-AGOTADO');
        $this->assertTrue($this->seEnvio('GET', 'lotes', fn (Request $p) => str_contains($p->url(), 'id_producto=1') && str_contains($p->url(), 'id_bodega=1')));
    }

    public function test_el_administrador_elige_primero_la_bodega_de_origen_y_luego_ve_sus_lotes(): void
    {
        $this->gatewayConLotes();

        $this->conSesion('ADMINISTRADOR')->get('/traslados/nuevo?id_producto=1')->assertOk()
            ->assertSee('¿De qué bodega sale?')->assertSee('id_bodega_origen=1', false)->assertDontSee('¿De qué lote?');
        $this->assertFalse($this->seEnvio('GET', 'lotes'));

        $this->conSesion('ADMINISTRADOR')->get('/traslados/nuevo?id_producto=1&id_bodega_origen=1')->assertOk()
            ->assertSee('¿De qué lote?')->assertSee('Lote L-PRONTO')->assertSee('Cambiar la bodega de origen')
            ->assertSee('<input type="hidden" name="id_bodega_origen" value="1">', false);
    }

    public function test_sin_existencias_en_el_origen_se_dice_en_lugar_de_ofrecer_lotes(): void
    {
        $this->gatewayBase(['GET saldos' => self::listado([]), 'GET lotes' => self::listado([])]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/traslados/nuevo?id_producto=1')->assertOk()
            ->assertSee('No hay existencias de este producto en esta bodega.');
    }

    public function test_el_traslado_envia_el_lote_elegido_y_sin_lote_no_lo_envia(): void
    {
        $this->gatewayBase(['POST traslados' => Http::response(['id_traslado' => 9, 'estado' => 'EN_TRANSITO'], 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/traslados', [
            'id_producto' => 1, 'id_bodega_origen' => 1, 'id_bodega_destino' => 2, 'cantidad' => '20', 'id_lote' => '8', 'clave' => 'tras-lote',
        ])->assertRedirect('/traslados');
        $this->assertTrue($this->seEnvio('POST', 'traslados', fn (Request $p) => $p->header('Idempotency-Key') === ['tras-lote']
            && $p->data() === ['id_producto' => 1, 'id_bodega_origen' => 1, 'id_bodega_destino' => 2, 'cantidad' => 20, 'id_lote' => 8]));

        $this->conSesion('ADMINISTRADOR')->post('/traslados', [
            'id_producto' => 1, 'id_bodega_origen' => 1, 'id_bodega_destino' => 2, 'cantidad' => '5', 'id_lote' => '', 'clave' => 'tras-sin-lote',
        ])->assertRedirect('/traslados');
        $this->assertTrue($this->seEnvio('POST', 'traslados', fn (Request $p) => $p->header('Idempotency-Key') === ['tras-sin-lote']
            && ! array_key_exists('id_lote', $p->data())));
    }
}
