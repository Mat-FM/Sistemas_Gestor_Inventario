<?php

namespace App\Http\Support;

use Illuminate\Contracts\Pagination\LengthAwarePaginator;

/**
 * Da a los listados la forma común {"datos": [...], "meta": {"pagina", "por_pagina", "total"}}.
 */
final class Paginated
{
    /**
     * @param  callable(mixed): mixed  $map  transforma cada elemento de la página
     * @return array{datos: list<mixed>, meta: array{pagina: int, por_pagina: int, total: int}}
     */
    public static function from(LengthAwarePaginator $p, callable $map): array
    {
        return [
            'datos' => array_values(array_map($map, $p->items())),
            'meta' => [
                'pagina' => $p->currentPage(),
                'por_pagina' => $p->perPage(),
                'total' => $p->total(),
            ],
        ];
    }
}
