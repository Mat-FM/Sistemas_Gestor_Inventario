<?php

namespace Tests\Unit;

use App\Support\Formato;
use App\Support\Roles;
use Tests\TestCase;

class FormatoTest extends TestCase
{
    public function test_numeros_y_monedas_en_formato_colombiano(): void
    {
        $this->assertSame('1.234.567', Formato::numero(1234567));
        $this->assertSame('—', Formato::numero(null));
        $this->assertSame('$ 18.500,50', Formato::moneda(18500.5));
        $this->assertSame('$ 3.200', Formato::moneda(3200));
    }

    public function test_los_decimales_escritos_a_la_colombiana_se_normalizan(): void
    {
        $this->assertSame('18500', Formato::normalizarDecimal('18.500'));
        $this->assertSame('18500.50', Formato::normalizarDecimal('18.500,50'));
        $this->assertSame('18500.5', Formato::normalizarDecimal('18500,5'));
        $this->assertSame('18500.5', Formato::normalizarDecimal('18500.5'));
        $this->assertSame('1234567', Formato::normalizarDecimal('1.234.567'));
        $this->assertSame('2800', Formato::normalizarDecimal('$ 2.800'));
        $this->assertSame('abc', Formato::normalizarDecimal('abc'));
        $this->assertNull(Formato::normalizarDecimal(null));
    }

    public function test_los_instantes_utc_se_muestran_en_hora_de_bogota(): void
    {
        $this->assertSame('16/11/2026 10:30 pm', Formato::fecha('2026-11-17T03:30:00.000Z'));
        $this->assertSame('—', Formato::fecha(null));
        $this->assertSame('01/03/2027', Formato::dia('2027-03-01'));
    }

    public function test_un_lote_vencido_se_reconoce_y_uno_futuro_no(): void
    {
        $this->assertTrue(Formato::vencido('2020-01-01'));
        $this->assertFalse(Formato::vencido(now()->addYear()->toDateString()));
        $this->assertFalse(Formato::vencido(null));
    }

    public function test_las_alertas_cambian_los_numeros_de_producto_y_bodega_por_sus_nombres(): void
    {
        $this->assertSame(
            'Stock bajo del producto «Café $5 molido» tras un movimiento en la bodega «Bodega Centro»: quedan 74.',
            Formato::mensajeDeAlerta('Stock bajo del producto 1 tras un movimiento en la bodega 1: quedan 74.', 'Café $5 molido', [1 => 'Bodega Centro']),
        );
        $this->assertSame('El producto 3 vence.', Formato::mensajeDeAlerta('El producto 3 vence.', null));
        $this->assertSame('Lote del producto «A» en la bodega 12.', Formato::mensajeDeAlerta('Lote del producto 10 en la bodega 12.', 'A', [1 => 'Centro']));
    }

    public function test_cada_tipo_de_movimiento_tiene_nombre_y_signo(): void
    {
        $this->assertSame('Entrada por compra', Formato::tipo('ENTRADA_COMPRA'));
        $this->assertSame(-1, Formato::signo('TRASLADO_SALIDA'));
        $this->assertSame(1, Formato::signo('DEVOLUCION_CLIENTE'));
        $this->assertSame(0, Formato::signo('AJUSTE'));
    }

    public function test_el_menu_de_cada_rol_no_tiene_enlaces_a_lo_que_no_puede_usar(): void
    {
        $rutas = fn (string $rol) => array_column(Roles::menu($rol), 'ruta');

        $this->assertSame(['inicio'], $rutas(Roles::VENDEDOR));
        $this->assertSame(['inicio', 'stock', 'movimientos.index', 'reportes.index'], $rutas(Roles::CONTADOR));
        $this->assertSame(['inicio', 'stock', 'movimientos.index', 'traslados.index', 'compras.ordenes.index'], $rutas(Roles::OPERADOR));
        $this->assertSame([...$rutas(Roles::OPERADOR), 'reportes.index', 'administrar'], $rutas(Roles::ADMINISTRADOR));
        $this->assertSame(['inicio', 'stock', 'movimientos.index', 'traslados.index', 'administrar'], array_column(Roles::menuMovil(Roles::ADMINISTRADOR), 'ruta'));
        $this->assertSame($rutas(Roles::CONTADOR), array_column(Roles::menuMovil(Roles::CONTADOR), 'ruta'));
        $this->assertSame($rutas(Roles::OPERADOR), array_column(Roles::menuMovil(Roles::OPERADOR), 'ruta'));
        $this->assertSame([], Roles::administracion(Roles::OPERADOR));
        $this->assertCount(8, Roles::administracion(Roles::ADMINISTRADOR));
        $this->assertSame('Buscar', Roles::menu(Roles::VENDEDOR)[0]['etiqueta']);
    }
}
