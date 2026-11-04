<?php

namespace App\Http\Controllers;

use App\Http\Resources\UsuarioResource;
use App\Http\Support\Paginated;
use App\Models\Usuario;
use App\Rules\ContrasenaValida;
use App\Services\Usuarios\UsuarioService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * /api/usuarios (RF07, Tabla 6), solo para ADMINISTRADOR (el middleware `rol:ADMINISTRADOR` va en las rutas).
 * Solo valida la forma de la petición y delega en UsuarioService; el usuario de la ruta se busca antes de validar
 * el cuerpo, así que un id que no existe es 404 aunque el cuerpo también sea inválido.
 */
class UsuarioController extends Controller
{
    private const POR_PAGINA_PREDETERMINADO = 20;

    /** Tope de `pagina`: con `por_pagina` ≤ 100 el desplazamiento de la consulta nunca desborda un entero. */
    private const PAGINA_MAXIMA = 2147483647;

    /** `id_bodega` es un `unsignedInteger` en la base. */
    private const ID_BODEGA_MAXIMO = 4294967295;

    private const MENSAJES = [
        'activo.in' => 'El filtro activo debe ser true, false, 1 o 0.',
    ];

    public function __construct(private readonly UsuarioService $usuarios) {}

    /** GET /api/usuarios?id_rol&activo&pagina&por_pagina. Nunca incluye contraseñas (UsuarioResource). */
    public function index(Request $request): JsonResponse
    {
        // Los filtros vienen en la cadena de consulta, siempre como texto: `integer` normal, y `activo` acepta las
        // cuatro formas habituales (la regla `boolean` de Laravel rechaza "true" y "false" en texto).
        $filtros = $request->validate([
            'id_rol' => ['nullable', 'integer'],
            'activo' => ['nullable', 'in:true,false,1,0'],
            'pagina' => ['nullable', 'integer', 'min:1', 'max:'.self::PAGINA_MAXIMA],
            'por_pagina' => ['nullable', 'integer', 'min:1', 'max:100'],
        ], self::MENSAJES);

        $pagina = $this->usuarios->listar(
            idRol: isset($filtros['id_rol']) ? (int) $filtros['id_rol'] : null,
            activo: isset($filtros['activo']) ? filter_var($filtros['activo'], FILTER_VALIDATE_BOOLEAN) : null,
            pagina: (int) ($filtros['pagina'] ?? 1),
            porPagina: (int) ($filtros['por_pagina'] ?? self::POR_PAGINA_PREDETERMINADO),
        );

        return response()->json(Paginated::from($pagina, fn (Usuario $usuario) => (new UsuarioResource($usuario))->resolve()));
    }

    /** POST /api/usuarios → 201. El usuario nuevo debe cambiar la contraseña temporal en su primer inicio de sesión. */
    public function store(Request $request): JsonResponse
    {
        $datos = $request->validate([
            ...$this->reglasDelUsuario(),
            // `bail`: un solo mensaje (la política, o que no es texto, no ambos).
            'contrasena_temporal' => ['bail', 'required', 'string', new ContrasenaValida],
        ]);

        return (new UsuarioResource($this->usuarios->crear($datos)))->response()->setStatusCode(201);
    }

    /** GET /api/usuarios/{id}. */
    public function show(string $id): UsuarioResource
    {
        return new UsuarioResource($this->usuarios->obtener($id));
    }

    /** PUT /api/usuarios/{id}: reemplaza nombre, correo, rol y bodega. */
    public function update(Request $request, string $id): UsuarioResource
    {
        $usuario = $this->usuarios->obtener($id);
        $datos = $request->validate($this->reglasDelUsuario());

        return new UsuarioResource($this->usuarios->actualizar($usuario, $datos, $this->usuarioActual($request)));
    }

    /** POST /api/usuarios/{id}/inactivar → 200 con el usuario; ya no puede iniciar sesión. */
    public function inactivar(Request $request, string $id): UsuarioResource
    {
        $usuario = $this->usuarios->obtener($id);

        return new UsuarioResource($this->usuarios->inactivar($usuario, $this->usuarioActual($request)));
    }

    /** POST /api/usuarios/{id}/activar → 200 con el usuario. */
    public function activar(string $id): UsuarioResource
    {
        return new UsuarioResource($this->usuarios->activar($this->usuarios->obtener($id)));
    }

    /** POST /api/usuarios/{id}/restablecer-contrasena → 204: deja la temporal y el cambio de contraseña pendiente. */
    public function restablecerContrasena(Request $request, string $id): Response
    {
        $usuario = $this->usuarios->obtener($id);
        $datos = $request->validate([
            'contrasena_temporal' => ['bail', 'required', 'string', new ContrasenaValida],
        ]);

        $this->usuarios->restablecerContrasena($usuario, $datos['contrasena_temporal']);

        return response()->noContent();
    }

    /**
     * Forma del cuerpo de POST y PUT. `id_rol` e `id_bodega` son números JSON (`integer:strict`: la regla normal
     * aceptaría `true` como 1). Que el rol exista (404) y que el operador lleve bodega (422) lo decide el servicio.
     *
     * @return array<string, list<string>>
     */
    private function reglasDelUsuario(): array
    {
        return [
            'nombre' => ['required', 'string', 'max:100'],
            'correo' => ['required', 'string', 'email', 'max:255'],
            'id_rol' => ['required', 'integer:strict'],
            'id_bodega' => ['nullable', 'integer:strict', 'min:1', 'max:'.self::ID_BODEGA_MAXIMO],
        ];
    }
}
