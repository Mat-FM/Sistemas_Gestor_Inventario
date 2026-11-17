<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFallas;
use App\Services\Catalogo;
use App\Services\Compras;
use App\Services\Nombres;
use App\Services\Proveedores;
use App\Support\Formato;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;

/** Órdenes de compra a proveedores: crear, enviar, anular y recibir la mercancía total o parcialmente (RF06). */
class OrdenCompraController extends Controller
{
    use ResponderFallas;

    private const ESTADOS = ['CREADA', 'ENVIADA', 'RECIBIDA_PARCIAL', 'RECIBIDA', 'ANULADA'];

    public function __construct(
        private readonly Compras $compras,
        private readonly Proveedores $proveedores,
        private readonly Catalogo $catalogo,
        private readonly Nombres $nombres,
        private readonly Sesion $sesion,
    ) {}

    public function index(Request $request): View
    {
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        $estado = in_array($request->query('estado'), self::ESTADOS, true) ? $request->query('estado') : null;
        // Un operador abre por defecto las órdenes que llegan a SU bodega; puede ver las de todas.
        $soloMiBodega = $operador && $this->sesion->idBodega() !== null && ! $request->boolean('todas');

        [$respuesta, $fallo] = Intento::de(fn () => $this->compras->ordenes([
            'estado' => $estado,
            'id_bodega_destino' => $soloMiBodega ? $this->sesion->idBodega() : null,
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));

        return view('compras.ordenes.index', [
            'filas' => $this->nombres->conNombres($respuesta['datos'] ?? []),
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'estado' => $estado,
            'soloMiBodega' => $soloMiBodega,
            'esOperador' => $operador,
            'puedeCrear' => $this->sesion->rol() === Roles::ADMINISTRADOR,
        ]);
    }

    public function show(int $id): View
    {
        $orden = $this->compras->orden($id);
        $detalles = $this->nombres->conNombres($orden['detalles'] ?? []);
        $recepciones = $this->nombres->conNombres($orden['recepciones'] ?? []);
        [$proveedores] = Intento::de(fn () => $this->nombres->proveedores([$orden['id_proveedor']]));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        $administrador = $this->sesion->rol() === Roles::ADMINISTRADOR;
        $recibible = in_array($orden['estado'], ['ENVIADA', 'RECIBIDA_PARCIAL'], true);
        $deMiBodega = $this->sesion->rol() === Roles::OPERADOR && $this->sesion->idBodega() === (int) $orden['id_bodega_destino'];

        return view('compras.ordenes.ver', [
            'orden' => $orden,
            'detalles' => $detalles,
            'recepciones' => $recepciones,
            'proveedor' => $proveedores[(int) $orden['id_proveedor']] ?? 'Proveedor #'.$orden['id_proveedor'],
            'bodega' => $bodegas[(int) $orden['id_bodega_destino']]['nombre'] ?? 'Bodega #'.$orden['id_bodega_destino'],
            'puedeRecibir' => $recibible && ($administrador || $deMiBodega),
            'puedeEnviar' => $administrador && $orden['estado'] === 'CREADA',
            'puedeAnular' => $administrador && (
                $orden['estado'] === 'CREADA' || ($orden['estado'] === 'ENVIADA' && ($orden['recepciones'] ?? []) === [])
            ),
            'esOperadorAjeno' => $this->sesion->rol() === Roles::OPERADOR && ! $deMiBodega,
        ]);
    }

    public function create(): View
    {
        [$proveedores] = Intento::de(fn () => $this->proveedores->listar(['estado' => 'ACTIVO', 'por_pagina' => 100])['datos']);
        [$productos] = Intento::de(fn () => $this->catalogo->productos(['estado' => 'ACTIVO', 'por_pagina' => 100])['datos']);
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        return view('compras.ordenes.crear', [
            'proveedores' => collect($proveedores ?? [])->pluck('razon_social', 'id_proveedor')->all(),
            'productos' => collect($productos ?? [])->keyBy('id_producto')->all(),
            'bodegas' => collect($bodegas ?? [])->filter(fn ($b) => $b['activa'])->map(fn ($b) => $b['nombre'])->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        $lineas = collect($request->input('lineas', []))
            ->filter(fn ($l) => is_array($l) && ($l['id_producto'] ?? '') !== '' && ($l['cantidad'] ?? '') !== '')
            ->map(fn (array $l) => [
                'id_producto' => $l['id_producto'],
                'cantidad' => preg_replace('/[\s.]/', '', (string) $l['cantidad']),
                'precio' => Formato::normalizarDecimal((string) ($l['precio'] ?? '')),
            ])->values()->all();
        $request->merge(['lineas' => $lineas]);

        $datos = $request->validate([
            'id_proveedor' => ['required', 'integer', 'min:1'],
            'id_bodega_destino' => ['required', 'integer', 'min:1'],
            'fecha_esperada' => ['required', 'date_format:Y-m-d', 'after_or_equal:today'],
            'lineas' => ['required', 'array', 'min:1'],
            'lineas.*.id_producto' => ['required', 'integer', 'min:1'],
            'lineas.*.cantidad' => ['required', 'integer', 'min:1', 'max:2147483647'],
            'lineas.*.precio' => ['required', 'numeric', 'min:0', 'max:9999999999'],
        ], [
            'id_proveedor.required' => 'Elige el proveedor.',
            'id_bodega_destino.required' => 'Elige la bodega a la que llegará la mercancía.',
            'fecha_esperada.required' => 'Escribe la fecha en que esperas la mercancía.',
            'fecha_esperada.date_format' => 'La fecha no es válida.',
            'fecha_esperada.after_or_equal' => 'La fecha esperada no puede ser anterior a hoy.',
            'lineas.required' => 'Agrega al menos un producto a la orden.',
            'lineas.min' => 'Agrega al menos un producto a la orden.',
            'lineas.*.cantidad.required' => 'Escribe la cantidad de cada producto.',
            'lineas.*.cantidad.integer' => 'Las cantidades deben ser números enteros, sin decimales.',
            'lineas.*.cantidad.min' => 'Las cantidades deben ser mayores que 0.',
            'lineas.*.precio.required' => 'Escribe el precio de cada producto.',
            'lineas.*.precio.numeric' => 'Los precios deben ser números (por ejemplo 15.000 o 15000,50).',
            'lineas.*.precio.min' => 'Los precios no pueden ser negativos.',
        ]);

        $cuerpo = [
            'id_proveedor' => (int) $datos['id_proveedor'],
            'id_bodega_destino' => (int) $datos['id_bodega_destino'],
            'fecha_esperada' => $datos['fecha_esperada'],
            'detalles' => array_map(static fn (array $l) => [
                'id_producto' => (int) $l['id_producto'],
                'cantidad_pedida' => (int) $l['cantidad'],
                'precio_unitario' => (float) $l['precio'],
            ], $datos['lineas']),
        ];

        try {
            $orden = $this->compras->crearOrden($cuerpo);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);

            return back()->withInput()->with('error', match (true) {
                $e->esAmbigua() => 'El sistema no respondió. Revisa la lista de órdenes antes de crearla otra vez, por si ya quedó guardada.',
                $e->estado === 404 => 'Ese proveedor, bodega o producto ya no existe.',
                $e->estado === 422 => 'Revisa los datos: '.collect($e->erroresPorCampo())->implode(' '),
                default => $e->getMessage() ?: 'No se pudo crear la orden.',
            });
        }

        return redirect()->route('compras.ordenes.show', $orden['id_orden'])->with('exito', "Orden {$orden['numero']} creada. Envíala al proveedor cuando esté lista.");
    }

    public function estado(Request $request, int $id): RedirectResponse
    {
        $datos = $request->validate(['estado' => ['required', 'in:ENVIADA,ANULADA']]);

        try {
            $orden = $this->compras->cambiarEstado($id, $datos['estado']);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado === 409) {
                return back()->with('error', 'Esa orden ya no admite ese cambio (por ejemplo, ya tiene mercancía recibida). Recarga la pantalla para ver su estado.');
            }
            throw $e;
        }

        return back()->with('exito', $datos['estado'] === 'ENVIADA' ? "Orden {$orden['numero']} enviada al proveedor." : "Orden {$orden['numero']} anulada.");
    }

    public function recibir(Request $request, int $id): RedirectResponse
    {
        $request->validate(['clave' => ['required', 'string', 'max:80', 'not_regex:/#/']]);

        $lineas = [];
        $errores = [];
        foreach ((array) $request->input('lineas', []) as $idDetalle => $linea) {
            $cantidad = preg_replace('/[\s.]/', '', (string) ($linea['cantidad'] ?? ''));
            if ($cantidad === '') {
                continue; // Sin cantidad: esa línea no se recibe ahora.
            }
            $codigo = trim((string) ($linea['codigo_lote'] ?? ''));
            $vence = trim((string) ($linea['fecha_vencimiento'] ?? ''));
            if (! ctype_digit($cantidad) || (int) $cantidad < 1) {
                $errores["lineas.$idDetalle.cantidad"] = 'La cantidad debe ser un número entero mayor que 0.';
            }
            if (($codigo === '') !== ($vence === '')) {
                $errores["lineas.$idDetalle.codigo_lote"] = 'El lote y su fecha de vencimiento van juntos: escribe los dos o ninguno.';
            }
            $lineas[] = array_filter([
                'id_detalle' => (int) $idDetalle,
                'cantidad' => (int) $cantidad,
                'codigo_lote' => $codigo,
                'fecha_vencimiento' => $vence,
            ], static fn ($valor) => $valor !== '');
        }
        if ($lineas === [] && $errores === []) {
            $errores['lineas'] = 'Escribe la cantidad que llegó de al menos un producto.';
        }
        if ($errores !== []) {
            throw ValidationException::withMessages($errores);
        }

        try {
            $respuesta = $this->compras->recibir($id, $lineas, $request->input('clave'));
        } catch (GatewayException $e) {
            return $this->fallaDeRecepcion($request, $e, $id);
        }

        $estado = $respuesta->cuerpo['estado'] ?? null;

        return redirect()->route('compras.ordenes.show', $id)->with('exito', $estado === 'RECIBIDA'
            ? 'Mercancía recibida: la orden quedó completa y el stock ya subió.'
            : 'Mercancía recibida: el stock ya subió. La orden sigue abierta hasta que llegue el resto.');
    }

    /**
     * Si algunas líneas se registraron y otras no, la clave se CONSERVA: repetir con la misma clave solo completa las que
     * faltan; con otra clave se duplicaría lo ya recibido.
     */
    private function fallaDeRecepcion(Request $request, GatewayException $e, int $id): RedirectResponse
    {
        Intento::propagarSiAfectaATodo($e);

        $porLinea = collect($e->detalles)->filter(fn ($d) => is_array($d) && isset($d['id_detalle']))->values();
        if ($porLinea->isNotEmpty()) {
            [$orden] = Intento::de(fn () => $this->compras->orden($id));
            $productos = $this->nombres->conNombres($orden['detalles'] ?? []);
            $nombreDe = collect($productos)->mapWithKeys(fn ($d) => [(int) $d['id_detalle'] => $d['producto']['nombre']])->all();
            $texto = $porLinea->map(fn ($d) => '«'.($nombreDe[(int) $d['id_detalle']] ?? 'línea '.$d['id_detalle']).'»: '.($d['mensaje'] ?? 'no se pudo recibir'))->implode(' · ');

            return back()->withInput()->with('error', 'Algunas líneas no se pudieron recibir ('.$texto.'). Corrige y toca Recibir otra vez: lo que ya se recibió no se repite.');
        }

        if ($e->esAmbigua()) {
            return back()->withInput()->with('error', 'No pudimos confirmar la recepción porque el sistema no respondió. Toca Recibir otra vez: si ya se había guardado, no se repite.');
        }

        $redireccion = back()->withInput($request->except('clave'));

        return $redireccion->with('error', match (true) {
            $e->estado === 403 => 'Solo puedes recibir en tu propia bodega.',
            $e->estado === 404 => 'Esa orden ya no existe.',
            $e->estado === 409 => $e->getMessage() ?: 'Esa orden ya no se puede recibir.',
            $e->estado === 422 => 'Revisa las cantidades: '.collect($e->detalles)->pluck('mensaje')->filter()->implode(' '),
            default => $e->getMessage() ?: 'No se pudo recibir la mercancía.',
        });
    }
}
