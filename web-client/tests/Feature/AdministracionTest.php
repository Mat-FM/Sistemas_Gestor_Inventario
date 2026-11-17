<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class AdministracionTest extends TestCase
{
    private const RUTAS_DE_LECTURA = [
        '/administrar', '/productos', '/productos/nuevo', '/productos/1/editar', '/categorias', '/categorias/1/editar',
        '/proveedores', '/proveedores/nuevo', '/proveedores/1', '/proveedores/1/editar', '/bodegas', '/bodegas/nuevo', '/bodegas/1/editar',
        '/umbrales', '/usuarios', '/usuarios/nuevo', '/usuarios/2/editar',
    ];

    private function gatewayDeAdministracion(array $mas = []): void
    {
        $producto = ['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'descripcion' => null, 'id_categoria' => 1, 'unidad_medida' => 'UNIDAD', 'precio' => 18500.5, 'estado' => 'ACTIVO'];
        $this->fingirGateway($mas + [
            'GET categorias' => Http::response([['id_categoria' => 1, 'nombre' => 'Bebidas', 'descripcion' => null, 'id_categoria_padre' => null, 'subcategorias' => [['id_categoria' => 3, 'nombre' => 'Jugos', 'descripcion' => null, 'id_categoria_padre' => 1]]]]),
            'GET categorias/1' => Http::response(['id_categoria' => 1, 'nombre' => 'Bebidas', 'descripcion' => null, 'id_categoria_padre' => null]),
            'GET productos' => self::listado([$producto]),
            'GET productos/1' => Http::response($producto),
            'GET proveedores' => self::listado([['id_proveedor' => 1, 'nit' => '900-1', 'razon_social' => 'Distribuidora Café', 'nombre_contacto' => 'Ana', 'telefono' => '300', 'correo' => 'a@b.co', 'direccion' => 'Cra 1', 'estado' => 'ACTIVO']]),
            'GET proveedores/1' => Http::response(['id_proveedor' => 1, 'nit' => '900-1', 'razon_social' => 'Distribuidora Café', 'nombre_contacto' => 'Ana', 'telefono' => '300', 'correo' => 'a@b.co', 'direccion' => 'Cra 1', 'estado' => 'ACTIVO']),
            'GET proveedores/1/productos' => Http::response([['id_proveedor_producto' => 1, 'id_producto' => 1, 'fecha_asociacion' => '2026-11-16T10:00:00Z']]),
            'GET bodegas' => self::bodegas(),
            'GET bodegas/1' => Http::response(['id_bodega' => 1, 'codigo' => 'B1', 'nombre' => 'Bodega Centro', 'ciudad' => 'Manizales', 'direccion' => 'Calle 1', 'activa' => true]),
            'GET umbrales' => self::listado([['id_producto' => 1, 'cantidad_minima' => 80, 'fecha_actualizacion' => '2026-11-16T10:00:00Z']]),
            'GET usuarios' => self::listado([['id_usuario' => 7, 'nombre' => 'Ana María Pérez', 'correo' => 'ana@x.co', 'id_rol' => 1, 'rol' => 'ADMINISTRADOR', 'id_bodega' => null, 'activo' => true, 'debe_cambiar_contrasena' => false]]),
            'GET usuarios/2' => Http::response(['id_usuario' => 2, 'nombre' => 'Omar', 'correo' => 'omar@x.co', 'id_rol' => 2, 'rol' => 'OPERADOR_BODEGA', 'id_bodega' => 1, 'activo' => true, 'debe_cambiar_contrasena' => false]),
            'GET roles' => Http::response(['datos' => [['id_rol' => 1, 'nombre' => 'ADMINISTRADOR'], ['id_rol' => 2, 'nombre' => 'OPERADOR_BODEGA'], ['id_rol' => 3, 'nombre' => 'VENDEDOR']]]),
        ]);
    }

    public function test_todas_las_pantallas_de_administracion_abren_para_el_administrador(): void
    {
        $this->gatewayDeAdministracion();

        foreach (self::RUTAS_DE_LECTURA as $ruta) {
            $this->conSesion('ADMINISTRADOR')->get($ruta)->assertOk();
        }
    }

    public function test_ningun_otro_rol_llega_a_la_administracion_ni_la_ve_en_su_menu(): void
    {
        $this->gatewayDeAdministracion();

        foreach (['OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'] as $rol) {
            foreach (self::RUTAS_DE_LECTURA as $ruta) {
                $this->conSesion($rol, 1)->get($ruta)->assertForbidden();
            }
            foreach ([['post', '/productos'], ['put', '/productos/1'], ['post', '/productos/1/inactivar'], ['post', '/usuarios'], ['post', '/usuarios/2/restablecer-contrasena'],
                ['delete', '/categorias/1'], ['put', '/umbrales/1'], ['post', '/bodegas'], ['post', '/proveedores/1/productos']] as [$metodo, $ruta]) {
                $this->conSesion($rol, 1)->{$metodo}($ruta, [])->assertForbidden();
            }
        }
        $this->assertFalse($this->seEnvio('POST', 'productos'));

        $this->conSesion('OPERADOR_BODEGA', 1)->get('/')->assertDontSee('Administración')->assertDontSee('Administrar');
        $this->conSesion('ADMINISTRADOR')->get('/administrar')->assertSee('Administración')->assertSee('Stock mínimo')->assertSee(route('usuarios.index'));
    }

    // ---------- Productos ----------

    public function test_crear_un_producto_normaliza_el_precio_y_no_manda_campos_vacios(): void
    {
        $this->gatewayDeAdministracion(['POST productos' => Http::response(['id_producto' => 9, 'nombre' => 'Aceite 1 L'], 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/productos', [
            'codigo' => ' ACE-1L ', 'nombre' => 'Aceite 1 L', 'descripcion' => '', 'id_categoria' => '1', 'unidad_medida' => 'LITRO', 'precio' => '11.900,50',
        ])->assertRedirect('/productos')->assertSessionHas('exito', 'Producto «Aceite 1 L» creado.');

        $this->assertTrue($this->seEnvio('POST', 'productos', fn (Request $p) => $p->data() === [
            'codigo' => 'ACE-1L', 'nombre' => 'Aceite 1 L', 'id_categoria' => 1, 'unidad_medida' => 'LITRO', 'precio' => 11900.5,
        ]));
    }

    public function test_los_errores_de_un_producto_se_dicen_en_espanol_antes_de_llamar_al_servicio(): void
    {
        $this->gatewayDeAdministracion();

        $this->conSesion('ADMINISTRADOR')->from('/productos/nuevo')->post('/productos', ['precio' => 'mucho'])
            ->assertSessionHasErrors([
                'codigo' => 'Escribe el código del producto.', 'nombre' => 'Escribe el nombre.', 'id_categoria' => 'Elige la categoría.',
                'unidad_medida' => 'Escribe la unidad de medida (por ejemplo UNIDAD o KG).',
                'precio' => 'El precio debe ser un número (por ejemplo 18.500 o 18500,50).',
            ]);
        $this->assertFalse($this->seEnvio('POST', 'productos'));
    }

    public function test_un_codigo_repetido_se_muestra_junto_al_campo_y_se_conserva_lo_escrito(): void
    {
        $this->gatewayDeAdministracion(['POST productos' => self::error(409, 'CODIGO_DUPLICADO', 'Ya existe un producto con ese código.')]);

        $this->conSesion('ADMINISTRADOR')->from('/productos/nuevo')->post('/productos', [
            'codigo' => 'CAF-500', 'nombre' => 'Otro café', 'id_categoria' => '1', 'unidad_medida' => 'UNIDAD', 'precio' => '1000',
        ])->assertRedirect('/productos/nuevo')->assertSessionHasErrors(['codigo' => 'Ya existe un producto con ese código.']);

        $this->assertSame('Otro café', session()->getOldInput('nombre'));
    }

    public function test_editar_un_producto_no_envia_el_codigo_y_olvida_su_nombre_guardado(): void
    {
        $this->gatewayDeAdministracion(['PUT productos/1' => Http::response(['id_producto' => 1, 'nombre' => 'Café molido 500 g (nuevo)'])]);

        $this->conSesion('ADMINISTRADOR')->put('/productos/1', [
            'codigo' => 'CAMBIADO', 'nombre' => 'Café molido 500 g (nuevo)', 'id_categoria' => '1', 'unidad_medida' => 'UNIDAD', 'precio' => '18500,5', 'descripcion' => 'De Caldas',
        ])->assertRedirect('/productos');

        $this->assertTrue($this->seEnvio('PUT', 'productos/1', fn (Request $p) => ! isset($p->data()['codigo']) && $p['precio'] === 18500.5 && $p['descripcion'] === 'De Caldas'));
    }

    public function test_inactivar_un_producto_avisa_que_ya_no_se_usara_en_movimientos(): void
    {
        $this->gatewayDeAdministracion(['POST productos/1/inactivar' => Http::response(['id_producto' => 1, 'nombre' => 'Café molido 500 g', 'estado' => 'INACTIVO'])]);

        $this->conSesion('ADMINISTRADOR')->post('/productos/1/inactivar')->assertSessionHas('exito', fn ($m) => str_contains($m, 'quedó inactivo'));
    }

    public function test_buscar_productos_une_nombre_y_codigo_sin_repetir(): void
    {
        $this->gatewayDeAdministracion();

        $this->conSesion('ADMINISTRADOR')->get('/productos?q=caf&estado=INACTIVO')->assertOk()->assertSee('Café molido 500 g');
        $this->assertTrue($this->seEnvio('GET', 'productos', fn (Request $p) => str_contains($p->url(), 'nombre=caf') && str_contains($p->url(), 'estado=INACTIVO')));
        $this->assertTrue($this->seEnvio('GET', 'productos', fn (Request $p) => str_contains($p->url(), 'codigo=caf')));
    }

    // ---------- Categorías ----------

    public function test_crear_una_categoria_dentro_de_otra_y_el_arbol_muestra_las_hijas(): void
    {
        $this->gatewayDeAdministracion(['POST categorias' => Http::response(['id_categoria' => 5, 'nombre' => 'Gaseosas'], 201)]);

        $this->conSesion('ADMINISTRADOR')->get('/categorias')->assertOk()->assertSee('Bebidas')->assertSee('Jugos');
        $this->conSesion('ADMINISTRADOR')->post('/categorias', ['nombre' => 'Gaseosas', 'id_categoria_padre' => '1'])->assertRedirect('/categorias');

        $this->assertTrue($this->seEnvio('POST', 'categorias', fn (Request $p) => $p->data() === ['nombre' => 'Gaseosas', 'id_categoria_padre' => 1]));
    }

    public function test_eliminar_una_categoria_en_uso_explica_que_hacer(): void
    {
        $this->gatewayDeAdministracion(['DELETE categorias/1' => self::error(409, 'CATEGORIA_EN_USO')]);

        $this->conSesion('ADMINISTRADOR')->delete('/categorias/1')->assertSessionHas('error', fn ($m) => str_contains($m, 'Muévelos primero'));
    }

    // ---------- Proveedores ----------

    public function test_crear_un_proveedor_valida_en_espanol_y_lleva_a_su_ficha(): void
    {
        $this->gatewayDeAdministracion(['POST proveedores' => Http::response(['id_proveedor' => 4], 201)]);

        $this->conSesion('ADMINISTRADOR')->from('/proveedores/nuevo')->post('/proveedores', ['nit' => '900-2', 'correo' => 'no es correo'])
            ->assertSessionHasErrors(['razon_social' => 'Escribe la razón social.', 'correo' => 'Escribe un correo válido, por ejemplo ventas@proveedor.com.']);

        $this->conSesion('ADMINISTRADOR')->post('/proveedores', [
            'nit' => '900-2', 'razon_social' => 'Nuevo S.A.S.', 'nombre_contacto' => 'Luis', 'telefono' => '300', 'correo' => 'luis@n.co', 'direccion' => 'Cra 2',
        ])->assertRedirect('/proveedores/4');
    }

    public function test_un_nit_repetido_se_muestra_junto_al_campo(): void
    {
        $this->gatewayDeAdministracion(['POST proveedores' => self::error(409, 'NIT_DUPLICADO', 'Ya existe un proveedor con ese NIT.')]);

        $this->conSesion('ADMINISTRADOR')->from('/proveedores/nuevo')->post('/proveedores', [
            'nit' => '900-1', 'razon_social' => 'X', 'nombre_contacto' => 'Y', 'telefono' => '1', 'correo' => 'x@y.co', 'direccion' => 'Z',
        ])->assertSessionHasErrors(['nit' => 'Ya existe un proveedor con ese NIT.']);
    }

    public function test_la_ficha_del_proveedor_muestra_sus_productos_con_nombre_y_no_ofrece_los_ya_asociados(): void
    {
        $this->gatewayDeAdministracion(['GET productos' => self::listado([
            ['id_producto' => 1, 'codigo' => 'CAF-500', 'nombre' => 'Café molido 500 g', 'unidad_medida' => 'UNIDAD'],
            ['id_producto' => 2, 'codigo' => 'CAF-1K', 'nombre' => 'Café 1 kg', 'unidad_medida' => 'UNIDAD'],
        ])]);

        $html = $this->conSesion('ADMINISTRADOR')->get('/proveedores/1?q=caf')->assertOk()->assertSee('Distribuidora Café')->getContent();

        $this->assertSame(1, substr_count($html, 'name="id_producto" value="2"'));
        $this->assertSame(0, substr_count($html, 'name="id_producto" value="1"'));
    }

    public function test_asociar_dos_veces_el_mismo_producto_no_es_un_error_para_el_usuario(): void
    {
        $this->gatewayDeAdministracion(['POST proveedores/1/productos' => self::error(409, 'PRODUCTO_YA_ASOCIADO')]);

        $this->conSesion('ADMINISTRADOR')->post('/proveedores/1/productos', ['id_producto' => 2])->assertSessionHas('aviso', 'Ese producto ya estaba asociado.');
    }

    public function test_quitar_un_producto_del_proveedor(): void
    {
        $this->gatewayDeAdministracion(['DELETE proveedores/1/productos/2' => Http::response('', 204)]);

        $this->conSesion('ADMINISTRADOR')->delete('/proveedores/1/productos/2')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('DELETE', 'proveedores/1/productos/2'));
    }

    // ---------- Bodegas ----------

    public function test_crear_una_bodega_actualiza_las_listas_de_bodegas_que_se_guardan_en_cache(): void
    {
        $this->gatewayDeAdministracion(['POST bodegas' => Http::response(['id_bodega' => 3, 'nombre' => 'Bodega Sur'], 201)]);
        cache()->put('bodegas', ['viejo'], 300);

        $this->conSesion('ADMINISTRADOR')->post('/bodegas', ['codigo' => 'B3', 'nombre' => 'Bodega Sur', 'ciudad' => 'Manizales', 'direccion' => 'Cra 3'])->assertRedirect('/bodegas');

        $this->assertNull(cache()->get('bodegas'));
    }

    public function test_una_bodega_que_no_se_puede_inactivar_explica_por_que(): void
    {
        $this->gatewayDeAdministracion(['POST bodegas/1/inactivar' => self::error(409, 'CONFLICTO', 'La bodega tiene saldo.')]);

        $this->conSesion('ADMINISTRADOR')->post('/bodegas/1/inactivar')->assertSessionHas('error', 'La bodega tiene saldo.');
    }

    // ---------- Stock mínimo ----------

    public function test_guardar_el_minimo_acepta_miles_con_punto_y_confirma_con_el_nombre(): void
    {
        $this->gatewayDeAdministracion(['PUT umbrales/1' => Http::response(['id_producto' => 1, 'cantidad_minima' => 1200])]);

        $this->conSesion('ADMINISTRADOR')->put('/umbrales/1', ['cantidad_minima' => '1.200'])
            ->assertRedirect('/umbrales')->assertSessionHas('exito', 'Listo: avisaremos cuando «Café molido 500 g» baje de 1.200.');
        $this->assertTrue($this->seEnvio('PUT', 'umbrales/1', fn (Request $p) => $p->data() === ['cantidad_minima' => 1200]));
    }

    public function test_un_minimo_con_decimales_o_negativo_se_rechaza_sin_llamar_al_servicio(): void
    {
        $this->gatewayDeAdministracion();

        foreach (['2,5', '-3', ''] as $valor) {
            $this->conSesion('ADMINISTRADOR')->from('/umbrales')->put('/umbrales/1', ['cantidad_minima' => $valor])->assertSessionHasErrors('cantidad_minima');
        }
        $this->assertFalse($this->seEnvio('PUT', 'umbrales/1'));
    }

    // ---------- Usuarios ----------

    private function usuarioNuevo(array $campos = []): array
    {
        return $campos + ['nombre' => 'Luis Norte', 'correo' => ' Luis.Norte@E2E.test ', 'id_rol' => '2', 'id_bodega' => '2', 'contrasena_temporal' => 'Temporal123'];
    }

    public function test_crear_un_operador_exige_bodega_y_manda_el_correo_en_minusculas(): void
    {
        $this->gatewayDeAdministracion(['POST usuarios' => Http::response(['id_usuario' => 8, 'nombre' => 'Luis Norte'], 201)]);

        $this->conSesion('ADMINISTRADOR')->from('/usuarios/nuevo')->post('/usuarios', $this->usuarioNuevo(['id_bodega' => '']))
            ->assertSessionHasErrors(['id_bodega' => 'Un operador de bodega necesita una bodega asignada.']);
        $this->assertFalse($this->seEnvio('POST', 'usuarios'));

        $this->conSesion('ADMINISTRADOR')->post('/usuarios', $this->usuarioNuevo())->assertRedirect('/usuarios');
        $this->assertTrue($this->seEnvio('POST', 'usuarios', fn (Request $p) => $p->data() === [
            'nombre' => 'Luis Norte', 'correo' => 'luis.norte@e2e.test', 'id_rol' => 2, 'id_bodega' => 2, 'contrasena_temporal' => 'Temporal123',
        ]));
    }

    public function test_un_rol_que_no_es_operador_no_manda_bodega_aunque_el_formulario_la_traiga(): void
    {
        $this->gatewayDeAdministracion(['POST usuarios' => Http::response(['id_usuario' => 8, 'nombre' => 'Vera'], 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/usuarios', $this->usuarioNuevo(['id_rol' => '3', 'id_bodega' => '2']))->assertRedirect('/usuarios');
        $this->assertTrue($this->seEnvio('POST', 'usuarios', fn (Request $p) => $p->data()['id_bodega'] === null && $p['id_rol'] === 3));
    }

    public function test_la_contrasena_temporal_debe_cumplir_la_politica_y_nunca_vuelve_a_la_pantalla(): void
    {
        $this->gatewayDeAdministracion(['POST usuarios' => self::error(409, 'CORREO_DUPLICADO', 'Ya existe un usuario con ese correo.')]);

        $this->conSesion('ADMINISTRADOR')->from('/usuarios/nuevo')->post('/usuarios', $this->usuarioNuevo(['contrasena_temporal' => 'corta']))
            ->assertSessionHasErrors('contrasena_temporal');

        $this->conSesion('ADMINISTRADOR')->from('/usuarios/nuevo')->post('/usuarios', $this->usuarioNuevo())
            ->assertSessionHasErrors(['correo' => 'Ya existe un usuario con ese correo.']);
        $this->assertNull(session()->getOldInput('contrasena_temporal'));
        $this->assertSame('Luis Norte', session()->getOldInput('nombre'));
    }

    public function test_el_administrador_no_puede_inactivarse_a_si_mismo(): void
    {
        $this->gatewayDeAdministracion([
            'POST usuarios/2/inactivar' => Http::response(['id_usuario' => 2, 'nombre' => 'Omar', 'activo' => false]),
            'GET usuarios/7' => Http::response(['id_usuario' => 7, 'nombre' => 'Ana María Pérez', 'correo' => 'ana@x.co', 'id_rol' => 1, 'rol' => 'ADMINISTRADOR', 'id_bodega' => null, 'activo' => true, 'debe_cambiar_contrasena' => false]),
        ]);

        $this->conSesion('ADMINISTRADOR')->post('/usuarios/7/inactivar')->assertSessionHas('error', 'No puedes inactivar tu propio usuario.');
        $this->assertFalse($this->seEnvio('POST', 'usuarios/7/inactivar'));

        $this->conSesion('ADMINISTRADOR')->post('/usuarios/2/inactivar')->assertSessionHas('exito');
        $this->conSesion('ADMINISTRADOR')->get('/usuarios')->assertSee('Tú');
        // En su propia ficha no se ofrece darse de baja; en la de otro usuario sí.
        $this->conSesion('ADMINISTRADOR')->get('/usuarios/7/editar')->assertOk()->assertDontSee('Inactivar usuario');
        $this->conSesion('ADMINISTRADOR')->get('/usuarios/2/editar')->assertOk()->assertSee('Inactivar usuario');
    }

    public function test_restablecer_la_contrasena_envia_la_temporal_y_no_la_guarda_en_la_sesion(): void
    {
        $this->gatewayDeAdministracion(['POST usuarios/2/restablecer-contrasena' => Http::response('', 204)]);

        $this->conSesion('ADMINISTRADOR')->post('/usuarios/2/restablecer-contrasena', ['contrasena_temporal' => 'Otra12345'])
            ->assertRedirect('/usuarios/2/editar')->assertSessionHas('exito');
        $this->assertTrue($this->seEnvio('POST', 'usuarios/2/restablecer-contrasena', fn (Request $p) => $p->data() === ['contrasena_temporal' => 'Otra12345']));

        $this->conSesion('ADMINISTRADOR')->from('/usuarios/2/editar')->post('/usuarios/2/restablecer-contrasena', ['contrasena_temporal' => 'sinnumeros'])
            ->assertSessionHasErrors('contrasena_temporal');
        $this->assertNull(session()->getOldInput('contrasena_temporal'));
    }
}
