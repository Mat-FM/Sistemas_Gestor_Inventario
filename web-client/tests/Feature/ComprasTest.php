<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ComprasTest extends TestCase
{
    private function orden(array $campos = []): array
    {
        return $campos + [
            'id_orden' => 1, 'numero' => 'OC-0001', 'estado' => 'ENVIADA', 'id_proveedor' => 1, 'id_bodega_destino' => 1, 'id_usuario' => 1,
            'fecha_creacion' => '2026-11-17T00:42:00Z', 'fecha_esperada' => '2026-12-10', 'total' => 325000,
            'detalles' => [
                ['id_detalle' => 1, 'id_producto' => 1, 'cantidad_pedida' => 20, 'cantidad_recibida' => 8, 'precio_unitario' => 15000, 'subtotal' => 300000],
                ['id_detalle' => 2, 'id_producto' => 2, 'cantidad_pedida' => 10, 'cantidad_recibida' => 0, 'precio_unitario' => 2500, 'subtotal' => 25000],
            ],
            'recepciones' => [['id_recepcion' => 1, 'id_detalle' => 1, 'id_producto' => 1, 'cantidad' => 8, 'codigo_lote' => 'L-D1', 'fecha_vencimiento' => '2027-05-01', 'fecha' => '2026-11-17T00:42:00Z', 'id_usuario' => 1, 'id_movimiento' => 1591]],
        ];
    }

    private function gatewayDeCompras(array $mas = []): void
    {
        $this->fingirGateway($mas + [
            'GET ordenes-compra' => self::listado([['id_orden' => 1, 'numero' => 'OC-0001', 'estado' => 'ENVIADA', 'id_proveedor' => 1, 'id_bodega_destino' => 1, 'fecha_esperada' => '2026-12-10', 'total' => 325000]]),
            'GET ordenes-compra/1' => Http::response($this->orden()),
            'GET proveedores/1' => Http::response(['id_proveedor' => 1, 'razon_social' => 'Distribuidora Café', 'estado' => 'ACTIVO']),
            'GET productos/1' => self::producto(1, 'Café molido 500 g'),
            'GET productos/2' => self::producto(2, 'Panela redonda'),
            'GET bodegas' => self::bodegas(),
        ]);
    }

    // ---------- Lista ----------

    public function test_la_lista_muestra_proveedor_y_bodega_por_nombre_con_el_estado_en_espanol(): void
    {
        $this->gatewayDeCompras();

        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes')->assertOk()
            ->assertSee('OC-0001 · Distribuidora Café')->assertSee('Llega a Bodega Centro')->assertSee('$ 325.000')->assertSee('Enviada')
            ->assertSee('Nueva orden');
    }

    public function test_un_operador_ve_por_defecto_las_ordenes_de_su_bodega_y_puede_ver_las_demas(): void
    {
        $this->gatewayDeCompras();

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/compras/ordenes')->assertOk()->assertDontSee('Nueva orden');
        $this->assertTrue($this->seEnvio('GET', 'ordenes-compra', fn (Request $p) => str_contains($p->url(), 'id_bodega_destino=1')));

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/compras/ordenes?todas=1');
        $this->assertTrue($this->seEnvio('GET', 'ordenes-compra', fn (Request $p) => ! str_contains($p->url(), 'id_bodega_destino')));
    }

    // ---------- Ficha y recepción ----------

    public function test_el_administrador_y_el_operador_de_la_bodega_destino_pueden_recibir_y_el_de_otra_bodega_no(): void
    {
        $this->gatewayDeCompras();

        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes/1')->assertOk()->assertSee('Recibir mercancía')->assertSee('Faltan 12 de 20')
            ->assertSee('Café molido 500 g')->assertSee('lote L-D1')->assertDontSee('Anular');   // ya tiene mercancía recibida
        $this->gatewayDeCompras(['GET ordenes-compra/1' => Http::response($this->orden(['recepciones' => []]))]);
        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes/1')->assertSee('Anular');
        $this->conSesion('OPERADOR_BODEGA', 1)->get('/compras/ordenes/1')->assertOk()->assertSee('Recibir mercancía')->assertDontSee('Anular')->assertDontSee('Marcar como enviada');
        $this->conSesion('OPERADOR_BODEGA', 2)->get('/compras/ordenes/1')->assertOk()->assertDontSee('Recibir mercancía')->assertSee('llega a otra bodega');
    }

    public function test_una_orden_creada_se_puede_enviar_y_anular_y_una_recibida_a_medias_no_se_anula(): void
    {
        $this->gatewayDeCompras(['GET ordenes-compra/1' => Http::response($this->orden(['estado' => 'CREADA', 'recepciones' => []]))]);
        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes/1')->assertSee('Marcar como enviada')->assertSee('Anular')->assertDontSee('Recibir mercancía');

        $this->gatewayDeCompras(['GET ordenes-compra/1' => Http::response($this->orden(['estado' => 'RECIBIDA_PARCIAL']))]);
        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes/1')->assertSee('Recibir mercancía')->assertDontSee('Anular');

        $this->gatewayDeCompras(['GET ordenes-compra/1' => Http::response($this->orden(['estado' => 'RECIBIDA']))]);
        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes/1')->assertDontSee('Recibir mercancía')->assertDontSee('Anular');
    }

    public function test_recibir_manda_solo_las_lineas_con_cantidad_con_la_clave_y_el_lote_completo(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra/1/recepciones' => Http::response(['id_orden' => 1, 'estado' => 'RECIBIDA_PARCIAL'], 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/compras/ordenes/1/recepciones', [
            'clave' => 'rec-1',
            'lineas' => [1 => ['cantidad' => '4', 'codigo_lote' => 'L-X', 'fecha_vencimiento' => '2027-06-30'], 2 => ['cantidad' => '', 'codigo_lote' => '', 'fecha_vencimiento' => '']],
        ])->assertRedirect('/compras/ordenes/1')->assertSessionHas('exito', fn ($m) => str_contains($m, 'La orden sigue abierta'));

        $this->assertTrue($this->seEnvio('POST', 'ordenes-compra/1/recepciones', fn (Request $p) => $p->header('Idempotency-Key') === ['rec-1']
            && $p->data() === ['lineas' => [['id_detalle' => 1, 'cantidad' => 4, 'codigo_lote' => 'L-X', 'fecha_vencimiento' => '2027-06-30']]]));
    }

    public function test_una_recepcion_completa_lo_dice(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra/1/recepciones' => Http::response(['id_orden' => 1, 'estado' => 'RECIBIDA'], 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-2', 'lineas' => [2 => ['cantidad' => '10']]])
            ->assertSessionHas('exito', fn ($m) => str_contains($m, 'quedó completa'));
    }

    public function test_el_lote_y_su_vencimiento_van_juntos_y_la_cantidad_debe_ser_entera_sin_llamar_al_servicio(): void
    {
        $this->gatewayDeCompras();

        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-3', 'lineas' => [1 => ['cantidad' => '4', 'codigo_lote' => 'L-X', 'fecha_vencimiento' => '']]])
            ->assertSessionHasErrors('lineas.1.codigo_lote');
        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-3', 'lineas' => [1 => ['cantidad' => '2,5']]])
            ->assertSessionHasErrors('lineas.1.cantidad');
        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-3', 'lineas' => [1 => ['cantidad' => '']]])
            ->assertSessionHasErrors('lineas');
        $this->assertFalse($this->seEnvio('POST', 'ordenes-compra/1/recepciones'));
    }

    public function test_si_algunas_lineas_fallan_la_clave_se_conserva_para_completar_solo_las_que_faltan(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra/1/recepciones' => self::error(409, 'CONFLICTO', 'Algunas líneas no se pudieron registrar.', [
            ['id_detalle' => 2, 'codigo' => 'CONFLICTO', 'mensaje' => 'El lote ya existe con otro vencimiento.'],
        ])]);

        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-4', 'lineas' => [1 => ['cantidad' => '4'], 2 => ['cantidad' => '3']]])
            ->assertRedirect('/compras/ordenes/1')
            ->assertSessionHas('error', fn ($m) => str_contains($m, '«Panela redonda»: El lote ya existe con otro vencimiento.') && str_contains($m, 'no se repite'));
        $this->assertSame('rec-4', session()->getOldInput('clave'));
    }

    public function test_un_rechazo_antes_de_registrar_nada_descarta_la_clave(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra/1/recepciones' => self::error(422, 'DATOS_INVALIDOS', '', [['campo' => 'lineas[0].cantidad', 'mensaje' => 'Supera la cantidad pendiente (12).']])]);

        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-5', 'lineas' => [1 => ['cantidad' => '99']]])
            ->assertSessionHas('error', fn ($m) => str_contains($m, 'Supera la cantidad pendiente (12).'));
        $this->assertNull(session()->getOldInput('clave'));
    }

    public function test_si_el_gateway_no_responde_la_clave_se_conserva(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra/1/recepciones' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-6', 'lineas' => [1 => ['cantidad' => '4']]])
            ->assertSessionHas('error', fn ($m) => str_contains($m, 'no se repite'));
        $this->assertSame('rec-6', session()->getOldInput('clave'));
    }

    public function test_un_operador_de_otra_bodega_recibe_un_mensaje_claro_y_no_un_error(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra/1/recepciones' => self::error(403, 'SIN_PERMISO', 'Solo puede operar sobre la bodega que tiene asignada.')]);

        $this->conSesion('OPERADOR_BODEGA', 2)->from('/compras/ordenes/1')->post('/compras/ordenes/1/recepciones', ['clave' => 'rec-7', 'lineas' => [1 => ['cantidad' => '4']]])
            ->assertSessionHas('error', 'Solo puedes recibir en tu propia bodega.');
    }

    // ---------- Crear, enviar y anular ----------

    private function formularioDeOrden(array $campos = []): array
    {
        return $campos + [
            'id_proveedor' => '1', 'id_bodega_destino' => '2', 'fecha_esperada' => now()->addDays(10)->toDateString(),
            'lineas' => [0 => ['id_producto' => '1', 'cantidad' => '1.000', 'precio' => '15.000,50'], 1 => ['id_producto' => '', 'cantidad' => '', 'precio' => '']],
        ];
    }

    public function test_crear_una_orden_ignora_las_lineas_vacias_y_normaliza_cantidades_y_precios(): void
    {
        $this->gatewayDeCompras(['POST ordenes-compra' => Http::response(['id_orden' => 5, 'numero' => 'OC-0005'], 201)]);
        $formulario = $this->formularioDeOrden();

        $this->conSesion('ADMINISTRADOR')->post('/compras/ordenes', $formulario)->assertRedirect('/compras/ordenes/5')->assertSessionHas('exito', fn ($m) => str_contains($m, 'OC-0005'));

        $this->assertTrue($this->seEnvio('POST', 'ordenes-compra', fn (Request $p) => $p->data() === [
            'id_proveedor' => 1, 'id_bodega_destino' => 2, 'fecha_esperada' => $formulario['fecha_esperada'],
            'detalles' => [['id_producto' => 1, 'cantidad_pedida' => 1000, 'precio_unitario' => 15000.5]],
        ]));
    }

    public function test_una_orden_sin_productos_o_con_fecha_pasada_se_rechaza_en_espanol(): void
    {
        $this->gatewayDeCompras();

        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/nuevo')->post('/compras/ordenes', $this->formularioDeOrden(['lineas' => [0 => ['id_producto' => '', 'cantidad' => '', 'precio' => '']]]))
            ->assertSessionHasErrors(['lineas' => 'Agrega al menos un producto a la orden.']);
        $this->conSesion('ADMINISTRADOR')->from('/compras/ordenes/nuevo')->post('/compras/ordenes', $this->formularioDeOrden(['fecha_esperada' => '2020-01-01', 'id_proveedor' => '']))
            ->assertSessionHasErrors(['fecha_esperada' => 'La fecha esperada no puede ser anterior a hoy.', 'id_proveedor' => 'Elige el proveedor.']);
        $this->assertFalse($this->seEnvio('POST', 'ordenes-compra'));
    }

    public function test_el_formulario_de_orden_ofrece_proveedores_bodegas_y_productos_y_trae_la_plantilla_de_lineas(): void
    {
        $this->gatewayDeCompras([
            'GET proveedores' => self::listado([['id_proveedor' => 1, 'razon_social' => 'Distribuidora Café']]),
            'GET productos' => self::listado([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'precio' => 18500.5]]),
        ]);

        $this->conSesion('ADMINISTRADOR')->get('/compras/ordenes/nuevo')->assertOk()
            ->assertSee('Distribuidora Café')->assertSee('Bodega Norte')->assertSee('Café molido 500 g (CAF-500)')->assertSee('data-precio="18500,5"', false)
            ->assertSee('id="plantilla-linea"', false)->assertSee('name="lineas[__I__][id_producto]"', false);
    }

    public function test_los_formularios_de_compras_ofrecen_todos_los_productos_y_proveedores_aunque_pasen_de_100(): void
    {
        $productos = array_map(fn ($i) => ['id_producto' => $i, 'codigo' => "P$i", 'nombre' => "Producto $i", 'precio' => 1000], range(1, 250));
        $proveedores = array_map(fn ($i) => ['id_proveedor' => $i, 'razon_social' => "Proveedor $i"], range(1, 120));
        $this->gatewayDeCompras(['GET productos' => self::paginado($productos), 'GET proveedores' => self::paginado($proveedores)]);

        foreach (['/compras/ordenes/nuevo', '/compras/devoluciones/nuevo'] as $ruta) {
            $this->conSesion('ADMINISTRADOR')->get($ruta)->assertOk()->assertSee('Producto 250')->assertSee('Proveedor 120');
        }
        $this->assertTrue($this->seEnvio('GET', 'productos', fn (Request $p) => str_contains($p->url(), 'pagina=3') && str_contains($p->url(), 'estado=ACTIVO')));
    }

    public function test_enviar_y_anular_una_orden_y_un_cambio_que_ya_no_procede(): void
    {
        $this->gatewayDeCompras(['PATCH ordenes-compra/1/estado' => Http::response($this->orden(['estado' => 'ENVIADA']))]);
        $this->conSesion('ADMINISTRADOR')->post('/compras/ordenes/1/estado', ['estado' => 'ENVIADA'])->assertSessionHas('exito', fn ($m) => str_contains($m, 'enviada'));
        $this->assertTrue($this->seEnvio('PATCH', 'ordenes-compra/1/estado', fn (Request $p) => $p->data() === ['estado' => 'ENVIADA']));

        $this->gatewayDeCompras(['PATCH ordenes-compra/1/estado' => self::error(409, 'TRANSICION_INVALIDA')]);
        $this->conSesion('ADMINISTRADOR')->post('/compras/ordenes/1/estado', ['estado' => 'ANULADA'])->assertSessionHas('error', fn ($m) => str_contains($m, 'ya no admite ese cambio'));

        $this->conSesion('ADMINISTRADOR')->from('/x')->post('/compras/ordenes/1/estado', ['estado' => 'RECIBIDA'])->assertSessionHasErrors('estado');
    }

    public function test_el_operador_no_crea_ni_cambia_el_estado_de_las_ordenes(): void
    {
        $this->gatewayDeCompras();

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/compras/ordenes/nuevo')->assertForbidden();
        $this->conSesion('OPERADOR_BODEGA', 1)->post('/compras/ordenes', $this->formularioDeOrden())->assertForbidden();
        $this->conSesion('OPERADOR_BODEGA', 1)->post('/compras/ordenes/1/estado', ['estado' => 'ANULADA'])->assertForbidden();
        foreach (['VENDEDOR', 'CONTADOR'] as $rol) {
            $this->conSesion($rol)->get('/compras/ordenes')->assertForbidden();
            $this->conSesion($rol)->get('/compras/devoluciones')->assertForbidden();
        }
        $this->assertFalse($this->seEnvio('POST', 'ordenes-compra'));
    }

    // ---------- Devoluciones ----------

    public function test_el_listado_de_devoluciones_muestra_nombres_y_motivo(): void
    {
        $this->gatewayDeCompras(['GET devoluciones-proveedor' => self::listado([['id_devolucion' => 1, 'id_orden' => 1, 'id_proveedor' => 1, 'id_producto' => 1, 'id_bodega' => 1, 'cantidad' => 2, 'motivo' => 'Empaque roto', 'fecha' => '2026-11-17T00:42:00Z']])]);

        $this->conSesion('ADMINISTRADOR')->get('/compras/devoluciones')->assertOk()
            ->assertSee('Café molido 500 g × 2')->assertSee('Distribuidora Café')->assertSee('Bodega Centro')->assertSee('Motivo: Empaque roto');
    }

    public function test_devolver_manda_la_clave_la_bodega_del_operador_y_confirma(): void
    {
        $this->gatewayDeCompras(['POST devoluciones-proveedor' => Http::response(['id_devolucion' => 3], 201)]);

        $this->conSesion('OPERADOR_BODEGA', 2)->post('/compras/devoluciones', [
            'clave' => 'dev-1', 'id_proveedor' => '1', 'id_producto' => '1', 'id_bodega' => '1', 'cantidad' => '2', 'motivo' => ' Empaque roto ',
        ])->assertRedirect('/compras/devoluciones')->assertSessionHas('exito', fn ($m) => str_contains($m, 'salieron 2 × Café molido 500 g'));

        $this->assertTrue($this->seEnvio('POST', 'devoluciones-proveedor', fn (Request $p) => $p->header('Idempotency-Key') === ['dev-1']
            && $p->data() === ['id_proveedor' => 1, 'id_producto' => 1, 'id_bodega' => 2, 'cantidad' => 2, 'motivo' => 'Empaque roto']));
    }

    public function test_una_devolucion_sin_stock_dice_cuanto_hay_y_descarta_la_clave(): void
    {
        $this->gatewayDeCompras(['POST devoluciones-proveedor' => self::error(409, 'STOCK_INSUFICIENTE', 'No hay stock', [['campo' => 'cantidad', 'disponible' => 1, 'solicitado' => 5]])]);

        $this->conSesion('ADMINISTRADOR')->from('/compras/devoluciones/nuevo')->post('/compras/devoluciones', [
            'clave' => 'dev-2', 'id_proveedor' => '1', 'id_producto' => '1', 'id_bodega' => '1', 'cantidad' => '5', 'motivo' => 'Vencido',
        ])->assertSessionHasErrors(['cantidad' => 'No hay stock suficiente. Disponible: 1.']);
        $this->assertNull(session()->getOldInput('clave'));
    }

    public function test_una_devolucion_pide_motivo_y_entero_y_el_formulario_del_operador_fija_su_bodega(): void
    {
        $this->gatewayDeCompras([
            'GET proveedores' => self::listado([['id_proveedor' => 1, 'razon_social' => 'Distribuidora Café']]),
            'GET productos' => self::listado([['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g']]),
        ]);

        $this->conSesion('ADMINISTRADOR')->from('/compras/devoluciones/nuevo')->post('/compras/devoluciones', ['clave' => 'dev-3', 'id_proveedor' => '1', 'id_producto' => '1', 'id_bodega' => '1', 'cantidad' => '1,5'])
            ->assertSessionHasErrors(['motivo' => 'Cuenta por qué se devuelve (por ejemplo: empaque roto).', 'cantidad']);
        $this->assertFalse($this->seEnvio('POST', 'devoluciones-proveedor'));

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/compras/devoluciones/nuevo')->assertOk()->assertSee('Sale de la bodega')->assertSee('disabled', false);
        $this->conSesion('OPERADOR_BODEGA', null)->get('/compras/devoluciones/nuevo')->assertOk()->assertSee('Todavía no tienes una bodega');
    }
}
