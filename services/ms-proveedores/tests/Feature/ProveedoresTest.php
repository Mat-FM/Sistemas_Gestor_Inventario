<?php

namespace Tests\Feature;

use App\Models\Proveedor;
use App\Models\ProveedorProducto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * CRUD de proveedores (Tabla 8 de la Entrega 2).
 */
class ProveedoresTest extends TestCase
{
    use RefreshDatabase;

    private function datos(string $nit = '900123456-1'): array
    {
        return [
            'nit' => $nit,
            'razon_social' => 'Distribuidora Café S.A.S.',
            'nombre_contacto' => 'Ana Gómez',
            'telefono' => '3001234567',
            'correo' => 'ventas@cafe.co',
            'direccion' => 'Cra 23 # 45-67, Manizales',
        ];
    }

    private function crearProveedor(string $nit = '900123456-1', string $estado = 'ACTIVO'): Proveedor
    {
        return Proveedor::create($this->datos($nit) + ['estado' => $estado]);
    }

    public function test_crea_un_proveedor_en_estado_activo(): void
    {
        $this->postJson('/proveedores', $this->datos())
            ->assertStatus(201)
            ->assertJson(['nit' => '900123456-1', 'estado' => 'ACTIVO'])
            ->assertJsonStructure(['id_proveedor', 'nit', 'razon_social', 'nombre_contacto', 'telefono', 'correo', 'direccion', 'estado']);
    }

    public function test_no_permite_un_nit_repetido(): void
    {
        $this->crearProveedor();

        $this->postJson('/proveedores', $this->datos())
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'NIT_DUPLICADO');
    }

    public function test_valida_los_datos_con_un_detalle_por_campo(): void
    {
        $this->postJson('/proveedores', ['nit' => '1', 'correo' => 'no-es-correo'])
            ->assertStatus(422)
            ->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS')
            ->assertJsonFragment(['campo' => 'razon_social', 'mensaje' => 'El campo razon_social es obligatorio.'])
            ->assertJsonFragment(['campo' => 'correo']);
    }

    public function test_consulta_un_proveedor_y_responde_404_si_no_existe(): void
    {
        $proveedor = $this->crearProveedor();

        $this->getJson("/proveedores/{$proveedor->id_proveedor}")
            ->assertOk()
            ->assertJsonPath('nit', '900123456-1');

        $this->getJson('/proveedores/999')
            ->assertStatus(404)
            ->assertJsonPath('error.codigo', 'NO_EXISTE');
    }

    public function test_actualiza_sin_cambiar_el_nit(): void
    {
        $proveedor = $this->crearProveedor();
        $cambios = ['nit' => 'OTRO', 'telefono' => '3110000000'] + $this->datos();

        $this->putJson("/proveedores/{$proveedor->id_proveedor}", $cambios)
            ->assertOk()
            ->assertJson(['nit' => '900123456-1', 'telefono' => '3110000000']);
    }

    public function test_inactiva_y_activa_sin_borrar(): void
    {
        $proveedor = $this->crearProveedor();
        $ruta = "/proveedores/{$proveedor->id_proveedor}";

        $this->postJson("$ruta/inactivar")->assertOk()->assertJsonPath('estado', 'INACTIVO');
        // Inactivar dos veces responde 200 sin cambios.
        $this->postJson("$ruta/inactivar")->assertOk()->assertJsonPath('estado', 'INACTIVO');
        $this->postJson("$ruta/activar")->assertOk()->assertJsonPath('estado', 'ACTIVO');

        $this->assertDatabaseCount('proveedores', 1);
    }

    public function test_lista_paginado_con_filtros(): void
    {
        $this->crearProveedor('100');
        $otro = $this->crearProveedor('200', 'INACTIVO');
        ProveedorProducto::create(['id_proveedor' => $otro->id_proveedor, 'id_producto' => 25]);

        $this->getJson('/proveedores?por_pagina=1')
            ->assertOk()
            ->assertJsonPath('meta', ['pagina' => 1, 'por_pagina' => 1, 'total' => 2])
            ->assertJsonCount(1, 'datos');

        // nit exacto, razón social parcial, estado e id_producto.
        $this->getJson('/proveedores?nit=10')->assertJsonPath('meta.total', 0);
        $this->getJson('/proveedores?razon_social=DISTRI')->assertJsonPath('meta.total', 2);
        $this->getJson('/proveedores?estado=INACTIVO')->assertJsonPath('datos.0.nit', '200');
        $this->getJson('/proveedores?id_producto=25')->assertJsonPath('meta.total', 1);

        $this->getJson('/proveedores?por_pagina=101')->assertStatus(422);
    }
}
