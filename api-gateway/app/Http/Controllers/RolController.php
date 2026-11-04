<?php

namespace App\Http\Controllers;

use App\Http\Resources\RolResource;
use App\Http\Support\Paginated;
use App\Models\Rol;
use App\Services\Usuarios\UsuarioService;
use Illuminate\Http\JsonResponse;

/** GET /api/roles (RF07, Tabla 6), solo para ADMINISTRADOR (el middleware va en la ruta). */
class RolController extends Controller
{
    public function __construct(private readonly UsuarioService $usuarios) {}

    /** Los cuatro roles, con la forma común de los listados `{datos, meta}`. */
    public function index(): JsonResponse
    {
        return response()->json(Paginated::from($this->usuarios->listarRoles(), fn (Rol $rol) => (new RolResource($rol))->resolve()));
    }
}
