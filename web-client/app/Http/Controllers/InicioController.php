<?php

namespace App\Http\Controllers;

use App\Gateway\Intento;
use App\Services\Compras;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Services\Reportes;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\View\View;

/**
 * La pantalla de inicio cambia según el rol: cada uno ve primero lo que necesita atender. Cada bloque pide sus datos por
 * separado y, si falla, dice que no está disponible sin dejar en blanco el resto.
 */
class InicioController extends Controller
{
    private const FILAS_DE_STOCK_BAJO = 6;

    public function __construct(
        private readonly Sesion $sesion,
        private readonly Inventario $inventario,
        private readonly Nombres $nombres,
        private readonly Reportes $reportes,
        private readonly Compras $compras,
    ) {}

    public function __invoke(): View
    {
        return match ($this->sesion->rol()) {
            Roles::ADMINISTRADOR => $this->administrador(),
            Roles::OPERADOR => $this->operador(),
            Roles::CONTADOR => $this->contador(),
            default => view('inicio.vendedor'),
        };
    }

    private function administrador(): View
    {
        // La lista del servicio no es paginada: se muestran los más urgentes (los más lejos de su mínimo) y se
        // resuelven solo sus nombres, para no gastar el límite de peticiones del Gateway con cientos de productos.
        [$bajoUmbral, $falloBajo] = Intento::de(function () {
            $filas = $this->inventario->bajoUmbral();
            usort($filas, static fn (array $a, array $b) => ($a['cantidad_total'] / max(1, $a['cantidad_minima'])) <=> ($b['cantidad_total'] / max(1, $b['cantidad_minima'])));

            return ['total' => count($filas), 'filas' => $this->nombres->conNombres(array_slice($filas, 0, self::FILAS_DE_STOCK_BAJO))];
        });
        [$enTransito, $falloTransito] = Intento::de(
            fn () => (int) ($this->inventario->traslados(['estado' => 'EN_TRANSITO', 'por_pagina' => 1])['meta']['total'] ?? 0)
        );

        [$indicadores, $falloIndicadores] = Intento::de(fn () => $this->reportes->indicadores());

        return view('inicio.administrador', [
            'indicadores' => $indicadores,
            'falloIndicadores' => $falloIndicadores !== null,
            'bajoUmbral' => $bajoUmbral['filas'] ?? [],
            'bajoTotal' => $bajoUmbral['total'] ?? 0,
            'falloBajo' => $falloBajo !== null,
            'enTransito' => $enTransito,
            'falloTransito' => $falloTransito !== null,
        ] + $this->ultimosMovimientos());
    }

    private function operador(): View
    {
        $bodega = $this->sesion->idBodega();
        if ($bodega === null) {
            return view('inicio.operador', ['sinBodega' => true]);
        }

        [$porRecibir, $falloTraslados] = Intento::de(function () use ($bodega) {
            $filas = $this->inventario->traslados(['estado' => 'EN_TRANSITO', 'id_bodega' => $bodega, 'por_pagina' => 50])['datos'];

            return $this->nombres->conNombres(array_values(array_filter(
                $filas,
                static fn (array $fila) => (int) $fila['id_bodega_destino'] === $bodega,
            )));
        });

        // Órdenes de compra que llegan a su bodega y todavía esperan mercancía (enviadas o recibidas a medias).
        [$ordenes, $falloOrdenes] = Intento::de(function () use ($bodega) {
            $abiertas = [];
            foreach (['ENVIADA', 'RECIBIDA_PARCIAL'] as $estado) {
                array_push($abiertas, ...$this->compras->ordenes(['estado' => $estado, 'id_bodega_destino' => $bodega, 'por_pagina' => 20])['datos']);
            }

            return $this->nombres->conNombres($abiertas);
        });

        return view('inicio.operador', [
            'ordenesPorRecibir' => $ordenes ?? [],
            'falloOrdenes' => $falloOrdenes !== null,
            'sinBodega' => false,
            'porRecibir' => $porRecibir ?? [],
            'falloTraslados' => $falloTraslados !== null,
        ] + $this->ultimosMovimientos($bodega));
    }

    private function contador(): View
    {
        [$valorizacion, $falloValor] = Intento::de(fn () => $this->reportes->valorizacion());
        $mayores = collect($valorizacion['productos'] ?? [])->sortByDesc('valor')->take(5)->values()->all();

        [$indicadores, $falloIndicadores] = Intento::de(fn () => $this->reportes->indicadores());

        return view('inicio.contador', [
            'indicadores' => $indicadores,
            'falloIndicadores' => $falloIndicadores !== null,
            'valorTotal' => $valorizacion['valor_total'] ?? null,
            'mayores' => $mayores,
            'falloValor' => $falloValor !== null,
        ] + $this->ultimosMovimientos());
    }

    /** @return array{ultimos: list<array<string, mixed>>, falloUltimos: bool} */
    private function ultimosMovimientos(?int $bodega = null): array
    {
        [$ultimos, $fallo] = Intento::de(fn () => $this->nombres->conNombres(
            $this->inventario->movimientos(['por_pagina' => 5, 'id_bodega' => $bodega])['datos']
        ));

        return ['ultimos' => $ultimos ?? [], 'falloUltimos' => $fallo !== null];
    }
}
