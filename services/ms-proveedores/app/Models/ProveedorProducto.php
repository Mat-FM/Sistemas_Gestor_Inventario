<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ProveedorProducto extends Model
{
    protected $table = 'proveedor_producto';

    protected $primaryKey = 'id_proveedor_producto';

    // Solo se guarda fecha_asociacion, que la base de datos llena con la fecha actual.
    public $timestamps = false;

    protected $fillable = [
        'id_proveedor',
        'id_producto',
    ];

    protected function casts(): array
    {
        return [
            'fecha_asociacion' => 'datetime',
        ];
    }

    // Cada asociación pertenece a un solo proveedor.
    public function proveedor(): BelongsTo
    {
        return $this->belongsTo(Proveedor::class, 'id_proveedor', 'id_proveedor');
    }
}
