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
use Illuminate\View\View;

/** Devoluciones de mercancía a un proveedor: sale del inventario de la bodega (RF13). */
class DevolucionController extends Controller
{
    use ResponderFallas;

    public function __construct(
        private readonly Compras $compras,
        private readonly Proveedores $proveedores,
        private readonly Catalogo $catalogo,
        private readonly Nombres $nombres,
        private readonly Sesion $sesion,
    ) {}

    public function index(Request $request): View
    {
        [$respuesta, $fallo] = Intento::de(fn () => $this->compras->devoluciones(['pagina' => max(1, $request->integer('pagina', 1))]));

        return view('compras.devoluciones.index', [
            'filas' => $this->nombres->conNombres($respuesta['datos'] ?? []),
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
        ]);
    }

    public function create(): View
    {
        $operador = $this->sesion->rol() === Roles::OPERADOR;
        if ($operador && $this->sesion->idBodega() === null) {
            return view('compras.devoluciones.crear', ['sinBodega' => true]);
        }

        [$proveedores] = Intento::de(fn () => $this->proveedores->todos(['estado' => 'ACTIVO']));
        [$productos] = Intento::de(fn () => $this->catalogo->todos(['estado' => 'ACTIVO']));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        return view('compras.devoluciones.crear', [
            'sinBodega' => false,
            'proveedores' => collect($proveedores ?? [])->pluck('razon_social', 'id_proveedor')->all(),
            'productos' => collect($productos ?? [])->mapWithKeys(fn ($p) => [$p['id_producto'] => $p['nombre'].' ('.$p['codigo'].')'])->all(),
            'bodegas' => collect($bodegas ?? [])->filter(fn ($b) => $b['activa'])->map(fn ($b) => $b['nombre'])->all(),
            'bodegaFija' => $operador ? $this->sesion->idBodega() : null,
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        $request->merge(['cantidad' => preg_replace('/[\s.]/', '', (string) $request->input('cantidad'))]);
        if ($this->sesion->rol() === Roles::OPERADOR && $this->sesion->idBodega() !== null) {
            $request->merge(['id_bodega' => $this->sesion->idBodega()]);
        }

        $datos = $request->validate([
            'id_proveedor' => ['required', 'integer', 'min:1'],
            'id_producto' => ['required', 'integer', 'min:1'],
            'id_bodega' => ['required', 'integer', 'min:1'],
            'cantidad' => ['required', 'integer', 'min:1', 'max:2147483647'],
            'motivo' => ['required', 'string', 'max:255'],
            'clave' => ['required', 'string', 'max:80', 'not_regex:/#/'],
        ], [
            'id_proveedor.required' => 'Elige el proveedor.',
            'id_producto.required' => 'Elige el producto.',
            'id_bodega.required' => 'Elige la bodega de donde sale la mercancía.',
            'cantidad.required' => 'Escribe la cantidad.',
            'cantidad.integer' => 'La cantidad debe ser un número entero, sin decimales.',
            'cantidad.min' => 'La cantidad debe ser mayor que 0.',
            'motivo.required' => 'Cuenta por qué se devuelve (por ejemplo: empaque roto).',
            'motivo.max' => 'El motivo no puede pasar de 255 caracteres.',
        ]);

        $cuerpo = [
            'id_proveedor' => (int) $datos['id_proveedor'],
            'id_producto' => (int) $datos['id_producto'],
            'id_bodega' => (int) $datos['id_bodega'],
            'cantidad' => (int) $datos['cantidad'],
            'motivo' => trim($datos['motivo']),
        ];

        try {
            $this->compras->crearDevolucion($cuerpo, $datos['clave']);
        } catch (GatewayException $e) {
            return $this->fallaDeEscritura($request, $e, ['motivo' => 'motivo']);
        }

        $producto = $this->nombres->productos([$cuerpo['id_producto']])[$cuerpo['id_producto']]['nombre'] ?? 'el producto';

        return redirect()->route('compras.devoluciones.index')->with('exito', 'Devolución registrada: salieron '.Formato::numero($cuerpo['cantidad'])." × {$producto} del inventario.");
    }
}
