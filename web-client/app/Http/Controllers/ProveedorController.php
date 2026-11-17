<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Catalogo;
use App\Services\Nombres;
use App\Services\Proveedores;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Proveedores y los productos que suministran (RF03). */
class ProveedorController extends Controller
{
    use ResponderFormularios;

    public function __construct(
        private readonly Proveedores $proveedores,
        private readonly Catalogo $catalogo,
        private readonly Nombres $nombres,
    ) {}

    public function index(Request $request): View
    {
        $texto = trim((string) $request->query('q', ''));
        $estado = in_array($request->query('estado'), ['ACTIVO', 'INACTIVO'], true) ? $request->query('estado') : null;

        [$respuesta, $fallo] = Intento::de(function () use ($request, $texto, $estado) {
            if ($texto === '') {
                return $this->proveedores->listar(['estado' => $estado, 'pagina' => max(1, $request->integer('pagina', 1))]);
            }
            $unidos = [];
            foreach (['razon_social', 'nit'] as $campo) {
                foreach ($this->proveedores->listar([$campo => $texto, 'estado' => $estado, 'por_pagina' => 50])['datos'] as $proveedor) {
                    $unidos[$proveedor['id_proveedor']] ??= $proveedor;
                }
            }

            return ['datos' => array_values($unidos), 'meta' => null];
        });

        return view('proveedores.index', [
            'proveedores' => $respuesta['datos'] ?? [],
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'texto' => $texto,
            'estado' => $estado,
        ]);
    }

    public function show(Request $request, int $id): View
    {
        $proveedor = $this->proveedores->obtener($id);
        [$asociados, $falloAsociados] = Intento::de(fn () => $this->proveedores->productos($id));
        $productos = $this->nombres->productos(array_column($asociados ?? [], 'id_producto'));

        $texto = trim((string) $request->query('q', ''));
        $yaAsociados = array_map('intval', array_column($asociados ?? [], 'id_producto'));
        [$resultados, $falloBusqueda] = $texto === '' ? [[], null] : Intento::de(fn () => $this->catalogo->buscar($texto));

        return view('proveedores.ver', [
            'proveedor' => $proveedor,
            'asociados' => array_map(fn (array $a) => $a + ['producto' => $productos[(int) $a['id_producto']] ?? Nombres::productoDesconocido((int) $a['id_producto'])], $asociados ?? []),
            'falloAsociados' => $falloAsociados !== null,
            'texto' => $texto,
            'resultados' => array_values(array_filter($resultados ?? [], fn ($p) => ! in_array((int) $p['id_producto'], $yaAsociados, true))),
            'falloBusqueda' => $falloBusqueda !== null,
        ]);
    }

    public function create(): View
    {
        return view('proveedores.formulario', ['proveedor' => null]);
    }

    public function store(Request $request): RedirectResponse
    {
        $datos = $this->validar($request, true);

        try {
            $proveedor = $this->proveedores->crear($datos);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('proveedores.show', $proveedor['id_proveedor'])->with('exito', 'Proveedor creado. Ahora puedes asociarle los productos que suministra.');
    }

    public function edit(int $id): View
    {
        return view('proveedores.formulario', ['proveedor' => $this->proveedores->obtener($id)]);
    }

    public function update(Request $request, int $id): RedirectResponse
    {
        $datos = $this->validar($request, false);

        try {
            $this->proveedores->actualizar($id, $datos);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('proveedores.show', $id)->with('exito', 'Proveedor guardado.');
    }

    public function inactivar(int $id): RedirectResponse
    {
        $proveedor = $this->proveedores->cambiarEstado($id, false);

        return back()->with('exito', "«{$proveedor['razon_social']}» quedó inactivo.");
    }

    public function activar(int $id): RedirectResponse
    {
        $proveedor = $this->proveedores->cambiarEstado($id, true);

        return back()->with('exito', "«{$proveedor['razon_social']}» quedó activo.");
    }

    public function asociar(Request $request, int $id): RedirectResponse
    {
        $datos = $request->validate(['id_producto' => ['required', 'integer', 'min:1']]);

        try {
            $this->proveedores->asociar($id, (int) $datos['id_producto']);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado === 409) {
                return back()->with('aviso', 'Ese producto ya estaba asociado.');
            }

            return back()->with('error', $e->estado === 404 ? 'Ese producto o proveedor ya no existe.' : 'No se pudo asociar el producto. Intenta de nuevo.');
        }

        return redirect()->route('proveedores.show', $id)->with('exito', 'Producto asociado.');
    }

    public function quitar(int $id, int $producto): RedirectResponse
    {
        $this->proveedores->quitar($id, $producto);

        return back()->with('exito', 'Producto quitado de este proveedor.');
    }

    /** @return array<string, string> */
    private function validar(Request $request, bool $crear): array
    {
        $datos = $request->validate([
            'nit' => $crear ? ['required', 'string', 'max:20'] : ['nullable'],
            'razon_social' => ['required', 'string', 'max:150'],
            'nombre_contacto' => ['required', 'string', 'max:100'],
            'telefono' => ['required', 'string', 'max:20'],
            'correo' => ['required', 'string', 'email', 'max:255'],
            'direccion' => ['required', 'string', 'max:255'],
        ], [
            'nit.required' => 'Escribe el NIT.',
            'nit.max' => 'El NIT no puede pasar de 20 caracteres.',
            'razon_social.required' => 'Escribe la razón social.',
            'razon_social.max' => 'La razón social no puede pasar de 150 caracteres.',
            'nombre_contacto.required' => 'Escribe el nombre de la persona de contacto.',
            'nombre_contacto.max' => 'El nombre no puede pasar de 100 caracteres.',
            'telefono.required' => 'Escribe el teléfono.',
            'telefono.max' => 'El teléfono no puede pasar de 20 caracteres.',
            'correo.required' => 'Escribe el correo.',
            'correo.email' => 'Escribe un correo válido, por ejemplo ventas@proveedor.com.',
            'direccion.required' => 'Escribe la dirección.',
            'direccion.max' => 'La dirección no puede pasar de 255 caracteres.',
        ]);

        return array_filter(array_map(static fn ($valor) => is_string($valor) ? trim($valor) : $valor, $datos), static fn ($valor) => $valor !== null && $valor !== '');
    }
}
