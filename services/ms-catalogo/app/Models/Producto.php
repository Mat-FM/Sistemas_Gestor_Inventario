<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Producto extends Model
{
    protected $table = 'productos';

    protected $primaryKey = 'id_producto';

    // Laravel llena solas estas dos fechas, con los nombres del modelo de datos.
    const CREATED_AT = 'fecha_creacion';

    const UPDATED_AT = 'fecha_actualizacion';

    protected $fillable = [
        'codigo',
        'nombre',
        'descripcion',
        'id_categoria',
        'unidad_medida',
        'precio',
        'estado',
    ];

    protected function casts(): array
    {
        return [
            'precio' => 'decimal:2',
        ];
    }

    // Relación «clasifica»: cada producto pertenece a una sola categoría.
    public function categoria(): BelongsTo
    {
        return $this->belongsTo(Categoria::class, 'id_categoria', 'id_categoria');
    }
}
