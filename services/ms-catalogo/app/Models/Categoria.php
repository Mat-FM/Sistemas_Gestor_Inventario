<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Categoria extends Model
{
    // Los nombres siguen el modelo de la Entrega 2, igual que en los demás servicios.
    protected $table = 'categorias';

    protected $primaryKey = 'id_categoria';

    // El modelo de datos no tiene fechas para la categoría.
    public $timestamps = false;

    protected $fillable = [
        'nombre',
        'descripcion',
        'id_categoria_padre',
    ];

    // Relación «contiene»: la categoría padre de una subcategoría.
    public function padre(): BelongsTo
    {
        return $this->belongsTo(Categoria::class, 'id_categoria_padre', 'id_categoria');
    }

    // Relación «contiene»: las subcategorías de esta categoría.
    public function subcategorias(): HasMany
    {
        return $this->hasMany(Categoria::class, 'id_categoria_padre', 'id_categoria');
    }

    // Relación «clasifica»: los productos de esta categoría.
    public function productos(): HasMany
    {
        return $this->hasMany(Producto::class, 'id_categoria', 'id_categoria');
    }
}
