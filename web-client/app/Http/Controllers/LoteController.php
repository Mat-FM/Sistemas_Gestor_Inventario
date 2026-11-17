<?php

namespace App\Http\Controllers;

use App\Gateway\Intento;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Support\Roles;
use App\Support\Sesion;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Lotes con existencia que están por vencer o ya vencieron, del que vence primero al último (RF17, FEFO). */
class LoteController extends Controller
{
    public const DIAS = [7, 15, 30, 60, 90, 180, 365];

    public function __construct(
        private readonly Inventario $inventario,
        private readonly Nombres $nombres,
        private readonly Sesion $sesion,
    ) {}

    public function index(Request $request): View
    {
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        if ($operador && $this->sesion->idBodega() === null) {
            return view('lotes.index', ['sinBodega' => true]);
        }

        $dias = in_array($request->integer('dias'), self::DIAS, true) ? $request->integer('dias') : 30;
        $idBodega = $operador ? $this->sesion->idBodega() : ($request->integer('bodega') ?: null);
        $hoy = CarbonImmutable::now(config('interfaz.zona_horaria'))->startOfDay();

        // En ms-inventario `vence_antes_de` es estricto (un lote que vence ese día no entra): se pide el día siguiente al límite.
        [$respuesta, $fallo] = Intento::de(fn () => $this->inventario->lotes([
            'vence_antes_de' => $hoy->addDays($dias + 1)->toDateString(),
            'con_existencia' => 'true',
            'id_bodega' => $idBodega,
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        $lotes = array_map(function (array $lote) use ($hoy) {
            $dias = (int) $hoy->diffInDays(CarbonImmutable::parse($lote['fecha_vencimiento'], config('interfaz.zona_horaria'))->startOfDay(), false);
            $lote['dias'] = $dias;

            return $lote;
        }, $this->nombres->conNombres($respuesta['datos'] ?? []));

        return view('lotes.index', [
            'sinBodega' => false,
            'lotes' => $lotes,
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'dias' => $dias,
            'opcionesDeDias' => self::DIAS,
            'idBodega' => $idBodega,
            'bodegas' => $bodegas ?? [],
            'puedeElegirBodega' => ! $operador,
        ]);
    }
}
