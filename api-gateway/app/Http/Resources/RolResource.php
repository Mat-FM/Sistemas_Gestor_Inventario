<?php

namespace App\Http\Resources;

use App\Models\Rol;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Representación pública de un rol (GET /api/roles). Sin el envoltorio `data` de Laravel, igual que UsuarioResource.
 *
 * @mixin Rol
 */
class RolResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        return [
            'id_rol' => $this->id_rol,
            'nombre' => $this->nombre,
            'descripcion' => $this->descripcion,
        ];
    }
}
