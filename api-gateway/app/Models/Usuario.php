<?php

namespace App\Models;

use App\Support\Roles;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Sin $fillable a propósito: el rol, la contraseña, el estado y la bodega nunca se asignan en masa desde una
 * petición; quien crea o edita un usuario los asigna uno por uno (o con forceFill/forceCreate, o dentro de
 * Usuario::unguarded()) a partir de datos ya validados.
 */
class Usuario extends Model
{
    protected $table = 'usuarios';

    protected $primaryKey = 'id_usuario';

    public $timestamps = false;

    /** Datos internos que nunca salen en una serialización: `sesiones_desde` es la marca de revocación de sesiones. */
    protected $hidden = ['contrasena_cifrada', 'sesiones_desde'];

    /**
     * Los mismos valores por defecto de la tabla, para que un usuario recién creado los tenga también en memoria.
     *
     * @var array<string, mixed>
     */
    protected $attributes = [
        'activo' => true,
        'debe_cambiar_contrasena' => false,
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'id_bodega' => 'integer',
            'activo' => 'boolean',
            'debe_cambiar_contrasena' => 'boolean',
            'fecha_creacion' => 'datetime',
            'sesiones_desde' => 'datetime',
        ];
    }

    /**
     * Forma única en que se guarda y se busca el correo: sin espacios en los extremos y en minúsculas. Así
     * `Ana@X.com` y `ana@x.com` son el mismo usuario sin depender de la intercalación del motor (MySQL no
     * distingue mayúsculas, SQLite sí). Todo lo que escriba o consulte `correo` debe pasar por aquí.
     */
    public static function normalizarCorreo(string $correo): string
    {
        return mb_strtolower(trim($correo));
    }

    /** @return BelongsTo<Rol, $this> */
    public function rol(): BelongsTo
    {
        return $this->belongsTo(Rol::class, 'id_rol', 'id_rol');
    }

    public function esOperador(): bool
    {
        return $this->tieneRol(Roles::OPE);
    }

    public function tieneRol(string ...$roles): bool
    {
        return in_array($this->rol?->nombre, $roles, true);
    }
}
