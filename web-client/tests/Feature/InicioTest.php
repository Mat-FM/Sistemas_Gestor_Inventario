<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class InicioTest extends TestCase
{
    private function movimientoReciente(): array
    {
        return ['id_movimiento' => 9, 'tipo' => 'SALIDA', 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => 3, 'saldo_resultante' => 36,
            'fecha' => '2026-11-17T03:30:00.000Z', 'id_usuario' => 1, 'documento_referencia' => null];
    }

    public function test_el_administrador_ve_primero_el_stock_bajo_con_nombres_y_no_ids(): void
    {
        $this->fingirGateway([
            'GET saldos/bajo-umbral' => Http::response([['id_producto' => 1, 'cantidad_total' => 57, 'cantidad_minima' => 80]]),
            'GET traslados' => self::listado([], 2),
            'GET movimientos' => self::listado([$this->movimientoReciente()]),
            'GET productos/1' => self::producto(1, 'Café molido 500 g'),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/')->assertOk()
            ->assertSee('1 producto con poco stock')->assertSee('Café molido 500 g')->assertSee('Mínimo 80')
            ->assertSee('Traslados en camino')->assertSee('Sale mercancía')
            ->assertSee('Salida')->assertSee('Bodega Centro')
            ->assertSee('16/11/2026 10:30 pm')   // la API envía UTC; se muestra la hora de Bogotá
            ->assertDontSee('Producto #1')
            ->assertDontSee('Servicio no disponible');
    }

    public function test_con_muchos_productos_bajo_el_minimo_solo_se_resuelven_los_nombres_de_los_mas_urgentes(): void
    {
        $filas = [];
        for ($i = 1; $i <= 40; $i++) {
            $filas[] = ['id_producto' => $i, 'cantidad_total' => $i, 'cantidad_minima' => 100];
        }
        $this->fingirGateway([
            'GET saldos/bajo-umbral' => Http::response($filas),
            'GET traslados' => self::listado([], 0),
            'GET movimientos' => self::listado([]),
            'GET bodegas' => self::bodegas(),
        ] + array_combine(
            array_map(fn ($i) => "GET productos/$i", range(1, 40)),
            array_map(fn ($i) => self::producto($i, "Producto de prueba $i"), range(1, 40)),
        ));

        $this->conSesion('ADMINISTRADOR')->get('/')->assertOk()
            ->assertSee('40 productos con poco stock')->assertSee('Y 34 más')
            ->assertSee('Producto de prueba 1')->assertSee('Producto de prueba 6')->assertDontSee('Producto de prueba 7');

        $pedidosDeNombres = Http::recorded(fn ($p) => str_contains($p->url(), '/api/productos/'));
        $this->assertCount(6, $pedidosDeNombres);
    }

    private function indicadores(): array
    {
        return ['valor_total' => 6561842.5, 'productos_bajo_umbral' => 2, 'productos_agotados' => 2, 'proximos_a_vencer' => 1, 'ordenes_pendientes' => 3,
            'mayor_rotacion' => [['id_producto' => 2, 'codigo' => 'PAN-001', 'nombre' => 'Panela redonda', 'salidas' => 28], ['id_producto' => 3, 'codigo' => 'ARR-500', 'nombre' => 'Arroz 500 g', 'salidas' => 10]]];
    }

    public function test_el_administrador_ve_los_indicadores_y_el_de_ordenes_lleva_a_compras(): void
    {
        $this->fingirGateway([
            'GET saldos/bajo-umbral' => Http::response([]), 'GET traslados' => self::listado([], 0), 'GET movimientos' => self::listado([]), 'GET bodegas' => self::bodegas(),
            'GET indicadores' => Http::response($this->indicadores()),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/')->assertOk()
            ->assertSee('$ 6.561.843')->assertSee('Productos agotados')->assertSee('Lote por vencer')->assertSee('Órdenes por recibir')
            ->assertSee('href="'.route('compras.ordenes.index').'"', false);
    }

    public function test_si_los_indicadores_fallan_el_resto_del_inicio_se_muestra(): void
    {
        $this->fingirGateway([
            'GET saldos/bajo-umbral' => Http::response([]), 'GET traslados' => self::listado([], 0), 'GET movimientos' => self::listado([]), 'GET bodegas' => self::bodegas(),
            'GET indicadores' => self::error(503, 'SERVICIO_NO_DISPONIBLE'),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/')->assertOk()->assertSee('No pudimos calcular los indicadores')->assertSee('Entra mercancía');
    }

    public function test_el_contador_ve_los_indicadores_y_lo_que_mas_sale_pero_sin_enlace_a_compras(): void
    {
        $this->fingirGateway([
            'GET reportes/valorizacion' => Http::response(['valor_total' => 100, 'productos' => []]), 'GET movimientos' => self::listado([]), 'GET bodegas' => self::bodegas(),
            'GET indicadores' => Http::response($this->indicadores()),
        ]);

        $this->conSesion('CONTADOR')->get('/')->assertOk()
            ->assertSee('Lo que más sale')->assertSee('Panela redonda')->assertSee('28 salidas')->assertSee('Órdenes por recibir')
            ->assertDontSee(route('compras.ordenes.index'));
    }

    public function test_el_operador_ve_las_ordenes_de_compra_que_esperan_mercancia_en_su_bodega(): void
    {
        $orden = fn (int $id, string $estado) => ['id_orden' => $id, 'numero' => 'OC-000'.$id, 'estado' => $estado, 'id_proveedor' => 1, 'id_bodega_destino' => 1, 'fecha_esperada' => '2026-12-10', 'total' => 1000];
        $this->fingirGateway([
            'GET traslados' => self::listado([]), 'GET movimientos' => self::listado([]), 'GET bodegas' => self::bodegas(),
            'GET ordenes-compra' => fn (Request $p) => self::listado(str_contains($p->url(), 'estado=ENVIADA') ? [$orden(1, 'ENVIADA')] : [$orden(2, 'RECIBIDA_PARCIAL')]),
            'GET proveedores/1' => Http::response(['id_proveedor' => 1, 'razon_social' => 'Distribuidora Café']),
        ]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/')->assertOk()
            ->assertSee('2 órdenes de compra por recibir')->assertSee('OC-0001 · Distribuidora Café')->assertSee('OC-0002')->assertSee(route('compras.ordenes.show', 2));
        $this->assertTrue($this->seEnvio('GET', 'ordenes-compra', fn (Request $p) => str_contains($p->url(), 'id_bodega_destino=1')));
    }

    public function test_si_un_bloque_del_inicio_falla_el_resto_se_muestra(): void
    {
        $this->fingirGateway([
            'GET saldos/bajo-umbral' => self::error(503, 'SERVICIO_NO_DISPONIBLE'),
            'GET traslados' => self::listado([], 0),
            'GET movimientos' => self::error(503, 'SERVICIO_NO_DISPONIBLE'),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/')->assertOk()
            ->assertSee('No pudimos revisar qué productos tienen poco stock')
            ->assertSee('No pudimos cargar los movimientos')
            ->assertSee('Entra mercancía');
    }

    public function test_el_operador_ve_los_traslados_que_debe_recibir_en_su_bodega_y_no_los_que_envio(): void
    {
        $this->fingirGateway([
            'GET traslados' => self::listado([
                ['id_traslado' => 5, 'id_producto' => 1, 'id_bodega_origen' => 2, 'id_bodega_destino' => 1, 'cantidad' => 12, 'estado' => 'EN_TRANSITO', 'fecha_envio' => '2026-11-16T15:00:00Z', 'fecha_recepcion' => null],
                ['id_traslado' => 6, 'id_producto' => 1, 'id_bodega_origen' => 1, 'id_bodega_destino' => 2, 'cantidad' => 4, 'estado' => 'EN_TRANSITO', 'fecha_envio' => '2026-11-16T15:00:00Z', 'fecha_recepcion' => null],
            ]),
            'GET movimientos' => self::listado([$this->movimientoReciente()]),
            'GET productos/1' => self::producto(1, 'Café molido 500 g'),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/')->assertOk()
            ->assertSee('1 traslado por recibir')->assertSee('Desde Bodega Norte')->assertSee(route('traslados.recibir', 5))
            ->assertDontSee(route('traslados.recibir', 6))
            ->assertDontSee('poco stock'); // el aviso de stock bajo es solo del administrador

        // El operador pide solo su bodega y nunca el aviso de stock bajo (lo bloquea el Gateway).
        $this->assertTrue($this->seEnvio('GET', 'traslados', fn ($p) => $p['id_bodega'] === '1' || str_contains($p->url(), 'id_bodega=1')));
        $this->assertFalse($this->seEnvio('GET', 'saldos/bajo-umbral'));
    }

    public function test_un_operador_sin_bodega_recibe_una_explicacion_y_no_un_403(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('OPERADOR_BODEGA', null)->get('/')->assertOk()->assertSee('Todavía no tienes una bodega');
        $this->conSesion('OPERADOR_BODEGA', null)->get('/stock')->assertOk()->assertSee('Todavía no tienes una bodega');
        $this->conSesion('OPERADOR_BODEGA', null)->get('/movimientos/nuevo')->assertOk()->assertSee('Todavía no tienes una bodega');
        // Solo la campana de alertas pregunta algo: ninguna pantalla pide datos de inventario sin bodega.
        $this->assertSame([], Http::recorded(fn ($p) => ! str_contains($p->url(), '/api/notificaciones'))->all());
    }

    public function test_el_vendedor_solo_ve_la_busqueda_y_un_menu_de_una_entrada(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('VENDEDOR')->get('/')->assertOk()
            ->assertSee('¿Qué producto buscas?')
            ->assertDontSee('Sale mercancía')->assertDontSee('Movimientos')->assertDontSee('Traslados');
    }

    public function test_el_contador_ve_el_valor_del_inventario_y_solo_enlaces_de_lectura(): void
    {
        $this->fingirGateway([
            'GET reportes/valorizacion' => Http::response(['valor_total' => 48350000, 'productos' => [['id_producto' => 1, 'nombre' => 'Café molido 500 g', 'cantidad' => 58, 'precio' => 18500.5, 'valor' => 1073029]]]),
            'GET movimientos' => self::listado([$this->movimientoReciente()]),
            'GET productos/1' => self::producto(1, 'Café molido 500 g'),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('CONTADOR')->get('/')->assertOk()
            ->assertSee('$ 48.350.000')->assertSee('Existencias')->assertSee('Movimientos')
            ->assertDontSee('Entra mercancía')->assertDontSee('Traslados');
    }
}
