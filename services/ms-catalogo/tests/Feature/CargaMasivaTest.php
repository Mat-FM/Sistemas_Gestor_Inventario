<?php

namespace Tests\Feature;

use App\Models\Categoria;
use App\Models\Producto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Carga masiva interna de productos (RF16): POST /internas/productos/lote, que llama ms-reportes.
 */
class CargaMasivaTest extends TestCase
{
    use RefreshDatabase;

    private function fila(string $codigo, int $idCategoria): array
    {
        return [
            'codigo' => $codigo,
            'nombre' => "Producto {$codigo}",
            'descripcion' => 'Cargado desde archivo',
            'id_categoria' => $idCategoria,
            'unidad_medida' => 'UNIDAD',
            'precio' => 1500,
        ];
    }

    public function test_crea_las_filas_validas_y_reporta_las_rechazadas(): void
    {
        $categoria = Categoria::create(['nombre' => 'Café']);
        $id = $categoria->id_categoria;
        Producto::create($this->fila('P-1', $id) + ['estado' => 'ACTIVO']);

        $this->postJson('/internas/productos/lote', ['filas' => [
            $this->fila('P-2', $id),
            $this->fila('P-1', $id),                    // ya existe en la base
            $this->fila('P-2', $id),                    // repetido en el mismo lote
            $this->fila('P-3', 99),                     // categoría inexistente
            ['codigo' => 'P-4', 'precio' => -1],        // datos inválidos
            'no es un objeto',
            ['descripcion' => null] + $this->fila('P-5', $id),
        ]])
            ->assertOk()
            ->assertJsonPath('creados', 2)
            ->assertJsonCount(5, 'rechazados')
            ->assertJsonPath('rechazados.0', ['fila' => 2, 'motivo' => 'Ya existe un producto con ese código.'])
            ->assertJsonPath('rechazados.1', ['fila' => 3, 'motivo' => 'Ya existe un producto con ese código.'])
            ->assertJsonPath('rechazados.2', ['fila' => 4, 'motivo' => 'La categoría no existe.'])
            ->assertJsonPath('rechazados.3.fila', 5)
            ->assertJsonPath('rechazados.4', ['fila' => 6, 'motivo' => 'La fila debe ser un objeto con los datos del producto.']);

        // Todos los errores de la fila en un solo motivo.
        $this->assertStringContainsString('El campo nombre es obligatorio.', $this->postJson('/internas/productos/lote', [
            'filas' => [['codigo' => 'P-4', 'precio' => -1]],
        ])->json('rechazados.0.motivo'));

        $this->assertSame(3, Producto::count());
        $this->assertDatabaseHas('productos', ['codigo' => 'P-5', 'estado' => 'ACTIVO']);
    }

    public function test_responde_422_si_la_lista_falta_o_esta_vacia(): void
    {
        foreach ([[], ['filas' => []], ['filas' => 'x']] as $cuerpo) {
            $this->postJson('/internas/productos/lote', $cuerpo)
                ->assertStatus(422)
                ->assertJsonPath('error.detalles.0.campo', 'filas');
        }
    }
}
