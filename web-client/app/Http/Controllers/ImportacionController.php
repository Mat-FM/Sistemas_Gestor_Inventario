<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Services\Reportes;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;
use Illuminate\View\View;

/** Importación masiva de productos, proveedores y stock inicial desde CSV o Excel (RF16). Solo el administrador. */
class ImportacionController extends Controller
{
    /** Los errores por fila que se muestran: un archivo muy malo podría traer miles. */
    private const ERRORES_VISIBLES = 200;

    public function __construct(private readonly Reportes $reportes) {}

    public function index(Request $request): View
    {
        [$respuesta, $fallo] = Intento::de(fn () => $this->reportes->importaciones([
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));

        return view('importaciones.index', [
            'importables' => Reportes::IMPORTABLES,
            'filas' => $respuesta['datos'] ?? [],
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
        ]);
    }

    public function guardar(Request $request): RedirectResponse
    {
        $datos = $request->validate([
            'tipo' => ['required', Rule::in(array_keys(Reportes::IMPORTABLES))],
            'archivo' => ['required', 'file', 'max:2048', 'extensions:csv,txt,xlsx'],
        ], [
            'tipo.required' => 'Elige qué vas a importar.',
            'tipo.in' => 'Elige qué vas a importar.',
            'archivo.required' => 'Elige el archivo.',
            'archivo.file' => 'No se pudo leer el archivo.',
            'archivo.uploaded' => 'No se pudo subir el archivo: revisa que no pese más de 2 MB.',
            'archivo.max' => 'El archivo pesa más de 2 MB. Divídelo en partes.',
            'archivo.extensions' => 'El archivo debe ser CSV o Excel (.xlsx).',
        ]);

        $archivo = $request->file('archivo');
        try {
            $importacion = $this->reportes->importar($datos['tipo'], (string) file_get_contents($archivo->getRealPath()), $archivo->getClientOriginalName());
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->esAmbigua()) {
                // El Gateway espera 3 s: un archivo grande puede terminar de procesarse aunque aquí no se vea la respuesta.
                return redirect()->route('importaciones.index')->with('aviso',
                    'No recibimos la respuesta a tiempo. Puede que el archivo se esté procesando: revisa el historial antes de volver a subirlo.');
            }
            if ($e->estado === 422) {
                return back()->withInput()->withErrors(['archivo' => ucfirst($e->erroresPorCampo()['archivo'] ?? ($e->getMessage() ?: 'El archivo no se pudo leer.'))]);
            }

            return back()->withInput()->with('error', match (true) {
                $e->estado === 413 => 'El archivo es demasiado grande. Divídelo en partes.',
                $e->estado === 429 => 'Hiciste muchas peticiones seguidas. Espera un momento e intenta de nuevo.',
                default => $e->getMessage() ?: 'No se pudo importar el archivo.',
            });
        }

        $enviar = redirect()->route('importaciones.show', $importacion['id_importacion']);

        return match ($importacion['estado']) {
            'PROCESADA' => $enviar->with('exito', 'Importación terminada: se crearon '.$importacion['filas_validas'].' filas sin errores.'),
            'CON_ERRORES' => $enviar->with('aviso', 'Importación terminada con errores: revisa las filas que no se pudieron crear.'),
            default => $enviar->with('error', 'La importación no se completó porque un servicio no respondió. Revisa cuántas filas llegaron a crearse antes de repetirla.'),
        };
    }

    public function show(int $id): View
    {
        $importacion = $this->reportes->importacion($id);
        $errores = $importacion['errores'] ?? [];

        return view('importaciones.show', [
            'importacion' => $importacion,
            'tipo' => Reportes::IMPORTABLES[$importacion['tipo']]['nombre'] ?? $importacion['tipo'],
            'errores' => array_slice($errores, 0, self::ERRORES_VISIBLES),
            'erroresOcultos' => max(0, count($errores) - self::ERRORES_VISIBLES),
        ]);
    }

    /** Un CSV con solo el encabezado, para que el archivo salga con las columnas exactas (UTF-8 con BOM y «;», como los reportes). */
    public function plantilla(string $tipo): Response
    {
        abort_unless(isset(Reportes::IMPORTABLES[$tipo]), 404);

        return response("\xEF\xBB\xBF".implode(';', Reportes::IMPORTABLES[$tipo]['columnas'])."\r\n", 200, [
            'Content-Type' => 'text/csv; charset=UTF-8',
            'Content-Disposition' => 'attachment; filename="plantilla-'.strtolower(str_replace('_', '-', $tipo)).'.csv"',
        ]);
    }
}
