<?php

namespace Tests\Feature;

use App\Models\Categoria;
use App\Models\Producto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Categorías y subcategorías (RF02, Tabla 7 de la Entrega 2). Solo hay dos niveles.
 */
class CategoriasTest extends TestCase
{
    use RefreshDatabase;

    private function crearCategoria(string $nombre, ?Categoria $padre = null): Categoria
    {
        return Categoria::create(['nombre' => $nombre, 'id_categoria_padre' => $padre?->id_categoria]);
    }

    public function test_crea_una_categoria_principal_y_una_subcategoria(): void
    {
        $principal = $this->postJson('/categorias', ['nombre' => 'Bebidas', 'descripcion' => 'Frías y calientes'])
            ->assertStatus(201)
            ->assertExactJson([
                'id_categoria' => 1,
                'nombre' => 'Bebidas',
                'descripcion' => 'Frías y calientes',
                'id_categoria_padre' => null,
            ]);

        $this->postJson('/categorias', ['nombre' => 'Gaseosas', 'id_categoria_padre' => $principal->json('id_categoria')])
            ->assertStatus(201)
            ->assertJson(['nombre' => 'Gaseosas', 'descripcion' => null, 'id_categoria_padre' => 1]);
    }

    public function test_valida_los_datos(): void
    {
        $this->postJson('/categorias', ['id_categoria_padre' => 'x'])
            ->assertStatus(422)
            ->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS')
            ->assertJsonFragment(['campo' => 'nombre', 'mensaje' => 'El campo nombre es obligatorio.'])
            ->assertJsonFragment(['campo' => 'id_categoria_padre']);
    }

    public function test_responde_404_si_la_categoria_padre_no_existe(): void
    {
        $this->postJson('/categorias', ['nombre' => 'Gaseosas', 'id_categoria_padre' => 99])
            ->assertStatus(404)
            ->assertJsonPath('error.mensaje', 'La categoría padre no existe.');
    }

    public function test_no_permite_un_tercer_nivel(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');
        $gaseosas = $this->crearCategoria('Gaseosas', $bebidas);

        $this->postJson('/categorias', ['nombre' => 'Colas', 'id_categoria_padre' => $gaseosas->id_categoria])
            ->assertStatus(422)
            ->assertJsonPath('error.detalles.0.campo', 'id_categoria_padre');
    }

    public function test_una_categoria_no_puede_ser_su_propia_padre(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');

        $this->putJson("/categorias/{$bebidas->id_categoria}", ['nombre' => 'Bebidas', 'id_categoria_padre' => $bebidas->id_categoria])
            ->assertStatus(422)
            ->assertJsonPath('error.detalles.0.mensaje', 'Una categoría no puede ser su propia padre.');
    }

    public function test_una_categoria_con_subcategorias_no_puede_pasar_a_ser_subcategoria(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');
        $this->crearCategoria('Gaseosas', $bebidas);
        $cafe = $this->crearCategoria('Café');

        $this->putJson("/categorias/{$bebidas->id_categoria}", ['nombre' => 'Bebidas', 'id_categoria_padre' => $cafe->id_categoria])
            ->assertStatus(422)
            ->assertJsonPath('error.detalles.0.campo', 'id_categoria_padre');
    }

    public function test_no_permite_el_mismo_nombre_en_el_mismo_nivel(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');
        $this->crearCategoria('Otros', $bebidas);

        $this->postJson('/categorias', ['nombre' => 'Bebidas'])
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'NOMBRE_DUPLICADO');

        $this->postJson('/categorias', ['nombre' => 'Otros', 'id_categoria_padre' => $bebidas->id_categoria])
            ->assertStatus(409)
            ->assertJsonPath('error.codigo', 'NOMBRE_DUPLICADO');

        // En otro nivel sí se permite.
        $this->postJson('/categorias', ['nombre' => 'Otros'])->assertStatus(201);
    }

    public function test_lista_plana_por_padre_y_en_arbol(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');
        $this->crearCategoria('Jugos', $bebidas);
        $this->crearCategoria('Gaseosas', $bebidas);
        $this->crearCategoria('Café');

        // Lista plana ordenada por nombre.
        $this->getJson('/categorias')
            ->assertOk()
            ->assertJsonCount(4)
            ->assertJsonPath('0.nombre', 'Bebidas')
            ->assertJsonPath('1.nombre', 'Café');

        $this->getJson("/categorias?id_categoria_padre={$bebidas->id_categoria}")
            ->assertOk()
            ->assertJsonCount(2)
            ->assertJsonPath('0.nombre', 'Gaseosas');

        $this->getJson('/categorias?arbol=true')
            ->assertOk()
            ->assertJsonCount(2)
            ->assertJsonPath('0.nombre', 'Bebidas')
            ->assertJsonCount(2, '0.subcategorias')
            ->assertJsonPath('0.subcategorias.0.nombre', 'Gaseosas')
            ->assertJsonCount(0, '1.subcategorias');

        $this->getJson('/categorias?arbol=quizas')->assertStatus(422);
    }

    public function test_consulta_y_actualiza_una_categoria(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');

        $this->getJson("/categorias/{$bebidas->id_categoria}")
            ->assertOk()
            ->assertJsonPath('nombre', 'Bebidas');

        $this->putJson("/categorias/{$bebidas->id_categoria}", ['nombre' => 'Bebidas frías'])
            ->assertOk()
            ->assertJsonPath('nombre', 'Bebidas frías');

        $this->getJson('/categorias/99')->assertStatus(404);
        $this->putJson('/categorias/99', ['nombre' => 'X'])->assertStatus(404);
        $this->getJson('/categorias/abc')->assertStatus(404);
    }

    public function test_elimina_una_categoria_sin_uso(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');

        $this->deleteJson("/categorias/{$bebidas->id_categoria}")->assertNoContent();
        $this->assertDatabaseMissing('categorias', ['id_categoria' => $bebidas->id_categoria]);
        $this->deleteJson("/categorias/{$bebidas->id_categoria}")->assertStatus(404);
    }

    public function test_no_elimina_una_categoria_con_subcategorias_o_productos(): void
    {
        $bebidas = $this->crearCategoria('Bebidas');
        $gaseosas = $this->crearCategoria('Gaseosas', $bebidas);
        Producto::create([
            'codigo' => 'P-1', 'nombre' => 'Gaseosa', 'id_categoria' => $gaseosas->id_categoria,
            'unidad_medida' => 'UNIDAD', 'precio' => 2500, 'estado' => 'ACTIVO',
        ]);

        foreach ([$bebidas, $gaseosas] as $categoria) {
            $this->deleteJson("/categorias/{$categoria->id_categoria}")
                ->assertStatus(409)
                ->assertJsonPath('error.codigo', 'CATEGORIA_EN_USO');
        }
    }
}
