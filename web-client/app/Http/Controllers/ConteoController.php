<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\View\View;

/**
 * Conteos físicos (RF18): el administrador programa uno por bodega, el operador de esa bodega registra lo contado y el
 * administrador lo aprueba, con lo que el inventario se ajusta a lo contado.
 */
class ConteoController extends Controller
{
    private const ESTADOS = ['PROGRAMADO', 'EN_REVISION', 'APROBADO'];

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
            return view('conteos.index', ['sinBodega' => true]);
        }

        $estado = in_array($request->query('estado'), [...self::ESTADOS, 'todos'], true) ? $request->query('estado') : 'todos';
        [$respuesta, $fallo] = Intento::de(fn () => $this->inventario->conteos([
            'estado' => $estado === 'todos' ? null : $estado,
            'id_bodega' => $operador ? $miBodega : null,
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));

        return view('conteos.index', [
            'sinBodega' => false,
            'estado' => $estado,
            'filas' => $this->nombres->conNombres($respuesta['datos'] ?? []),
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'puedeProgramar' => $this->sesion->rol() === Roles::ADMINISTRADOR,
        ]);
    }

    public function crear(): View
    {
        [$bodegas, $fallo] = Intento::de(fn () => $this->nombres->bodegas());

        return view('conteos.crear', [
            'bodegas' => array_filter($bodegas ?? [], static fn (array $bodega) => $bodega['activa']),
            'fallo' => $fallo !== null,
            // El servicio compara con el día UTC: ofrecer ese día evita rechazar «hoy» por la noche (hora de Bogotá).
            'hoy' => gmdate('Y-m-d'),
        ]);
    }

    public function guardar(Request $request): RedirectResponse
    {
        $datos = $request->validate([
            'id_bodega' => ['required', 'integer', 'min:1'],
            'fecha_programada' => ['required', 'date_format:Y-m-d', 'after_or_equal:'.gmdate('Y-m-d')],
        ], [
            'id_bodega.required' => 'Elige la bodega que se va a contar.',
            'fecha_programada.required' => 'Elige la fecha del conteo.',
            'fecha_programada.date_format' => 'Escribe la fecha completa.',
            'fecha_programada.after_or_equal' => 'La fecha no puede ser anterior a hoy.',
        ]);

        try {
            $conteo = $this->inventario->programarConteo([
                'id_bodega' => (int) $datos['id_bodega'],
                'fecha_programada' => $datos['fecha_programada'],
            ]);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->esAmbigua()) {
                // Programar no lleva clave de idempotencia: repetir sin mirar la lista podría dejar dos conteos.
                return back()->withInput()->with('error', 'No pudimos confirmar si se programó, porque el sistema no respondió. Revisa la lista de conteos antes de repetirlo.');
            }
            if ($e->estado === 422 && $e->erroresPorCampo() !== []) {
                $errores = [];
                foreach ($e->erroresPorCampo() as $campo => $mensaje) {
                    $errores[$campo === 'ids_producto' ? 'id_bodega' : $campo] = ucfirst($mensaje);
                }

                return back()->withInput()->withErrors($errores);
            }

            return back()->withInput()->with('error', match (true) {
                $e->estado === 404 => 'Esa bodega ya no existe.',
                $e->codigo === 'BODEGA_INACTIVA' => 'Esa bodega está inactiva: no admite conteos nuevos.',
                default => $e->getMessage() ?: 'No se pudo programar el conteo.',
            });
        }

        return redirect()->route('conteos.show', $conteo['id_conteo'])->with('exito', 'Conteo programado. Cuenta lo que hay en la bodega y registra las cantidades.');
    }

    public function show(int $id): View
    {
        $conteo = $this->inventario->conteo($id);
        $detalles = $this->nombres->conNombres($conteo['detalles'] ?? []);
        $conteo['bodega'] = $this->nombreDeBodega((int) $conteo['id_bodega']);
        $abierto = $conteo['estado'] !== 'APROBADO';
        $esAdministrador = $this->sesion->rol() === Roles::ADMINISTRADOR;

        return view('conteos.show', [
            'conteo' => $conteo,
            'lineas' => $detalles,
            'puedeContar' => $abierto,
            'puedeAprobar' => $esAdministrador && $conteo['estado'] === 'EN_REVISION',
            'contadas' => count(array_filter($detalles, static fn (array $linea) => $linea['cantidad_contada'] !== null)),
            'conDiferencia' => count(array_filter($detalles, static fn (array $linea) => $linea['cantidad_contada'] !== null && (int) $linea['diferencia'] !== 0)),
            // La clave se genera al mostrar la pantalla: tocar dos veces «Aprobar» repite la misma operación.
            'clave' => (string) Str::uuid(),
        ]);
    }

    public function registrar(Request $request, int $id): RedirectResponse
    {
        $detalles = [];
        $errores = [];
        foreach ((array) $request->input('contadas', []) as $idProducto => $valor) {
            $valor = preg_replace('/[\s.]/', '', (string) $valor);
            if ($valor === '' || $valor === null) {
                continue;
            }
            if (! ctype_digit($valor) || (int) $valor > 2147483647) {
                $errores["contadas.$idProducto"] = 'Escribe un número entero de 0 en adelante.';

                continue;
            }
            $detalles[] = ['id_producto' => (int) $idProducto, 'cantidad_contada' => (int) $valor];
        }

        if ($errores !== []) {
            return back()->withInput()->withErrors($errores)->with('error', 'Revisa las cantidades marcadas: deben ser números enteros.');
        }
        if ($detalles === []) {
            return back()->withInput()->with('error', 'Escribe al menos una cantidad contada.');
        }

        try {
            $this->inventario->registrarConteo($id, $detalles);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->esAmbigua()) {
                return back()->withInput()->with('error', 'No pudimos confirmar si se guardó, porque el sistema no respondió. Toca Guardar otra vez: repetirlo deja el mismo resultado.');
            }

            return back()->withInput()->with('error', match (true) {
                $e->codigo === 'CONTEO_ESTADO_INVALIDO' => 'Ese conteo ya fue aprobado: no admite más cantidades.',
                $e->estado === 403 => 'Solo se cuenta en la bodega que te asignaron.',
                $e->estado === 404 => 'Ese conteo ya no existe.',
                default => $e->getMessage() ?: 'No se pudieron guardar las cantidades.',
            });
        }

        return redirect()->route('conteos.show', $id)->with('exito', 'Cantidades guardadas. Un administrador puede aprobar el conteo cuando estén todas.');
    }

    public function aprobar(Request $request, int $id): RedirectResponse
    {
        $datos = $request->validate(['clave' => ['required', 'string', 'max:200', 'not_regex:/#/']]);

        try {
            $resultado = $this->inventario->aprobarConteo($id, $datos['clave']);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->esAmbigua()) {
                return back()->with('error', 'No pudimos confirmar si se aprobó, porque el sistema no respondió. Revisa el estado del conteo antes de repetirlo.');
            }

            return back()->with('error', match (true) {
                $e->codigo === 'STOCK_INSUFICIENTE' => 'No se puede aprobar: un ajuste negativo deja un producto con menos de lo que ya salió. Revisa lo contado.',
                $e->codigo === 'BODEGA_INACTIVA' => 'La bodega está inactiva: no admite ajustes.',
                $e->codigo === 'CONTEO_ESTADO_INVALIDO' => 'Ese conteo ya no está en revisión.',
                $e->estado === 404 => 'Ese conteo ya no existe.',
                default => $e->getMessage() ?: 'No se pudo aprobar el conteo.',
            });
        }

        $ajustes = count($resultado['movimientos'] ?? []);

        return redirect()->route('conteos.show', $id)->with('exito', $ajustes > 0
            ? 'Conteo aprobado: el inventario se ajustó en '.$ajustes.' '.($ajustes === 1 ? 'producto' : 'productos').'.'
            : 'Conteo aprobado: lo contado coincide con el sistema, no hizo falta ajustar nada.');
    }

    private function nombreDeBodega(int $id): string
    {
        [$nombre] = Intento::de(fn () => $this->nombres->bodega($id));

        return $nombre ?? "Bodega #$id";
    }
}
