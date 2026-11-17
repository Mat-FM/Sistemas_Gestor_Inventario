<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Nombres;
use App\Services\Usuarios;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\View\View;

/** Usuarios del sistema, sus roles y bodegas, y el restablecimiento de contraseñas (RF07). */
class UsuarioController extends Controller
{
    use ResponderFormularios;

    private const MENSAJE_CONTRASENA = 'La contraseña temporal debe tener al menos 8 caracteres, con una letra y un número.';

    public function __construct(
        private readonly Usuarios $usuarios,
        private readonly Nombres $nombres,
        private readonly Sesion $sesion,
    ) {}

    public function index(Request $request): View
    {
        [$respuesta, $fallo] = Intento::de(fn () => $this->usuarios->listar(['pagina' => max(1, $request->integer('pagina', 1))]));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());

        return view('usuarios.index', [
            'usuarios' => $respuesta['datos'] ?? [],
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'bodegas' => $bodegas ?? [],
            'yo' => (int) ($this->sesion->usuario()['id_usuario'] ?? 0),
        ]);
    }

    public function create(): View
    {
        return view('usuarios.formulario', ['usuario' => null] + $this->opciones());
    }

    public function store(Request $request): RedirectResponse
    {
        $datos = $this->validar($request, true);

        try {
            $usuario = $this->usuarios->crear($this->cuerpo($datos) + ['contrasena_temporal' => $datos['contrasena_temporal']]);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('usuarios.index')->with('exito', "Usuario «{$usuario['nombre']}» creado. Entrégale la contraseña temporal: la cambiará al entrar.");
    }

    public function edit(int $id): View
    {
        return view('usuarios.formulario', ['usuario' => $this->usuarios->obtener($id), 'yo' => (int) ($this->sesion->usuario()['id_usuario'] ?? 0)] + $this->opciones());
    }

    public function update(Request $request, int $id): RedirectResponse
    {
        $datos = $this->validar($request, false);

        try {
            $usuario = $this->usuarios->actualizar($id, $this->cuerpo($datos));
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('usuarios.index')->with('exito', "Usuario «{$usuario['nombre']}» guardado.");
    }

    public function inactivar(int $id): RedirectResponse
    {
        if ($id === (int) ($this->sesion->usuario()['id_usuario'] ?? 0)) {
            return back()->with('error', 'No puedes inactivar tu propio usuario.');
        }

        $usuario = $this->usuarios->cambiarEstado($id, false);

        return back()->with('exito', "«{$usuario['nombre']}» quedó inactivo: ya no puede entrar.");
    }

    public function activar(int $id): RedirectResponse
    {
        $usuario = $this->usuarios->cambiarEstado($id, true);

        return back()->with('exito', "«{$usuario['nombre']}» quedó activo.");
    }

    public function restablecer(Request $request, int $id): RedirectResponse
    {
        $datos = $request->validate([
            'contrasena_temporal' => ['required', 'string', 'min:8', 'max:72', 'regex:/[A-Za-z]/', 'regex:/\d/'],
        ], [
            'contrasena_temporal.required' => 'Escribe la contraseña temporal.',
            'contrasena_temporal.min' => self::MENSAJE_CONTRASENA,
            'contrasena_temporal.max' => 'La contraseña no puede pasar de 72 caracteres.',
            'contrasena_temporal.regex' => self::MENSAJE_CONTRASENA,
        ]);

        try {
            $this->usuarios->restablecerContrasena($id, $datos['contrasena_temporal']);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('usuarios.edit', $id)->with('exito', 'Contraseña restablecida. Su sesión actual se cerró y deberá cambiarla al entrar.');
    }

    /** @return array{roles: array<int, string>, bodegas: array<int, string>, idRolOperador: int|null} */
    private function opciones(): array
    {
        [$roles] = Intento::de(fn () => $this->usuarios->roles());
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());
        $roles ??= [];

        return [
            'roles' => array_map(static fn (string $nombre) => Roles::nombre($nombre), $roles),
            'bodegas' => array_map(static fn (array $bodega) => $bodega['nombre'], array_filter($bodegas ?? [], static fn (array $bodega) => $bodega['activa'])),
            'idRolOperador' => array_search(Roles::OPERADOR, $roles, true) ?: null,
        ];
    }

    /** @return array<string, mixed> */
    private function validar(Request $request, bool $crear): array
    {
        [$roles] = Intento::de(fn () => $this->usuarios->roles());
        $idRolOperador = array_search(Roles::OPERADOR, $roles ?? [], true) ?: null;

        return $request->validate([
            'nombre' => ['required', 'string', 'max:100'],
            'correo' => ['required', 'string', 'email', 'max:255'],
            'id_rol' => ['required', 'integer', Rule::in(array_keys($roles ?? []))],
            'id_bodega' => [Rule::requiredIf($idRolOperador !== null && (int) $request->input('id_rol') === $idRolOperador), 'nullable', 'integer', 'min:1'],
            'contrasena_temporal' => $crear ? ['required', 'string', 'min:8', 'max:72', 'regex:/[A-Za-z]/', 'regex:/\d/'] : ['nullable'],
        ], [
            'nombre.required' => 'Escribe el nombre completo.',
            'nombre.max' => 'El nombre no puede pasar de 100 caracteres.',
            'correo.required' => 'Escribe el correo.',
            'correo.email' => 'Escribe un correo válido, por ejemplo ana@elmontanero.com.',
            'id_rol.required' => 'Elige el rol.',
            'id_rol.in' => 'Elige uno de los roles de la lista.',
            'id_bodega.required' => 'Un operador de bodega necesita una bodega asignada.',
            'contrasena_temporal.required' => 'Escribe una contraseña temporal.',
            'contrasena_temporal.min' => self::MENSAJE_CONTRASENA,
            'contrasena_temporal.max' => 'La contraseña no puede pasar de 72 caracteres.',
            'contrasena_temporal.regex' => self::MENSAJE_CONTRASENA,
        ]);
    }

    /** Solo el operador de bodega tiene bodega; para los demás roles el campo se manda vacío. */
    private function cuerpo(array $datos): array
    {
        [$roles] = Intento::de(fn () => $this->usuarios->roles());
        $esOperador = ($roles[(int) $datos['id_rol']] ?? null) === Roles::OPERADOR;

        return [
            'nombre' => trim($datos['nombre']),
            'correo' => mb_strtolower(trim($datos['correo'])),
            'id_rol' => (int) $datos['id_rol'],
            'id_bodega' => $esOperador && ! empty($datos['id_bodega']) ? (int) $datos['id_bodega'] : null,
        ];
    }
}
