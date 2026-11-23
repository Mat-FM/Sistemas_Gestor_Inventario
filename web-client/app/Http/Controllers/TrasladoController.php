<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFallas;
use App\Services\Catalogo;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\View\View;

/** Traslados entre bodegas: envío y recepción en dos pasos (RF04, RF05). */
class TrasladoController extends Controller
{
    use ResponderFallas;

    public function __construct(
        private readonly Sesion $sesion,
        private readonly Inventario $inventario,
        private readonly Nombres $nombres,
    ) {}

    public function index(Request $request): View
    {
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        $miBodega = $this->sesion->idBodega();
        if ($operador && $miBodega === null) {
            return view('traslados.index', ['sinBodega' => true]);
        }

        $estado = in_array($request->query('estado'), ['EN_TRANSITO', 'RECIBIDO', 'todos'], true) ? $request->query('estado') : 'EN_TRANSITO';
        [$respuesta, $fallo] = Intento::de(fn () => $this->inventario->traslados([
            'estado' => $estado === 'todos' ? null : $estado,
            'id_bodega' => $operador ? $miBodega : null,
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));

        $filas = array_map(function (array $fila) use ($operador, $miBodega) {
            $fila['puedeRecibir'] = $fila['estado'] === 'EN_TRANSITO'
                && (! $operador || (int) $fila['id_bodega_destino'] === $miBodega);
            // La clave se genera al mostrar la pantalla: tocar dos veces «Recibir» repite la misma operación.
            $fila['clave'] = (string) Str::uuid();

            return $fila;
        }, $this->nombres->conNombres($respuesta['datos'] ?? []));

        return view('traslados.index', [
            'sinBodega' => false,
            'estado' => $estado,
            'filas' => $filas,
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
        ]);
    }

    public function crear(Request $request, Catalogo $catalogo): View
    {
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        if ($operador && $this->sesion->idBodega() === null) {
            return view('traslados.crear', ['sinBodega' => true]);
        }

        $datos = ['sinBodega' => false, 'producto' => null, 'busqueda' => trim((string) $request->query('q', ''))];
        $idProducto = $request->integer('id_producto');
        if ($idProducto <= 0) {
            [$resultados, $fallo] = Intento::de(fn () => $catalogo->buscar($datos['busqueda']));

            return view('traslados.crear', $datos + ['resultados' => $resultados ?? [], 'fallo' => $fallo !== null]);
        }

        // El administrador elige primero la bodega de origen (los lotes que se pueden enviar dependen de ella); el operador sale
        // siempre de la suya.
        $origen = $operador ? $this->sesion->idBodega() : ($request->integer('id_bodega_origen') ?: null);
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());
        [$saldos] = Intento::de(fn () => $this->inventario->saldosDeProductos([$idProducto], null)[$idProducto] ?? null);
        $saldos = $saldos instanceof GatewayException ? [] : ($saldos['datos'] ?? []);

        // Un traslado mueve un solo lote o solo stock sin lote (ms-inventario, D28(a)): sin elegir el lote, el stock que está en
        // lotes no se puede enviar. Se ofrecen los lotes con existencia en el origen, primero el que vence antes, y el stock sin lote
        // (el saldo menos lo que está en lotes).
        [$lotes, $falloLotes] = $origen === null ? [[], null]
            : Intento::de(fn () => $this->inventario->lotes(['id_producto' => $idProducto, 'id_bodega' => $origen, 'por_pagina' => 100])['datos']);
        $lotes = $lotes ?? [];
        $enOrigen = (int) (collect($saldos)->firstWhere('id_bodega', $origen)['cantidad_disponible'] ?? 0);
        $sinLote = max(0, $enOrigen - (int) array_sum(array_column($lotes, 'cantidad_disponible')));
        $lotes = array_values(array_filter($lotes, static fn (array $lote) => (int) $lote['cantidad_disponible'] > 0));
        usort($lotes, static fn (array $a, array $b) => [$a['fecha_vencimiento'] === null, $a['fecha_vencimiento'], $a['id_lote']]
            <=> [$b['fecha_vencimiento'] === null, $b['fecha_vencimiento'], $b['id_lote']]);

        return view('traslados.crear', array_merge($datos, [
            'producto' => $catalogo->obtener($idProducto),
            'origenFijo' => $operador,
            'idOrigen' => $origen,
            'bodegas' => array_filter($bodegas ?? [], static fn (array $bodega) => $bodega['activa']),
            'saldos' => $saldos,
            'lotes' => $lotes,
            'sinLote' => $sinLote,
            'falloLotes' => $falloLotes !== null,
        ]));
    }

