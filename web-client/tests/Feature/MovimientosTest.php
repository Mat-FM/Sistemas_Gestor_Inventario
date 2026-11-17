<?php

namespace Tests\Feature;

use GuzzleHttp\Promise\PromiseInterface;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class MovimientosTest extends TestCase
{
    private const FORMULARIO = ['tipo' => 'SALIDA', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => '3', 'clave' => 'clave-del-formulario-1'];

    private function creado(array $campos = []): PromiseInterface
    {
        return Http::response($campos + ['id_movimiento' => 10, 'tipo' => 'SALIDA', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => 3, 'saldo_resultante' => 36], 201);
    }

    private function gatewayBase(array $mas = []): void
    {
        $this->fingirGateway($mas + ['GET productos/1' => self::producto(1, 'Café molido 500 g'), 'GET bodegas' => self::bodegas()]);
    }

    public function test_guardar_una_salida_envia_la_clave_de_idempotencia_y_confirma_con_un_mensaje_claro(): void
    {
        $this->gatewayBase(['POST movimientos' => $this->creado()]);

        $this->conSesion('ADMINISTRADOR')->post('/movimientos', self::FORMULARIO)
            ->assertRedirect('/movimientos')
            ->assertSessionHas('exito', 'Salida registrada: 3 × Café molido 500 g en Bodega Centro. Ahora hay 36.');

        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p->header('Idempotency-Key') === ['clave-del-formulario-1']
            && $p->header('Authorization') === ['Bearer '.self::TOKEN]
            && $p->data() === ['tipo' => 'SALIDA', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => 3]));
    }

    public function test_la_cantidad_admite_espacios_y_puntos_de_miles_pero_no_decimales(): void
    {
        $this->gatewayBase(['POST movimientos' => $this->creado(['cantidad' => 1200])]);

        $this->conSesion('ADMINISTRADOR')->post('/movimientos', ['cantidad' => '1.200'] + self::FORMULARIO)->assertRedirect('/movimientos');
        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p['cantidad'] === 1200));

        $this->conSesion('ADMINISTRADOR')->from('/movimientos/nuevo')->post('/movimientos', ['cantidad' => '2,5'] + self::FORMULARIO)
            ->assertSessionHasErrors(['cantidad' => 'La cantidad debe ser un número entero, sin decimales.']);
    }

    public function test_una_entrada_con_lote_envia_el_lote_con_su_vencimiento_y_exige_los_dos_datos(): void
    {
        $this->gatewayBase(['POST movimientos' => $this->creado(['tipo' => 'ENTRADA', 'cantidad' => 10])]);
        $entrada = ['tipo' => 'ENTRADA', 'cantidad' => '10'] + self::FORMULARIO;

        $this->conSesion('ADMINISTRADOR')->post('/movimientos', $entrada + ['codigo_lote' => 'L-9', 'fecha_vencimiento' => '2027-03-01'])->assertRedirect('/movimientos');
        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p['lote'] === ['codigo_lote' => 'L-9', 'fecha_vencimiento' => '2027-03-01']));

        $this->conSesion('ADMINISTRADOR')->from('/x')->post('/movimientos', $entrada + ['codigo_lote' => 'L-9'])->assertSessionHasErrors('fecha_vencimiento');
    }

    public function test_el_operador_solo_mueve_su_bodega_aunque_el_formulario_diga_otra(): void
    {
        $this->gatewayBase(['POST movimientos' => $this->creado()]);

        $this->conSesion('OPERADOR_BODEGA', 2)->post('/movimientos', ['id_bodega' => 1] + self::FORMULARIO)->assertRedirect('/movimientos');
        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p['id_bodega'] === 2));
    }

    public function test_solo_se_pueden_registrar_los_tipos_que_tienen_pantalla(): void
    {
        $this->gatewayBase([]);

        foreach (['ENTRADA_COMPRA', 'TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL', 'DEVOLUCION_PROVEEDOR'] as $tipo) {
            $this->conSesion('ADMINISTRADOR')->from('/x')->post('/movimientos', ['tipo' => $tipo] + self::FORMULARIO)->assertSessionHasErrors('tipo');
        }
        $this->assertFalse($this->seEnvio('POST', 'movimientos'));
    }

    public function test_una_devolucion_de_cliente_suma_stock_y_su_motivo_es_opcional(): void
    {
        $this->gatewayBase(['POST movimientos' => $this->creado(['tipo' => 'DEVOLUCION_CLIENTE', 'cantidad' => 2, 'saldo_resultante' => 41])]);

        $this->conSesion('OPERADOR_BODEGA', 1)->post('/movimientos', ['tipo' => 'DEVOLUCION_CLIENTE', 'cantidad' => '2', 'observacion' => 'Llegó dañado'] + self::FORMULARIO)
            ->assertRedirect('/movimientos')->assertSessionHas('exito', 'Devolución de cliente registrada: 2 × Café molido 500 g en Bodega Centro. Ahora hay 41.');
        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p['tipo'] === 'DEVOLUCION_CLIENTE' && $p['cantidad'] === 2 && $p['observacion'] === 'Llegó dañado' && ! isset($p['lote'])));
    }

    public function test_un_ajuste_lleva_el_signo_y_exige_motivo_y_sentido(): void
    {
        $this->gatewayBase(['POST movimientos' => $this->creado(['tipo' => 'AJUSTE', 'cantidad' => -3, 'saldo_resultante' => 33])]);
        $ajuste = ['tipo' => 'AJUSTE', 'cantidad' => '3', 'sentido' => 'baja', 'observacion' => 'Se rompieron al descargar'] + self::FORMULARIO;

        $this->conSesion('ADMINISTRADOR')->post('/movimientos', $ajuste)->assertRedirect('/movimientos')
            ->assertSessionHas('exito', 'Ajuste registrado: -3 × Café molido 500 g en Bodega Centro. Ahora hay 33.');
        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p['tipo'] === 'AJUSTE' && $p['cantidad'] === -3));

        $this->gatewayBase(['POST movimientos' => $this->creado(['tipo' => 'AJUSTE', 'cantidad' => 4, 'saldo_resultante' => 40])]);
        $this->conSesion('ADMINISTRADOR')->post('/movimientos', ['sentido' => 'sube', 'cantidad' => '4'] + $ajuste);
        $this->assertTrue($this->seEnvio('POST', 'movimientos', fn (Request $p) => $p['cantidad'] === 4));

        $this->conSesion('ADMINISTRADOR')->from('/x')->post('/movimientos', ['sentido' => '', 'observacion' => ''] + $ajuste)
            ->assertSessionHasErrors(['sentido' => 'Elige si el ajuste sube o baja el stock.', 'observacion' => 'Cuenta por qué se ajusta (por ejemplo: se encontró mercancía de más en el conteo).']);
    }

    public function test_el_formulario_ofrece_los_cuatro_tipos_y_el_de_ajuste_pide_el_sentido(): void
    {
        $this->gatewayBase(['GET saldos' => self::listado([]), 'GET lotes' => self::listado([])]);

        $this->conSesion('ADMINISTRADOR')->get('/movimientos/nuevo?tipo=AJUSTE&id_producto=1')->assertOk()
            ->assertSee('Ajustar el stock')->assertSee('Hay de más: sube')->assertSee('Hay de menos: baja')->assertSee('Motivo del ajuste')
            ->assertSee('Devolución')->assertDontSee('Tiene lote y fecha de vencimiento');
        $this->conSesion('ADMINISTRADOR')->get('/movimientos/nuevo?tipo=DEVOLUCION_CLIENTE&id_producto=1')->assertOk()->assertSee('devuelve el cliente')->assertDontSee('Hay de más');
    }

    public function test_el_historial_muestra_el_signo_de_un_ajuste_y_el_de_una_devolucion(): void
    {
        $this->gatewayBase(['GET movimientos' => self::listado([
            ['id_movimiento' => 1, 'tipo' => 'AJUSTE', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => -3, 'saldo_resultante' => 33, 'fecha' => '2026-11-16T21:00:00Z'],
            ['id_movimiento' => 2, 'tipo' => 'DEVOLUCION_CLIENTE', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => 2, 'saldo_resultante' => 36, 'fecha' => '2026-11-16T20:00:00Z'],
        ])]);

        $this->conSesion('CONTADOR')->get('/movimientos')->assertOk()->assertSee('−3')->assertSee('+2')->assertSee('Ajuste')->assertSee('Devolución de cliente');
    }

    public function test_tras_un_rechazo_definitivo_la_clave_se_descarta_para_que_el_formulario_genere_otra(): void
    {
        $this->gatewayBase(['POST movimientos' => self::error(409, 'STOCK_INSUFICIENTE', 'No hay stock', [['campo' => 'cantidad', 'disponible' => 2, 'solicitado' => 3]])]);

        $this->conSesion('ADMINISTRADOR')->from('/movimientos/nuevo')->post('/movimientos', self::FORMULARIO)
            ->assertSessionHasErrors(['cantidad' => 'No hay stock suficiente. Disponible: 2.']);

        $this->assertNull(session()->getOldInput('clave'));
        $this->assertSame('3', session()->getOldInput('cantidad'));
    }

    public function test_tras_un_fallo_dudoso_la_clave_se_conserva_para_que_repetir_no_duplique(): void
    {
        $this->gatewayBase(['POST movimientos' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->from('/movimientos/nuevo')->post('/movimientos', self::FORMULARIO)
            ->assertRedirect('/movimientos/nuevo')->assertSessionHas('error');

        $this->assertSame('clave-del-formulario-1', session()->getOldInput('clave'));

        // Y el formulario vuelve a mostrar esa misma clave.
        $this->get('/movimientos/nuevo?tipo=SALIDA&id_producto=1')->assertSee('value="clave-del-formulario-1"', false);
    }

    public function test_una_respuesta_repetida_de_otra_operacion_no_se_da_por_buena(): void
    {
        $this->gatewayBase(['POST movimientos' => Http::response(['id_movimiento' => 4, 'tipo' => 'SALIDA', 'id_producto' => 99, 'cantidad' => 3, 'saldo_resultante' => 1], 200)]);

        $this->conSesion('ADMINISTRADOR')->post('/movimientos', self::FORMULARIO)->assertSessionHas('error')->assertSessionMissing('exito');
    }

    public function test_un_422_del_servicio_se_muestra_junto_al_campo(): void
    {
        $this->gatewayBase(['POST movimientos' => self::error(422, 'DATOS_NO_VALIDOS', '', [['campo' => 'lote.fecha_vencimiento', 'mensaje' => 'no puede ser anterior a hoy']])]);

        $this->conSesion('ADMINISTRADOR')->from('/x')->post('/movimientos', ['tipo' => 'ENTRADA', 'codigo_lote' => 'L', 'fecha_vencimiento' => '2020-01-01'] + self::FORMULARIO)
            ->assertSessionHasErrors(['fecha_vencimiento' => 'No puede ser anterior a hoy']);
    }

    public function test_el_formulario_de_entrada_ofrece_lote_y_vencimiento_y_se_abre_solo_si_hay_datos_o_errores(): void
    {
        $this->gatewayBase(['GET saldos' => self::listado([]), 'GET lotes' => self::listado([])]);

        $cerrado = $this->conSesion('ADMINISTRADOR')->get('/movimientos/nuevo?tipo=ENTRADA&id_producto=1')->assertOk()
            ->assertSee('Tiene lote y fecha de vencimiento')->assertSee('name="codigo_lote"', false)
            ->assertDontSee('errors->has', false)->assertDontSee('$errors', false);
        $this->assertMatchesRegularExpression('/<details class="mb-3" >/', $cerrado->getContent());

        $this->withSession(['_old_input' => ['codigo_lote' => 'L-1']])->get('/movimientos/nuevo?tipo=ENTRADA&id_producto=1')
            ->assertSee('<details class="mb-3"  open >', false);
    }

    public function test_el_formulario_de_salida_avisa_de_los_lotes_vencidos(): void
    {
        $this->gatewayBase([
            'GET saldos' => self::listado([['id_saldo' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad_disponible' => 40]]),
            'GET lotes' => self::listado([['id_lote' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'codigo_lote' => 'L-VIEJO', 'fecha_vencimiento' => '2020-01-01', 'cantidad_disponible' => 5]]),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/movimientos/nuevo?tipo=SALIDA&id_producto=1')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('Hay en Bodega Centro')->assertSee('L-VIEJO')->assertSee('Vencido');
    }

    public function test_el_historial_muestra_nombres_tipos_en_lenguaje_cotidiano_y_el_saldo(): void
    {
        $this->gatewayBase(['GET movimientos' => self::listado([
            ['id_movimiento' => 1, 'tipo' => 'TRASLADO_SALIDA', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => 5, 'saldo_resultante' => 20, 'fecha' => '2026-11-16T21:00:00Z', 'documento_referencia' => 'FAC-9'],
        ])]);

        $this->conSesion('CONTADOR')->get('/movimientos')->assertOk()
            ->assertSee('Traslado enviado')->assertSee('Café molido 500 g')->assertSee('FAC-9')->assertSee('quedan 20')
            ->assertDontSee('Entra</a>', false); // el contador solo lee
    }
}
