<?php

namespace Tests\Unit;

use App\Http\Support\Paginated;
use Illuminate\Pagination\LengthAwarePaginator;
use PHPUnit\Framework\TestCase;

class PaginatedTest extends TestCase
{
    public function test_from_devuelve_datos_transformados_y_meta(): void
    {
        $paginador = new LengthAwarePaginator(['a', 'b', 'c'], 7, 3, 2);

        $resultado = Paginated::from($paginador, fn (string $item) => strtoupper($item));

        $this->assertSame([
            'datos' => ['A', 'B', 'C'],
            'meta' => ['pagina' => 2, 'por_pagina' => 3, 'total' => 7],
        ], $resultado);
    }

    public function test_datos_es_siempre_una_lista_aunque_los_elementos_traigan_claves(): void
    {
        $paginador = new LengthAwarePaginator([5 => 'a', 9 => 'b'], 2, 20, 1);

        $resultado = Paginated::from($paginador, fn (string $item) => strtoupper($item));

        $this->assertSame(['A', 'B'], $resultado['datos']);
        $this->assertSame('{"datos":["A","B"],"meta":{"pagina":1,"por_pagina":20,"total":2}}', json_encode($resultado));
    }

    public function test_una_pagina_vacia_da_lista_vacia_y_total_cero(): void
    {
        $paginador = new LengthAwarePaginator([], 0, 20, 1);

        $resultado = Paginated::from($paginador, fn ($item) => $item);

        $this->assertSame([
            'datos' => [],
            'meta' => ['pagina' => 1, 'por_pagina' => 20, 'total' => 0],
        ], $resultado);
    }
}
