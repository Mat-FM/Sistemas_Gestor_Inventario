<?php

namespace Tests\Feature;

use App\Models\Categoria;
use App\Models\Producto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * CRUD y búsqueda de productos (RF01, RF12, Tabla 7 de la Entrega 2). El filtro por proveedor está en
 * FiltroProveedorTest.
 */
class ProductosTest extends TestCase
{
    use RefreshDatabase;

    private Categoria $categoria;

    protected function setUp(): void
    {
        parent::setUp();
        $this->categoria = Categoria::create(['nombre' => 'Café']);
    }

    private function datos(string $codigo = 'CAF-500'): array
    {
        return [
            'codigo' => $codigo,
            'nombre' => 'Café molido 500 g',
            'descripcion' => 'Origen Caldas',
            'id_categoria' => $this->categoria->id_categoria,
            'unidad_medida' => 'UNIDAD',
            'precio' => 18500.5,
        ];
    }

    private function crearProducto(string $codigo, string $nombre, ?Categoria $categoria = null, string $estado = 'ACTIVO'): Producto
    {
        return Producto::create([
            'codigo' => $codigo, 'nombre' => $nombre, 'id_categoria' => ($categoria ?? $this->categoria)->id_categoria,
            'unidad_medida' => 'UNIDAD', 'precio' => 1000, 'estado' => $estado,
        ]);
    }

    public function test_crea_un_producto_en_estado_activo(): void
    {
        $respuesta = $this->postJson('/productos', $this->datos())
            ->assertStatus(201)
            ->assertJson([
                'id_producto' => 1,
                'codigo' => 'CAF-500',
                'descripcion' => 'Origen Caldas',
                'id_categoria' => $this->categoria->id_categoria,
                'precio' => 18500.5,
                'estado' => 'ACTIVO',
            ]);

        // Fechas en ISO 8601 UTC, como 2026-11-14T19:09:40Z.
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $respuesta->json('fecha_creacion'));
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $respuesta->json('fecha_actualizacion'));
    }

    public function test_no_permite_un_codigo_repetido(): void
    {
        $this->crearProducto('CAF-500', 'Otro');

        $this->postJson('/productos', $this->datos())
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'CODIGO_DUPLICADO');
    }

    public function test_responde_404_si_la_categoria_no_existe(): void
    {
        $this->postJson('/productos', ['id_categoria' => 99] + $this->datos())
            ->assertStatus(404)
            ->assertJsonPath('error.mensaje', 'La categoría no existe.');
    }

    public function test_valida_los_datos_con_un_detalle_por_campo(): void
    {
        $this->postJson('/productos', ['precio' => -1, 'id_categoria' => 'x'])
            ->assertStatus(422)
            ->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS')
            ->assertJsonFragment(['campo' => 'codigo', 'mensaje' => 'El campo codigo es obligatorio.'])
            ->assertJsonFragment(['campo' => 'precio'])
            ->assertJsonFragment(['campo' => 'id_categoria']);
    }

    public function test_consulta_un_producto_y_responde_404_si_no_existe(): void
    {
        $producto = $this->crearProducto('P-1', 'Agua');

        $this->getJson("/productos/{$producto->id_producto}")
            ->assertOk()
            ->assertJsonPath('codigo', 'P-1');

        $this->getJson('/productos/99')
            ->assertStatus(404)
            ->assertJsonPath('error.mensaje', 'El producto no existe.');
    }

    public function test_actualiza_sin_cambiar_el_codigo(): void
    {
        $producto = $this->crearProducto('P-1', 'Agua');

        $this->putJson("/productos/{$producto->id_producto}", ['codigo' => 'OTRO', 'nombre' => 'Agua con gas'] + $this->datos())
            ->assertOk()
            ->assertJson(['codigo' => 'P-1', 'nombre' => 'Agua con gas', 'precio' => 18500.5]);

        // Sin descripción, queda vacía.
        $datos = $this->datos();
        unset($datos['descripcion']);
        $this->putJson("/productos/{$producto->id_producto}", $datos)
            ->assertOk()
            ->assertJsonPath('descripcion', null);
    }

    public function test_actualizar_responde_404_antes_de_validar(): void
    {
        $this->putJson('/productos/99', [])->assertStatus(404);

        $producto = $this->crearProducto('P-1', 'Agua');
        $this->putJson("/productos/{$producto->id_producto}", [])->assertStatus(422);
        $this->putJson("/productos/{$producto->id_producto}", ['id_categoria' => 99] + $this->datos())->assertStatus(404);
    }

    public function test_inactiva_y_activa_un_producto(): void
    {
        $producto = $this->crearProducto('P-1', 'Agua');

        $this->postJson("/productos/{$producto->id_producto}/inactivar")
            ->assertOk()
            ->assertJsonPath('estado', 'INACTIVO');

        $this->postJson("/productos/{$producto->id_producto}/activar")
            ->assertOk()
            ->assertJsonPath('estado', 'ACTIVO');

        $this->postJson('/productos/99/inactivar')->assertStatus(404);
    }

    public function test_busca_por_parte_del_nombre_o_del_codigo_y_por_estado(): void
    {
        $this->crearProducto('GAS-001', 'Gaseosa cola');
        $this->crearProducto('GAS-002', 'Gaseosa naranja', estado: 'INACTIVO');
        $this->crearProducto('AGU-001', 'Agua');

        $this->getJson('/productos?nombre=gaseosa')->assertOk()->assertJsonPath('meta.total', 2);
        $this->getJson('/productos?codigo=001')->assertOk()->assertJsonPath('meta.total', 2);
        $this->getJson('/productos?estado=INACTIVO')
            ->assertOk()
            ->assertJsonPath('meta.total', 1)
            ->assertJsonPath('datos.0.codigo', 'GAS-002');
        $this->getJson('/productos?nombre=gaseosa&estado=ACTIVO')->assertOk()->assertJsonPath('meta.total', 1);
    }

    public function test_el_filtro_por_categoria_incluye_sus_subcategorias(): void
    {
        $bebidas = Categoria::create(['nombre' => 'Bebidas']);
        $gaseosas = Categoria::create(['nombre' => 'Gaseosas', 'id_categoria_padre' => $bebidas->id_categoria]);
        $this->crearProducto('B-1', 'Agua', $bebidas);
        $this->crearProducto('G-1', 'Gaseosa', $gaseosas);
        $this->crearProducto('C-1', 'Café');

        $this->getJson("/productos?id_categoria={$bebidas->id_categoria}")->assertOk()->assertJsonPath('meta.total', 2);
        $this->getJson("/productos?id_categoria={$gaseosas->id_categoria}")->assertOk()->assertJsonPath('meta.total', 1);
    }

    public function test_pagina_el_listado(): void
    {
        foreach (range(1, 3) as $i) {
            $this->crearProducto("P-{$i}", "Producto {$i}");
        }

        $this->getJson('/productos?pagina=2&por_pagina=2')
            ->assertOk()
            ->assertJsonPath('meta', ['pagina' => 2, 'por_pagina' => 2, 'total' => 3])
            ->assertJsonCount(1, 'datos')
            ->assertJsonPath('datos.0.codigo', 'P-3');

        $this->getJson('/productos')->assertJsonPath('meta.por_pagina', 20);
        $this->getJson('/productos?por_pagina=101')->assertStatus(422);
    }
}
