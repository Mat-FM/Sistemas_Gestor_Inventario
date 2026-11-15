<?php

namespace Tests\Feature;

use App\Models\Proveedor;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Asociación de proveedores con productos (Tabla 8 de la Entrega 2).
 */
class ProveedorProductoTest extends TestCase
{
    use RefreshDatabase;

    private function crearProveedor(string $estado = 'ACTIVO'): Proveedor
    {
        return Proveedor::create([
            'nit' => '900123456-1',
            'razon_social' => 'Distribuidora Café S.A.S.',
            'nombre_contacto' => 'Ana Gómez',
            'telefono' => '3001234567',
            'correo' => 'ventas@cafe.co',
            'direccion' => 'Cra 23 # 45-67, Manizales',
            'estado' => $estado,
        ]);
    }

    public function test_asocia_un_producto_aunque_el_proveedor_este_inactivo(): void
    {
        $proveedor = $this->crearProveedor('INACTIVO');

        $this->postJson("/proveedores/{$proveedor->id_proveedor}/productos", ['id_producto' => 25])
            ->assertStatus(201)
            ->assertJsonPath('id_producto', 25)
            ->assertJsonStructure(['id_proveedor_producto', 'id_producto', 'fecha_asociacion']);
    }

    public function test_no_asocia_dos_veces_el_mismo_producto(): void
    {
        $proveedor = $this->crearProveedor();
        $ruta = "/proveedores/{$proveedor->id_proveedor}/productos";

        $this->postJson($ruta, ['id_producto' => 25])->assertStatus(201);
        $this->postJson($ruta, ['id_producto' => 25])
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'PRODUCTO_YA_ASOCIADO');
    }

    public function test_valida_id_producto(): void
    {
        $proveedor = $this->crearProveedor();

        $this->postJson("/proveedores/{$proveedor->id_proveedor}/productos", ['id_producto' => 'abc'])
            ->assertStatus(422)
            ->assertJsonPath('error.detalles.0.campo', 'id_producto');
    }

    public function test_lista_los_productos_del_proveedor(): void
    {
        $proveedor = $this->crearProveedor();
        $proveedor->productos()->create(['id_producto' => 25]);
        $proveedor->productos()->create(['id_producto' => 30]);

        // Lista simple, sin {datos, meta}: la usa ms-catalogo para el filtro RF12.
        $this->getJson("/proveedores/{$proveedor->id_proveedor}/productos")
            ->assertOk()
            ->assertJsonCount(2)
            ->assertJsonPath('1.id_producto', 30);
    }

    public function test_quita_la_asociacion_con_borrado_real(): void
    {
        $proveedor = $this->crearProveedor();
        $proveedor->productos()->create(['id_producto' => 25]);
        $ruta = "/proveedores/{$proveedor->id_proveedor}/productos/25";

        $this->deleteJson($ruta)->assertNoContent();
        $this->assertDatabaseCount('proveedor_producto', 0);

        $this->deleteJson($ruta)->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
    }

    public function test_responde_404_si_el_proveedor_no_existe(): void
    {
        $this->getJson('/proveedores/999/productos')->assertStatus(404);
        $this->postJson('/proveedores/999/productos', ['id_producto' => 25])->assertStatus(404);
        $this->deleteJson('/proveedores/999/productos/25')->assertStatus(404);
    }
}
