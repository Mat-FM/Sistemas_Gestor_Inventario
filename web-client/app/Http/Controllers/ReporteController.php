<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Services\Catalogo;
use App\Services\Nombres;
use App\Services\Reportes;
use App\Services\Usuarios;
use App\Support\Formato;
use App\Support\Roles;
use App\Support\Sesion;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\View\View;

/**
 * Reportes de inventario y panel de auditoría (RF11, RF15): existencias, valorización, rotación y kardex, en pantalla y para
 * descargar en CSV o PDF. Los calcula ms-reportes; aquí solo se piden y se muestran.
 */
class ReporteController extends Controller
{
    /** Cuántas filas del kardex se dibujan: el resto se obtiene descargando el archivo. */
    private const FILAS_EN_PANTALLA = 100;

    public function __construct(
        private readonly Reportes $reportes,
        private readonly Nombres $nombres,
        private readonly Catalogo $catalogo,
        private readonly Usuarios $usuarios,
        private readonly Sesion $sesion,
    ) {}

    public function index(): View
    {
        return view('reportes.index');
    }

    public function existencias(Request $request): View|Response|RedirectResponse
    {
        $filtros = ['id_bodega' => $request->integer('bodega') ?: null, 'id_categoria' => $request->integer('categoria') ?: null];
        if ($descarga = $this->descargar($request, 'existencias', $filtros)) {
            return $descarga;
        }

        [$filas, $fallo] = Intento::de(fn () => $this->reportes->existencias($filtros));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());
        [$categorias] = Intento::de(fn () => $this->nombres->categorias());

