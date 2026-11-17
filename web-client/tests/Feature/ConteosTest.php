<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ConteosTest extends TestCase
{
    private function conteo(int $id = 4, string $estado = 'PROGRAMADO', int $bodega = 1, array $detalles = []): array
    {
        return ['id_conteo' => $id, 'id_bodega' => $bodega, 'estado' => $estado, 'fecha_programada' => '2026-11-20',
            'fecha_aprobacion' => $estado === 'APROBADO' ? '2026-11-21T15:00:00Z' : null, 'id_usuario_aprueba' => $estado === 'APROBADO' ? 7 : null,
            'detalles' => $detalles];
    }

    private function linea(int $producto, int $sistema, ?int $contada = null): array
    {
        return ['id_detalle_conteo' => $producto * 10, 'id_producto' => $producto, 'cantidad_sistema' => $sistema,
            'cantidad_contada' => $contada, 'diferencia' => $contada === null ? null : $contada - $sistema];
    }

    private function gatewayBase(array $mas = []): void
    {
        $this->fingirGateway($mas + ['GET productos/1' => self::producto(1, 'Café molido 500 g'), 'GET productos/2' => self::producto(2, 'Azúcar 1 kg'), 'GET bodegas' => self::bodegas()]);
    }

    public function test_el_operador_solo_ve_los_conteos_de_su_bodega(): void
    {
        $this->gatewayBase(['GET conteos' => self::listado([$this->conteo(4)])]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/conteos')->assertOk()->assertSee('Conteo #4')->assertSee('Bodega Centro')->assertSee('Por contar')
            ->assertDontSee('Programar');
        $this->assertTrue($this->seEnvio('GET', 'conteos', fn (Request $p) => ($p->data()['id_bodega'] ?? null) === 1 || str_contains($p->url(), 'id_bodega=1')));
    }

    public function test_el_operador_sin_bodega_no_ve_conteos(): void
    {
        $this->gatewayBase();

        $this->conSesion('OPERADOR_BODEGA')->get('/conteos')->assertOk()->assertSee('bodega');
        $this->assertFalse($this->seEnvio('GET', 'conteos'));
    }

    public function test_el_administrador_ve_el_boton_de_programar(): void
    {
        $this->gatewayBase(['GET conteos' => self::listado([])]);

        $this->conSesion('ADMINISTRADOR')->get('/conteos')->assertOk()->assertSee(route('conteos.crear'))->assertSee('No hay conteos para mostrar');
    }

    public function test_si_el_servicio_no_responde_el_listado_lo_dice(): void
    {
        $this->gatewayBase(['GET conteos' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->get('/conteos')->assertOk()->assertSee('No pudimos cargar los conteos');
    }

    public function test_el_vendedor_y_el_contador_no_entran_a_los_conteos(): void
    {
        $this->gatewayBase();

        $this->conSesion('VENDEDOR')->get('/conteos')->assertForbidden();
        $this->conSesion('CONTADOR')->get('/conteos')->assertForbidden();
        $this->conSesion('OPERADOR_BODEGA', 1)->get('/conteos/nuevo')->assertForbidden();
    }

    public function test_programar_envia_bodega_y_fecha(): void
    {
        $this->gatewayBase(['POST conteos' => Http::response($this->conteo(9), 201)]);
        $fecha = gmdate('Y-m-d', time() + 86400);

        $this->conSesion('ADMINISTRADOR')->post('/conteos', ['id_bodega' => 1, 'fecha_programada' => $fecha])
            ->assertRedirect('/conteos/9')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('POST', 'conteos', fn (Request $p) => $p->data() === ['id_bodega' => 1, 'fecha_programada' => $fecha]));
    }

    public function test_programar_no_acepta_una_fecha_pasada(): void
    {
        $this->gatewayBase();

        $this->conSesion('ADMINISTRADOR')->from('/conteos/nuevo')->post('/conteos', ['id_bodega' => 1, 'fecha_programada' => '2020-01-01'])
            ->assertSessionHasErrors('fecha_programada');
        $this->assertFalse($this->seEnvio('POST', 'conteos'));
    }

    public function test_programar_una_bodega_sin_existencias_muestra_el_motivo_en_la_bodega(): void
    {
        $this->gatewayBase(['POST conteos' => self::error(422, 'DATOS_NO_VALIDOS', 'Datos no válidos', [['campo' => 'ids_producto', 'mensaje' => 'la bodega no tiene productos con existencia']])]);

        $this->conSesion('ADMINISTRADOR')->from('/conteos/nuevo')->post('/conteos', ['id_bodega' => 2, 'fecha_programada' => gmdate('Y-m-d')])
            ->assertSessionHasErrors(['id_bodega' => 'La bodega no tiene productos con existencia']);
    }

    public function test_programar_con_el_servicio_caido_pide_revisar_la_lista_antes_de_repetir(): void
    {
        $this->gatewayBase(['POST conteos' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->from('/conteos/nuevo')->post('/conteos', ['id_bodega' => 1, 'fecha_programada' => gmdate('Y-m-d')])
            ->assertSessionHas('error', fn (string $m) => str_contains($m, 'Revisa la lista de conteos'));
    }

    public function test_el_conteo_muestra_lo_contado_y_las_diferencias(): void
    {
        $this->gatewayBase(['GET conteos/4' => Http::response($this->conteo(4, 'EN_REVISION', 1, [$this->linea(1, 40, 38), $this->linea(2, 10, 10), $this->linea(3, 5)]))]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/conteos/4')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('Faltan 2')->assertSee('Coincide')->assertSee('2 de 3')->assertSee('1 con diferencia')
            ->assertSee('contadas[1]', false)->assertDontSee('Aprobar conteo');
    }

    public function test_solo_el_administrador_aprueba_y_solo_un_conteo_en_revision(): void
    {
        $this->gatewayBase([
            'GET conteos/4' => Http::response($this->conteo(4, 'EN_REVISION', 1, [$this->linea(1, 40, 38)])),
            'GET conteos/5' => Http::response($this->conteo(5, 'PROGRAMADO', 1, [$this->linea(1, 40)])),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/conteos/4')->assertSee('Aprobar conteo');
        $this->conSesion('ADMINISTRADOR')->get('/conteos/5')->assertDontSee('Aprobar conteo');
    }

    public function test_un_conteo_aprobado_no_admite_cantidades(): void
    {
        $this->gatewayBase(['GET conteos/4' => Http::response($this->conteo(4, 'APROBADO', 1, [$this->linea(1, 40, 38)]))]);

        $this->conSesion('ADMINISTRADOR')->get('/conteos/4')->assertOk()->assertSee('Aprobado')->assertDontSee('Guardar cantidades')->assertDontSee('contadas[1]', false);
    }

    public function test_registrar_envia_solo_las_lineas_escritas(): void
    {
        $this->gatewayBase(['PUT conteos/4/detalles' => Http::response($this->conteo(4, 'EN_REVISION'))]);

        $this->conSesion('OPERADOR_BODEGA', 1)->put('/conteos/4/detalles', ['contadas' => ['1' => '1.250', '2' => '', '3' => '0']])
            ->assertRedirect('/conteos/4')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('PUT', 'conteos/4/detalles', fn (Request $p) => $p->data() === ['detalles' => [
            ['id_producto' => 1, 'cantidad_contada' => 1250], ['id_producto' => 3, 'cantidad_contada' => 0],
        ]]));
    }

    public function test_registrar_sin_ninguna_cantidad_no_llama_al_servicio(): void
    {
        $this->gatewayBase();

        $this->conSesion('OPERADOR_BODEGA', 1)->from('/conteos/4')->put('/conteos/4/detalles', ['contadas' => ['1' => '', '2' => '']])
            ->assertSessionHas('error', 'Escribe al menos una cantidad contada.');
        $this->assertFalse($this->seEnvio('PUT', 'conteos/4/detalles'));
    }

    public function test_registrar_rechaza_cantidades_que_no_son_enteros(): void
    {
        $this->gatewayBase();

        $this->conSesion('OPERADOR_BODEGA', 1)->from('/conteos/4')->put('/conteos/4/detalles', ['contadas' => ['1' => '12,5', '2' => '-3']])
            ->assertSessionHasErrors(['contadas.1', 'contadas.2']);
        $this->assertFalse($this->seEnvio('PUT', 'conteos/4/detalles'));
    }

    public function test_registrar_en_un_conteo_ya_aprobado_lo_explica(): void
    {
        $this->gatewayBase(['PUT conteos/4/detalles' => self::error(409, 'CONTEO_ESTADO_INVALIDO')]);

        $this->conSesion('OPERADOR_BODEGA', 1)->from('/conteos/4')->put('/conteos/4/detalles', ['contadas' => ['1' => '3']])
            ->assertSessionHas('error', 'Ese conteo ya fue aprobado: no admite más cantidades.');
    }

    public function test_aprobar_envia_la_clave_y_cuenta_los_ajustes(): void
    {
        $this->gatewayBase(['POST conteos/4/aprobacion' => Http::response($this->conteo(4, 'APROBADO') + ['movimientos' => [['id_movimiento' => 1], ['id_movimiento' => 2]]])]);

        $this->conSesion('ADMINISTRADOR')->post('/conteos/4/aprobacion', ['clave' => 'cnt-1'])
            ->assertRedirect('/conteos/4')->assertSessionHas('exito', 'Conteo aprobado: el inventario se ajustó en 2 productos.');
        $this->assertTrue($this->seEnvio('POST', 'conteos/4/aprobacion', fn (Request $p) => $p->header('Idempotency-Key') === ['cnt-1']));
    }

    public function test_aprobar_sin_diferencias_lo_dice(): void
    {
        $this->gatewayBase(['POST conteos/4/aprobacion' => Http::response($this->conteo(4, 'APROBADO') + ['movimientos' => []])]);

        $this->conSesion('ADMINISTRADOR')->post('/conteos/4/aprobacion', ['clave' => 'cnt-2'])
            ->assertSessionHas('exito', fn (string $m) => str_contains($m, 'coincide con el sistema'));
    }

    public function test_aprobar_con_stock_insuficiente_explica_por_que_no_se_puede(): void
    {
        $this->gatewayBase(['POST conteos/4/aprobacion' => self::error(409, 'STOCK_INSUFICIENTE')]);

        $this->conSesion('ADMINISTRADOR')->from('/conteos/4')->post('/conteos/4/aprobacion', ['clave' => 'cnt-3'])
            ->assertSessionHas('error', fn (string $m) => str_contains($m, 'ajuste negativo'));
    }

    public function test_aprobar_con_el_servicio_caido_pide_revisar_antes_de_repetir(): void
    {
        $this->gatewayBase(['POST conteos/4/aprobacion' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->from('/conteos/4')->post('/conteos/4/aprobacion', ['clave' => 'cnt-4'])
            ->assertSessionHas('error', fn (string $m) => str_contains($m, 'Revisa el estado del conteo'));
    }

    public function test_el_operador_no_aprueba(): void
    {
        $this->gatewayBase();

        $this->conSesion('OPERADOR_BODEGA', 1)->post('/conteos/4/aprobacion', ['clave' => 'cnt-5'])->assertForbidden();
        $this->assertFalse($this->seEnvio('POST', 'conteos/4/aprobacion'));
    }

    public function test_stock_y_mas_enlazan_a_los_conteos(): void
    {
        $this->gatewayBase(['GET saldos' => self::listado([])]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/stock')->assertSee(route('conteos.index'));
        $this->conSesion('ADMINISTRADOR')->get('/administrar')->assertSee(route('conteos.index'));
    }
}
