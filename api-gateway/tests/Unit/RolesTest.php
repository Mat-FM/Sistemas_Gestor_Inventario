<?php

namespace Tests\Unit;

use App\Models\Rol;
use App\Support\Roles;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RolesTest extends TestCase
{
    use RefreshDatabase;

    public function test_las_constantes_tienen_los_nombres_exactos_del_contrato(): void
    {
        $this->assertSame('ADMINISTRADOR', Roles::ADM);
        $this->assertSame('OPERADOR_BODEGA', Roles::OPE);
        $this->assertSame('VENDEDOR', Roles::VEN);
        $this->assertSame('CONTADOR', Roles::CON);
    }

    public function test_todos_lista_los_cuatro_roles_sin_repetir(): void
    {
        $this->assertSame(['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'], Roles::TODOS);
        $this->assertCount(4, array_unique(Roles::TODOS));
    }

    public function test_el_nombre_del_rol_es_unico_a_nivel_de_base_de_datos(): void
    {
        Rol::forceCreate(['nombre' => 'ADMINISTRADOR', 'descripcion' => 'a']);

        try {
            Rol::forceCreate(['nombre' => 'ADMINISTRADOR', 'descripcion' => 'b']);
            $this->fail('La base debía rechazar un nombre de rol repetido.');
        } catch (QueryException $e) {
            $this->assertMatchesRegularExpression('/unique|duplicate/i', $e->getMessage());
        }

        $this->assertSame(1, Rol::count());
    }
}