        return view('reportes.existencias', [
            'filas' => $filas ?? [],
            'fallo' => $fallo !== null,
            'bodegas' => $bodegas ?? [],
            'categorias' => $categorias ?? [],
            'filtros' => $filtros,
        ]);
    }

    public function valorizacion(Request $request): View|Response|RedirectResponse
    {
        $filtros = ['id_bodega' => $request->integer('bodega') ?: null];
        if ($descarga = $this->descargar($request, 'valorizacion', $filtros)) {
            return $descarga;
        }

        [$respuesta, $fallo] = Intento::de(fn () => $this->reportes->valorizacionDe($filtros));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        return view('reportes.valorizacion', [
            'productos' => collect($respuesta['productos'] ?? [])->sortByDesc('valor')->values()->all(),
            'valorTotal' => $respuesta['valor_total'] ?? 0,
            'fallo' => $fallo !== null,
            'bodegas' => $bodegas ?? [],
            'filtros' => $filtros,
        ]);
    }

    public function rotacion(Request $request): View|Response|RedirectResponse
    {
        $hoy = CarbonImmutable::now(config('interfaz.zona_horaria'));
        $desde = $this->fecha($request->query('desde')) ?? $hoy->subDays(30)->toDateString();
        $hasta = $this->fecha($request->query('hasta')) ?? $hoy->toDateString();
        $limite = min(100, max(1, $request->integer('limite', 10)));
        $filtros = ['fecha_desde' => $desde, 'fecha_hasta' => $hasta, 'limite' => $limite];
        if ($descarga = $this->descargar($request, 'rotacion', $filtros)) {
            return $descarga;
        }

        if ($desde > $hasta) {
            return view('reportes.rotacion', ['mayor' => [], 'menor' => [], 'fallo' => false, 'filtros' => $filtros, 'errorDeFechas' => 'La fecha de inicio no puede ser posterior a la final.']);
        }
        [$respuesta, $fallo] = Intento::de(fn () => $this->reportes->rotacion($desde, $hasta, $limite));

        return view('reportes.rotacion', [
            'mayor' => $respuesta['mayor_rotacion'] ?? [],
            'menor' => $respuesta['menor_rotacion'] ?? [],
            'fallo' => $fallo !== null,
            'filtros' => $filtros,
            'errorDeFechas' => null,
        ]);
    }

    public function kardex(Request $request): View|Response|RedirectResponse
    {
        $tipo = array_key_exists((string) $request->query('tipo'), Formato::TIPOS) ? $request->query('tipo') : null;
        $filtros = [
            'id_producto' => $request->integer('producto') ?: null,
            'id_bodega' => $request->integer('bodega') ?: null,
            'id_usuario' => $request->integer('usuario') ?: null,
            'tipo' => $tipo,
            'fecha_desde' => $this->fecha($request->query('desde')),
            'fecha_hasta' => $this->fecha($request->query('hasta')),
        ];
        if ($filtros['fecha_desde'] && $filtros['fecha_hasta'] && $filtros['fecha_desde'] > $filtros['fecha_hasta']) {
            return back()->withInput()->with('error', 'La fecha de inicio no puede ser posterior a la final.');
        }
        if ($descarga = $this->descargar($request, 'kardex', $filtros)) {
            return $descarga;
        }

        [$filas, $fallo] = Intento::de(fn () => $this->reportes->kardex($filtros));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());
        [$productos] = Intento::de(fn () => $this->catalogo->productos(['por_pagina' => 100])['datos']);
        $esAdministrador = $this->sesion->rol() === Roles::ADMINISTRADOR;
        // Solo el administrador puede listar a los usuarios para filtrar por quien registró el movimiento.
        [$usuarios] = $esAdministrador ? Intento::de(fn () => $this->usuarios->listar(['por_pagina' => 100])['datos']) : [[], null];

        return view('reportes.kardex', [
            'filas' => array_slice($filas ?? [], 0, self::FILAS_EN_PANTALLA),
            'total' => count($filas ?? []),
            'fallo' => $fallo !== null,
            // Con demasiados movimientos ms-reportes pide acotar (422) y dice cuántos hay: se muestra su aviso.
            'avisoDelServicio' => $fallo?->estado === 422 ? ($fallo->erroresPorCampo()['filtros'] ?? null) : null,
            'bodegas' => $bodegas ?? [],
            'productos' => collect($productos ?? [])->mapWithKeys(fn ($p) => [$p['id_producto'] => $p['nombre'].' ('.$p['codigo'].')'])->all(),
            'usuarios' => $esAdministrador ? collect($usuarios ?? [])->pluck('nombre', 'id_usuario')->all() : null,
            'filtros' => $filtros,
            'tipo' => $tipo,
            'filasEnPantalla' => self::FILAS_EN_PANTALLA,
        ]);
    }

    /**
     * Con `?formato=csv` o `pdf`, entrega el archivo tal cual lo generó ms-reportes (nombre y tipo incluidos). Un reporte muy
     * grande puede tardar más de los 3 s que el Gateway espera a cada servicio: entonces se explica cómo acotarlo.
     */
    private function descargar(Request $request, string $reporte, array $filtros): Response|RedirectResponse|null
    {
        $formato = $request->query('formato');
        if (! in_array($formato, ['csv', 'pdf'], true)) {
            return null;
        }

        try {
            $archivo = $this->reportes->archivo($reporte, $filtros, $formato);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);

            return back()->with('error', $e->esAmbigua()
                ? 'No se pudo generar el archivo. Si el reporte es muy grande, prueba con un periodo o una bodega más acotados.'
                : ($e->estado === 422 ? ($e->erroresPorCampo()['filtros'] ?? 'Revisa los filtros: no son válidos.') : 'No se pudo generar el archivo.'));
        }

        return response($archivo['cuerpo'], 200, array_filter([
            'Content-Type' => $archivo['tipo'],
            'Content-Disposition' => $archivo['disposicion'] ?? 'attachment; filename="'.$reporte.'.'.$formato.'"',
            'Cache-Control' => 'private, no-store',
        ]));
    }

    private function fecha(mixed $texto): ?string
    {
        return is_string($texto) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $texto) === 1 && strtotime($texto) !== false ? $texto : null;
    }
}
