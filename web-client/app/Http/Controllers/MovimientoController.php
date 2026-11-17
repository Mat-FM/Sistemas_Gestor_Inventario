<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFallas;
use App\Services\Catalogo;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Support\Formato;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Historial de movimientos (RF10) y registro de entradas y salidas (RF04). */
class MovimientoController extends Controller
{
    use ResponderFallas;

    /** Lo que el cliente web deja registrar hoy; los demás tipos los crean otros flujos o servicios. */
    private const TIPOS_QUE_SE_REGISTRAN = ['ENTRADA', 'SALIDA', 'DEVOLUCION_CLIENTE', 'AJUSTE'];

    private const CONFIRMACIONES = [
        'ENTRADA' => 'Entrada registrada',
        'SALIDA' => 'Salida registrada',
        'DEVOLUCION_CLIENTE' => 'Devolución de cliente registrada',
        'AJUSTE' => 'Ajuste registrado',
    ];

    public function __construct(
        private readonly Sesion $sesion,
        private readonly Inventario $inventario,
        private readonly Nombres $nombres,
    ) {}

    public function index(Request $request): View
    {
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        if ($operador && $this->sesion->idBodega() === null) {
            return view('movimientos.index', ['sinBodega' => true]);
        }

        $tipo = array_key_exists((string) $request->query('tipo'), Formato::TIPOS) ? $request->query('tipo') : null;
        $idBodega = $operador ? $this->sesion->idBodega() : ($request->integer('bodega') ?: null);
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        [$respuesta, $fallo] = Intento::de(fn () => $this->inventario->movimientos([
            'tipo' => $tipo,
            'id_bodega' => $idBodega,
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));

        return view('movimientos.index', [
            'sinBodega' => false,
            'filas' => $this->nombres->conNombres($respuesta['datos'] ?? []),
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'tipo' => $tipo,
            'idBodega' => $idBodega,
            'bodegas' => $bodegas ?? [],
            'puedeElegirBodega' => ! $operador,
            'puedeRegistrar' => $this->sesion->rol() !== Roles::CONTADOR,
        ]);
    }

    public function crear(Request $request, Catalogo $catalogo): View
    {
        $tipo = $this->tipoDe($request->query('tipo'));
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        if ($operador && $this->sesion->idBodega() === null) {
            return view('movimientos.crear', ['sinBodega' => true, 'tipo' => $tipo]);
        }

        $datos = ['sinBodega' => false, 'tipo' => $tipo, 'producto' => null, 'busqueda' => trim((string) $request->query('q', ''))];

        $idProducto = $request->integer('id_producto');
        if ($idProducto <= 0) {
            [$resultados, $fallo] = Intento::de(fn () => $catalogo->buscar($datos['busqueda']));

            return view('movimientos.crear', $datos + ['resultados' => $resultados ?? [], 'fallo' => $fallo !== null]);
        }

        $producto = $catalogo->obtener($idProducto);
        $idBodega = $operador ? $this->sesion->idBodega() : ($request->integer('id_bodega') ?: null);
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());
        [$saldos] = Intento::de(fn () => $this->inventario->saldosDeProductos([$idProducto], $idBodega)[$idProducto] ?? null);
        [$lotes] = Intento::de(fn () => $this->nombres->conNombres(
            $this->inventario->lotes(['id_producto' => $idProducto, 'id_bodega' => $idBodega, 'con_existencia' => 'true'])['datos']
        ));

        return view('movimientos.crear', array_merge($datos, [
            'producto' => $producto,
            'idBodega' => $idBodega,
            'bodegas' => array_filter($bodegas ?? [], static fn (array $bodega) => $bodega['activa']),
            'bodegaFija' => $operador,
            'saldos' => $saldos instanceof GatewayException ? [] : ($saldos['datos'] ?? []),
            'lotes' => $lotes ?? [],
        ]));
    }

