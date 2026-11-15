<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Proveedor extends Model
{
    // Laravel deduciría "proveedors"; los nombres siguen el modelo de la Entrega 2.
    protected $table = 'proveedores';

    protected $primaryKey = 'id_proveedor';

    // El modelo de datos no tiene created_at ni updated_at.
    public $timestamps = false;

    protected $fillable = [
        'nit',
        'razon_social',
        'nombre_contacto',
        'telefono',
        'correo',
        'direccion',
        'estado',
    ];

    // Relación «suministra»: un proveedor tiene muchas asociaciones con productos.
    public function productos(): HasMany
    {
        return $this->hasMany(ProveedorProducto::class, 'id_proveedor', 'id_proveedor');
    }
}
