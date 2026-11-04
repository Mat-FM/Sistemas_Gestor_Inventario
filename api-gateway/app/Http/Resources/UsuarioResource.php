<?php

namespace App\Http\Resources;

use App\Models\Usuario;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Arr;

/**
 * Representación pública de un usuario (Tabla 6). Nunca incluye la contraseña ni su hash.
 *
 * Sin el envoltorio `data` de Laravel: el contrato entrega el objeto tal cual (los listados usan `datos`/`meta`,
 * ver Paginated). `rol` es el nombre del rol; si la relación no viene cargada se lee al vuelo, así que quien
 * serialice varios usuarios debe cargarla con `with('rol')` para no hacer una consulta por usuario.
 *
 * @mixin Usuario
 */
class UsuarioResource extends JsonResource
{
    public static $wrap = null;

    /** Subconjunto que devuelve el inicio de sesión (`usuario` en POST /api/auth/login). */
    public const CAMPOS_DE_SESION = ['id_usuario', 'nombre', 'rol', 'id_bodega', 'debe_cambiar_contrasena'];

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        return [
            'id_usuario' => $this->id_usuario,
            'nombre' => $this->nombre,
            'correo' => $this->correo,
            'id_rol' => $this->id_rol,
            'rol' => $this->rol->nombre,
            'id_bodega' => $this->id_bodega,
            'activo' => $this->activo,
            'debe_cambiar_contrasena' => $this->debe_cambiar_contrasena,
            'fecha_creacion' => $this->fecha_creacion?->toIso8601ZuluString(),
        ];
    }

    /**
     * Solo los campos de CAMPOS_DE_SESION, sacados de la misma definición para que ambas formas no se desvíen.
     *
     * @return array<string, mixed>
     */
    public static function deSesion(Usuario $usuario): array
    {
        return Arr::only((new self($usuario))->resolve(), self::CAMPOS_DE_SESION);
    }
}