    public function guardar(Request $request): RedirectResponse
    {
        $request->merge(['cantidad' => preg_replace('/[\s.]/', '', (string) $request->input('cantidad'))]);
        // El operador solo envía desde su bodega, aunque el formulario diga otra: se valida contra la suya.
        if ($this->sesion->rol() === Roles::OPERADOR && $this->sesion->idBodega() !== null) {
            $request->merge(['id_bodega_origen' => $this->sesion->idBodega()]);
        }

        $datos = $request->validate([
            'id_producto' => ['required', 'integer', 'min:1'],
            'id_bodega_origen' => ['required', 'integer', 'min:1'],
            'id_bodega_destino' => ['required', 'integer', 'min:1', 'different:id_bodega_origen'],
            'cantidad' => ['required', 'integer', 'min:1', 'max:2147483647'],
            'id_lote' => ['nullable', 'integer', 'min:1'], // vacío: solo stock sin lote
            'clave' => ['required', 'string', 'max:200', 'not_regex:/#/'],
        ], [
            'id_bodega_origen.required' => 'Elige la bodega de origen.',
            'id_bodega_destino.required' => 'Elige la bodega de destino.',
            'id_bodega_destino.different' => 'El destino debe ser otra bodega distinta del origen.',
            'cantidad.required' => 'Escribe la cantidad.',
            'cantidad.integer' => 'La cantidad debe ser un número entero, sin decimales.',
            'cantidad.min' => 'La cantidad debe ser mayor que 0.',
        ]);

        // El operador solo envía desde su bodega, aunque el formulario diga otra.
        $origen = $this->sesion->rol() === Roles::OPERADOR ? $this->sesion->idBodega() : (int) $datos['id_bodega_origen'];
        if ($origen === null) {
            return back()->with('error', 'Todavía no tienes una bodega asignada. Habla con el administrador.');
        }
        if ($origen === (int) $datos['id_bodega_destino']) {
            return back()->withInput($request->except('clave'))->withErrors(['id_bodega_destino' => 'El destino debe ser otra bodega distinta del origen.']);
        }

        $cuerpo = [
            'id_producto' => (int) $datos['id_producto'],
            'id_bodega_origen' => $origen,
            'id_bodega_destino' => (int) $datos['id_bodega_destino'],
            'cantidad' => (int) $datos['cantidad'],
        ];
        if (! empty($datos['id_lote'])) {
            $cuerpo['id_lote'] = (int) $datos['id_lote'];
        }

        try {
            $this->inventario->crearTraslado($cuerpo, $datos['clave']);
        } catch (GatewayException $e) {
            return $this->fallaDeEscritura($request, $e);
        }

        return redirect()->route('traslados.index')->with('exito', 'Traslado enviado. La otra bodega lo verá en «Por recibir».');
    }

    public function recibir(Request $request, int $id): RedirectResponse
    {
        $datos = $request->validate(['clave' => ['required', 'string', 'max:200', 'not_regex:/#/']]);

        try {
            $this->inventario->recibirTraslado($id, $datos['clave']);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado === 409 && $e->codigo === 'TRASLADO_YA_RECIBIDO') {
                return redirect()->route('traslados.index')->with('aviso', 'Ese traslado ya se había recibido.');
            }
            if ($e->esAmbigua()) {
                return back()->with('error', 'No pudimos confirmar si se recibió, porque el sistema no respondió. Revisa la lista antes de repetirlo.');
            }

            return back()->with('error', match (true) {
                $e->estado === 403 => 'Solo se recibe en la bodega de destino.',
                $e->estado === 404 => 'Ese traslado ya no existe.',
                default => $e->getMessage() ?: 'No se pudo recibir el traslado.',
            });
        }

        return redirect()->route('traslados.index')->with('exito', 'Traslado recibido: la mercancía ya está en tu bodega.');
    }
}
