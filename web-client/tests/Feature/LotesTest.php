<?php

namespace Tests\Feature;

use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Request;
use Tests\TestCase;

class LotesTest extends TestCase
{
    private function lote(int $id, int $dias, int $cantidad = 12): array
    {
        return ['id_lote' => $id, 'id_producto' => 1, 'id_bodega' => 1, 'codigo_lote' => "L-$id",
            'fecha_vencimiento' => CarbonImmutable::now(config('interfaz.zona_horaria'))->addDays($dias)->toDateString(), 'cantidad_disponible' => $cantidad];
    }

    private function gatewayDeLotes(array $lotes): void
    {
        $this->fingirGateway(['GET lotes' => self::listado($lotes), 'GET productos/1' => self::producto(1, 'Café molido 500 g'), 'GET bodegas' => self::bodegas()]);
    }

    public function test_muestra_los_lotes_con_los_dias_que_faltan_y_marca_los_vencidos(): void
    {
        $this->gatewayDeLotes([$this->lote(1, -3), $this->lote(2, 0), $this->lote(3, 1), $this->lote(4, 12), $this->lote(5, 45)]);

        $this->conSesion('ADMINISTRADOR')->get('/lotes')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('Lote L-1 · Bodega Centro')
            ->assertSee('Vencido hace 3 días')->assertSee('Vence hoy')->assertSee('Vence en 1 día')->assertSee('Vence en 12 días')->assertSee('Vence en 45 días');
    }

    public function test_pide_al_servicio_hasta_el_dia_siguiente_al_limite_porque_el_filtro_es_estricto(): void
    {
        $this->gatewayDeLotes([]);
        $hoy = CarbonImmutable::now(config('interfaz.zona_horaria'));

        $this->conSesion('ADMINISTRADOR')->get('/lotes?dias=60&bodega=2')->assertOk()->assertSee('Ningún lote con existencia vence en los próximos 60 días');
        $this->assertTrue($this->seEnvio('GET', 'lotes', fn (Request $p) => str_contains($p->url(), 'vence_antes_de='.$hoy->addDays(61)->toDateString())
            && str_contains($p->url(), 'con_existencia=true') && str_contains($p->url(), 'id_bodega=2')));

        $this->conSesion('ADMINISTRADOR')->get('/lotes?dias=9999');
        $this->assertTrue($this->seEnvio('GET', 'lotes', fn (Request $p) => str_contains($p->url(), 'vence_antes_de='.$hoy->addDays(31)->toDateString())), 'un valor no permitido vuelve a 30 días');
    }

    public function test_el_operador_solo_ve_su_bodega_y_sin_bodega_recibe_una_explicacion(): void
    {
        $this->gatewayDeLotes([$this->lote(1, 5)]);

        $this->conSesion('OPERADOR_BODEGA', 2)->get('/lotes?bodega=1')->assertOk()->assertDontSee('Todas las bodegas');
        $this->assertTrue($this->seEnvio('GET', 'lotes', fn (Request $p) => str_contains($p->url(), 'id_bodega=2') && ! str_contains($p->url(), 'id_bodega=1')));

        $this->conSesion('OPERADOR_BODEGA', null)->get('/lotes')->assertOk()->assertSee('Todavía no tienes una bodega');
    }

    public function test_vendedor_y_contador_no_ven_los_lotes(): void
    {
        $this->gatewayDeLotes([]);

        $this->conSesion('VENDEDOR')->get('/lotes')->assertForbidden();
        $this->conSesion('CONTADOR')->get('/lotes')->assertForbidden();
    }

    public function test_si_el_servicio_falla_la_pantalla_lo_dice_y_stock_enlaza_a_los_lotes(): void
    {
        $this->fingirGateway(['GET lotes' => self::error(503, 'SERVICIO_NO_DISPONIBLE'), 'GET bodegas' => self::bodegas(), 'GET saldos' => self::listado([])]);

        $this->conSesion('ADMINISTRADOR')->get('/lotes')->assertOk()->assertSee('No pudimos consultar los lotes');
        $this->conSesion('OPERADOR_BODEGA', 1)->get('/stock')->assertOk()->assertSee(route('lotes.index'));
        $this->conSesion('VENDEDOR')->get('/stock')->assertOk()->assertDontSee(route('lotes.index'));
    }
}
