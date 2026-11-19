<?php

namespace Tests\Feature;

use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ReportesTest extends TestCase
{
    private function kardex(int $n = 2): array
    {
        return array_map(fn ($i) => ['id_movimiento' => $i, 'fecha' => '2026-11-16T21:00:00Z', 'tipo' => $i % 2 ? 'SALIDA' : 'ENTRADA', 'id_producto' => 1, 'codigo' => 'CAF-500',
            'nombre' => 'Café molido 500 g', 'id_bodega' => 1, 'bodega' => 'Bodega Centro', 'cantidad' => 3, 'saldo_resultante' => 40 + $i, 'id_usuario' => 1, 'documento_referencia' => 'FAC-9', 'observacion' => null], range(1, $n));
    }

    private function gatewayDeReportes(array $mas = []): void
    {
        $this->fingirGateway($mas + [
            'GET reportes/existencias' => Http::response([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'id_categoria' => 1, 'id_bodega' => 1, 'bodega' => 'Bodega Centro', 'cantidad_disponible' => 40], ['id_producto' => 3, 'codigo' => 'ARR-500', 'nombre' => 'Arroz 500 g', 'id_categoria' => 2, 'id_bodega' => 1, 'bodega' => 'Bodega Centro', 'cantidad_disponible' => 0]]),
            'GET reportes/valorizacion' => Http::response(['valor_total' => 1500000.5, 'productos' => [['id_producto' => 3, 'codigo' => 'ARR-500', 'nombre' => 'Arroz 500 g', 'cantidad' => 110, 'precio' => 2800, 'valor' => 308000], ['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'cantidad' => 58, 'precio' => 18500.5, 'valor' => 1073029]]]),
            'GET reportes/rotacion' => Http::response(['mayor_rotacion' => [['id_producto' => 2, 'codigo' => 'PAN-001', 'nombre' => 'Panela redonda', 'salidas' => 28]], 'menor_rotacion' => [['id_producto' => 4, 'codigo' => 'ACE-1L', 'nombre' => 'Aceite vegetal 1 L', 'salidas' => 0]]]),
            'GET reportes/kardex' => Http::response($this->kardex()),
            'GET bodegas' => self::bodegas(),
            'GET categorias' => Http::response([['id_categoria' => 1, 'nombre' => 'Bebidas', 'descripcion' => null, 'id_categoria_padre' => null]]),
            'GET productos' => self::listado([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g']]),
            'GET usuarios' => self::listado([['id_usuario' => 1, 'nombre' => 'Ana Admin']]),
        ]);
    }

    public function test_el_administrador_y_el_contador_ven_los_cuatro_reportes_y_los_demas_roles_no(): void
    {
        $this->gatewayDeReportes();

        foreach (['/reportes', '/reportes/existencias', '/reportes/valorizacion', '/reportes/rotacion', '/reportes/kardex'] as $ruta) {
            $this->conSesion('ADMINISTRADOR')->get($ruta)->assertOk();
            $this->conSesion('CONTADOR')->get($ruta)->assertOk();
            $this->conSesion('OPERADOR_BODEGA', 1)->get($ruta)->assertForbidden();
            $this->conSesion('VENDEDOR')->get($ruta)->assertForbidden();
        }
    }

    public function test_existencias_muestra_cada_producto_por_bodega_y_manda_los_filtros(): void
    {
        $this->gatewayDeReportes();

        $this->conSesion('CONTADOR')->get('/reportes/existencias?bodega=1&categoria=1')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('CAF-500 · Bodega Centro')->assertSee('Descargar CSV')->assertSee('Descargar PDF');
        $this->assertTrue($this->seEnvio('GET', 'reportes/existencias', fn (Request $p) => str_contains($p->url(), 'id_bodega=1') && str_contains($p->url(), 'id_categoria=1')));
    }

    public function test_la_valorizacion_ordena_por_valor_y_muestra_el_total(): void
    {
        $this->gatewayDeReportes();

        $html = $this->conSesion('CONTADOR')->get('/reportes/valorizacion')->assertOk()->assertSee('$ 1.500.000,50')->getContent();
        $this->assertLessThan(strpos($html, 'Arroz 500 g'), strpos($html, 'Café molido 500 g'), 'el de mayor valor va primero');
    }

    public function test_la_rotacion_usa_los_ultimos_30_dias_por_defecto_y_rechaza_un_rango_al_reves(): void
    {
        $this->gatewayDeReportes();
        $hoy = CarbonImmutable::now(config('interfaz.zona_horaria'));

        $this->conSesion('CONTADOR')->get('/reportes/rotacion')->assertOk()->assertSee('Panela redonda')->assertSee('28 salidas')->assertSee('Aceite vegetal 1 L');
        $this->assertTrue($this->seEnvio('GET', 'reportes/rotacion', fn (Request $p) => str_contains($p->url(), 'fecha_desde='.$hoy->subDays(30)->toDateString()) && str_contains($p->url(), 'fecha_hasta='.$hoy->toDateString())));

        $this->fingirGateway([]);
        $this->conSesion('CONTADOR')->get('/reportes/rotacion?desde=2026-11-30&hasta=2026-11-01')->assertOk()->assertSee('no puede ser posterior');
        $this->assertFalse($this->seEnvio('GET', 'reportes/rotacion'));
    }

    public function test_el_kardex_filtra_muestra_nombres_y_solo_dibuja_las_primeras_filas(): void
    {
        $this->gatewayDeReportes(['GET reportes/kardex' => Http::response($this->kardex(130))]);

        $this->conSesion('ADMINISTRADOR')->get('/reportes/kardex?producto=1&bodega=1&tipo=SALIDA&usuario=1&desde=2026-11-01&hasta=2026-11-30')->assertOk()
            ->assertSee('Café molido 500 g')->assertSee('Mostramos los 100 más recientes de 130')->assertSee('Ana Admin');
        $this->assertTrue($this->seEnvio('GET', 'reportes/kardex', fn (Request $p) => str_contains($p->url(), 'id_producto=1') && str_contains($p->url(), 'tipo=SALIDA')
            && str_contains($p->url(), 'id_usuario=1') && str_contains($p->url(), 'fecha_desde=2026-11-01') && str_contains($p->url(), 'fecha_hasta=2026-11-30')));
    }

    public function test_el_contador_no_ve_el_filtro_de_usuarios_ni_los_pide(): void
    {
        $this->gatewayDeReportes();

        $this->conSesion('CONTADOR')->get('/reportes/kardex')->assertOk()->assertDontSee('Todos los usuarios');
        $this->assertFalse($this->seEnvio('GET', 'usuarios'));
    }

    public function test_si_el_kardex_tarda_demasiado_se_sugiere_acotarlo(): void
    {
        $this->gatewayDeReportes(['GET reportes/kardex' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->get('/reportes/kardex')->assertOk()
            ->assertSee('No pudimos generar el kardex')->assertSee('acota por producto, bodega o fechas');
    }

    public function test_el_kardex_rechaza_un_rango_de_fechas_al_reves_sin_llamar_al_servicio(): void
    {
        $this->gatewayDeReportes();

        $this->conSesion('ADMINISTRADOR')->from('/reportes/kardex')->get('/reportes/kardex?desde=2026-11-30&hasta=2026-11-01')
            ->assertRedirect('/reportes/kardex')->assertSessionHas('error');
        $this->assertFalse($this->seEnvio('GET', 'reportes/kardex'));
    }

    public function test_el_csv_se_entrega_tal_cual_con_su_tipo_y_su_nombre(): void
    {
        $csv = "\xEF\xBB\xBFproducto;cantidad\r\nCafé;40\r\n";
        $this->gatewayDeReportes(['GET reportes/kardex' => Http::response($csv, 200, ['Content-Type' => 'text/csv; charset=utf-8', 'Content-Disposition' => 'attachment; filename="kardex-2026-11-16.csv"'])]);

        $respuesta = $this->conSesion('CONTADOR')->get('/reportes/kardex?bodega=1&formato=csv')->assertOk();

        $this->assertSame($csv, $respuesta->getContent(), 'incluye la marca BOM y la tilde');
        $respuesta->assertHeader('Content-Disposition', 'attachment; filename="kardex-2026-11-16.csv"');
        $this->assertStringStartsWith('text/csv', $respuesta->headers->get('Content-Type'));
        $this->assertTrue($this->seEnvio('GET', 'reportes/kardex', fn (Request $p) => str_contains($p->url(), 'formato=csv') && str_contains($p->url(), 'id_bodega=1') && $p->header('Accept') === ['*/*']));
    }

    public function test_el_pdf_viaja_como_bytes_sin_alterarse(): void
    {
        $pdf = "%PDF-1.4\n\x00\xFF\xFE binario \xC3\x28";
        $this->gatewayDeReportes(['GET reportes/existencias' => Http::response($pdf, 200, ['Content-Type' => 'application/pdf', 'Content-Disposition' => 'attachment; filename="existencias.pdf"'])]);

        $respuesta = $this->conSesion('ADMINISTRADOR')->get('/reportes/existencias?formato=pdf')->assertOk();

        $this->assertSame(hash('sha256', $pdf), hash('sha256', $respuesta->getContent()));
        $respuesta->assertHeader('Content-Type', 'application/pdf');
    }

    public function test_si_el_archivo_no_se_alcanza_a_generar_se_explica_como_acotarlo(): void
    {
        $this->gatewayDeReportes(['GET reportes/kardex' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('CONTADOR')->from('/reportes/kardex')->get('/reportes/kardex?formato=pdf')->assertRedirect('/reportes/kardex')
            ->assertSessionHas('error', fn ($m) => str_contains($m, 'más acotados'));
    }

    public function test_un_formato_que_no_existe_se_ignora_y_se_muestra_la_pantalla(): void
    {
        $this->gatewayDeReportes();

        $this->conSesion('CONTADOR')->get('/reportes/existencias?formato=exe')->assertOk()->assertSee('Descargar CSV');
        $this->assertFalse($this->seEnvio('GET', 'reportes/existencias', fn (Request $p) => str_contains($p->url(), 'formato=exe')));
    }

    public function test_el_administrador_encuentra_los_reportes_en_mas_y_el_contador_en_su_menu(): void
    {
        $this->gatewayDeReportes();

        $this->conSesion('ADMINISTRADOR')->get('/administrar')->assertOk()->assertSee('Reportes y auditoría')->assertSee(route('reportes.index'));
        $this->conSesion('CONTADOR')->get('/')->assertSee(route('reportes.index'));
    }
}
