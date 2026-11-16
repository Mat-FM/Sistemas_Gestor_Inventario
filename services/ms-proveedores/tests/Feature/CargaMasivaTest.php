<?php

namespace Tests\Feature;

use App\Models\Proveedor;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Carga masiva interna POST /internas/proveedores/lote (RF16).
 */
class CargaMasivaTest extends TestCase
{
    use RefreshDatabase;

    private function fila(string $nit): array
    {
        return [
            'nit' => $nit,
            'razon_social' => "Proveedor $nit",
            'nombre_contacto' => 'Ana Gómez',
            'telefono' => '3001234567',
            'correo' => 'ventas@cafe.co',
            'direccion' => 'Calle 1',
        ];
    }

    public function test_guarda_las_filas_validas_y_reporta_las_invalidas(): void
    {
        Proveedor::create($this->fila('100') + ['estado' => 'ACTIVO']);

        $this->postJson('/internas/proveedores/lote', ['filas' => [
            $this->fila('200'),                        // 1: se crea
            $this->fila('100'),                        // 2: el NIT ya está en la base
            $this->fila('200'),                        // 3: el NIT se repite en el lote (gana la fila 1)
            ['nit' => '300', 'correo' => 'malo'],      // 4: datos no válidos
            'texto',                                   // 5: no es un objeto
            $this->fila('400'),                        // 6: se crea
        ]])
            ->assertOk()
            ->assertJsonPath('creados', 2)
            ->assertJsonCount(4, 'rechazados')
            ->assertJsonPath('rechazados.0', ['fila' => 2, 'motivo' => 'Ya existe un proveedor con ese NIT.'])
            ->assertJsonPath('rechazados.1.fila', 3)
            ->assertJsonPath('rechazados.2.fila', 4)
            ->assertJsonPath('rechazados.3.fila', 5);

        $this->assertSame(['100', '200', '400'], Proveedor::orderBy('nit')->pluck('nit')->all());
        $this->assertSame('ACTIVO', Proveedor::where('nit', '400')->value('estado'));
    }

    public function test_una_fila_con_varios_errores_los_reporta_todos(): void
    {
        $this->postJson('/internas/proveedores/lote', ['filas' => [['correo' => 'malo']]])
            ->assertOk()
            ->assertJsonPath('creados', 0)
            ->assertJsonPath('rechazados.0.motivo', fn (string $motivo) => str_contains($motivo, 'El campo nit es obligatorio.')
                && str_contains($motivo, 'El campo correo debe ser un correo electrónico válido.'));
    }

    public function test_una_lista_vacia_responde_422(): void
    {
        $this->postJson('/internas/proveedores/lote', ['filas' => []])
            ->assertStatus(422)
            ->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS');
    }
}