    public function guardar(Request $request): RedirectResponse
    {
        $request->merge(['cantidad' => preg_replace('/[\s.]/', '', (string) $request->input('cantidad'))]);

        $datos = $request->validate([
            'tipo' => ['required', 'in:'.implode(',', self::TIPOS_QUE_SE_REGISTRAN)],
            'id_producto' => ['required', 'integer', 'min:1'],
            'id_bodega' => ['required', 'integer', 'min:1'],
            'cantidad' => ['required', 'integer', 'min:1', 'max:2147483647'],
            'sentido' => ['exclude_unless:tipo,AJUSTE', 'required', 'in:sube,baja'],
            'documento_referencia' => ['nullable', 'string', 'max:100'],
            // Un ajuste cambia el stock sin que entre ni salga mercancía: siempre debe decir por qué.
            'observacion' => [$request->input('tipo') === 'AJUSTE' ? 'required' : 'nullable', 'string', 'max:255'],
            'codigo_lote' => ['nullable', 'string', 'max:100', 'required_with:fecha_vencimiento'],
            'fecha_vencimiento' => ['nullable', 'date_format:Y-m-d', 'required_with:codigo_lote'],
            'clave' => ['required', 'string', 'max:200', 'not_regex:/#/'],
        ], [
            'id_bodega.required' => 'Elige la bodega.',
            'cantidad.required' => 'Escribe la cantidad.',
            'cantidad.integer' => 'La cantidad debe ser un número entero, sin decimales.',
            'cantidad.min' => 'La cantidad debe ser mayor que 0.',
            'cantidad.max' => 'Esa cantidad es demasiado grande.',
            'sentido.required' => 'Elige si el ajuste sube o baja el stock.',
            'sentido.in' => 'Elige si el ajuste sube o baja el stock.',
            'observacion.required' => 'Cuenta por qué se ajusta (por ejemplo: se encontró mercancía de más en el conteo).',
            'codigo_lote.required_with' => 'Si pones la fecha de vencimiento, escribe también el lote.',
            'fecha_vencimiento.required_with' => 'Si pones el lote, escribe también su fecha de vencimiento.',
            'fecha_vencimiento.date_format' => 'La fecha de vencimiento no es válida.',
        ]);

        // El operador solo mueve su bodega, aunque el formulario diga otra.
        $bodega = $this->sesion->rol() === Roles::OPERADOR ? $this->sesion->idBodega() : (int) $datos['id_bodega'];
        if ($bodega === null) {
            return back()->with('error', 'Todavía no tienes una bodega asignada. Habla con el administrador.');
        }

        $cuerpo = array_filter([
            'tipo' => $datos['tipo'],
            'id_producto' => (int) $datos['id_producto'],
            'id_bodega' => $bodega,
            // En un ajuste la cantidad lleva el signo: positiva sube el stock y negativa lo baja. En los demás tipos siempre es positiva.
            'cantidad' => $datos['tipo'] === 'AJUSTE' && $datos['sentido'] === 'baja' ? -(int) $datos['cantidad'] : (int) $datos['cantidad'],
            'documento_referencia' => $datos['documento_referencia'] ?? null,
            'observacion' => $datos['observacion'] ?? null,
        ], static fn ($valor) => $valor !== null && $valor !== '');
        if ($datos['tipo'] === 'ENTRADA' && ! empty($datos['codigo_lote'])) {
            $cuerpo['lote'] = ['codigo_lote' => $datos['codigo_lote'], 'fecha_vencimiento' => $datos['fecha_vencimiento']];
        }

        try {
            $respuesta = $this->inventario->registrarMovimiento($cuerpo, $datos['clave']);
        } catch (GatewayException $e) {
            return $this->fallaDeEscritura($request, $e, [
                'lote.codigo_lote' => 'codigo_lote',
                'lote.fecha_vencimiento' => 'fecha_vencimiento',
            ]);
        }

        $movimiento = $respuesta->cuerpo;
        // Un 200 es la respuesta guardada de una operación anterior con la misma clave: debe ser la misma operación.
        if ($respuesta->estado === 200 && ((int) ($movimiento['id_producto'] ?? 0) !== $cuerpo['id_producto']
            || (int) ($movimiento['cantidad'] ?? 0) !== $cuerpo['cantidad'])) {
            return back()->withInput($request->except('clave'))->with('error',
                'Esa operación ya estaba registrada con otros datos. Revisa el historial antes de repetirla.');
        }

        $producto = $this->nombres->productos([$cuerpo['id_producto']])[$cuerpo['id_producto']] ?? Nombres::productoDesconocido($cuerpo['id_producto']);

        return redirect()->route('movimientos.index')->with('exito', sprintf(
            '%s: %s × %s en %s. Ahora hay %s.',
            self::CONFIRMACIONES[$datos['tipo']],
            ($cuerpo['cantidad'] > 0 && $datos['tipo'] === 'AJUSTE' ? '+' : '').Formato::numero($cuerpo['cantidad']),
            $producto['nombre'],
            $this->nombres->bodegas()[$bodega]['nombre'] ?? "bodega #$bodega",
            Formato::numero($movimiento['saldo_resultante'] ?? null),
        ));
    }

    private function tipoDe(mixed $tipo): string
    {
        return in_array($tipo, self::TIPOS_QUE_SE_REGISTRAN, true) ? $tipo : 'ENTRADA';
    }
}
