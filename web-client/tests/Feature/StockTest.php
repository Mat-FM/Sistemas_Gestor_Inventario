<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class StockTest extends TestCase
{
    public function test_buscar_por_nombre_o_codigo_une_los_resultados_y_muestra_donde_hay(): void
    {
        $this->fingirGateway([
            'GET productos' => fn (Request $p) => str_contains($p->url(), 'nombre=')
                ? self::listado([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'unidad_medida' => 'UNIDAD']])
                : self::listado([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'unidad_medida' => 'UNIDAD'], ['id_producto' => 2, 'codigo' => 'CAF-1K', 'nombre' => 'Café 1 kg', 'unidad_medida' => 'UNIDAD']]),
            'GET saldos' => fn (Request $p) => self::listado($p['id_producto'] === '1'
                ? [['id_saldo' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad_disponible' => 40], ['id_saldo' => 2, 'id_producto' => 1, 'id_bodega' => 2, 'cantidad_disponible' => 0]]
                : []),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('VENDEDOR')->get('/stock?q=caf')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('Café 1 kg')           // sin duplicar el producto que coincide en nombre y código
            ->assertSee('Bodega Centro')->assertSee('Bodega Norte')->assertSee('Sin existencias registradas')
            ->assertDontSee('Entra</a>', false);                                // el vendedor solo consulta

        $this->assertSame(1, substr_count($this->get('/stock?q=caf')->getContent(), 'CAF-500'));
    }

    public function test_el_administrador_ve_las_acciones_sobre_cada_producto(): void
    {
        $this->fingirGateway([
            'GET productos' => self::listado([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'unidad_medida' => 'UNIDAD']]),
            'GET saldos' => self::listado([['id_saldo' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad_disponible' => 40]]),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/stock?q=caf')->assertOk()
            ->assertSee(route('movimientos.crear', ['tipo' => 'ENTRADA', 'id_producto' => 1]))
            ->assertSee(route('traslados.crear', ['id_producto' => 1]));
    }

    public function test_el_listado_agrupa_por_producto_con_nombres_y_total_y_conserva_la_paginacion(): void
    {
        $this->fingirGateway([
            'GET saldos' => Http::response(['datos' => [
                ['id_saldo' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad_disponible' => 40],
                ['id_saldo' => 2, 'id_producto' => 1, 'id_bodega' => 2, 'cantidad_disponible' => 18],
            ], 'meta' => ['pagina' => 1, 'por_pagina' => 20, 'total' => 45]]),
            'GET productos/1' => self::producto(1, 'Café molido 500 g'),
            'GET bodegas' => self::bodegas(),
        ]);

        $this->conSesion('CONTADOR')->get('/stock')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('58')->assertSee('Página 1 de 3');
    }

    public function test_el_operador_consulta_siempre_su_propia_bodega(): void
    {
        $this->fingirGateway(['GET saldos' => self::listado([]), 'GET bodegas' => self::bodegas()]);

        $this->conSesion('OPERADOR_BODEGA', 2)->get('/stock?bodega=1')->assertOk();

        $this->assertTrue($this->seEnvio('GET', 'saldos', fn (Request $p) => str_contains($p->url(), 'id_bodega=2') && ! str_contains($p->url(), 'id_bodega=1')));
    }

    public function test_sin_resultados_se_explica_en_vez_de_mostrar_una_pantalla_vacia(): void
    {
        $this->fingirGateway(['GET productos' => self::listado([]), 'GET bodegas' => self::bodegas()]);

        $this->conSesion('VENDEDOR')->get('/stock?q=zzz')->assertOk()->assertSee('No encontramos productos que coincidan con «zzz»');
    }
}
