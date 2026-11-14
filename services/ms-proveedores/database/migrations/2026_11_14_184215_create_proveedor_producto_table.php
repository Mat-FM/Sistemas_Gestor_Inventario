<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        // Entidad ProveedorProducto del modelo entidad-relación de la Entrega 2 (Figura 4).
        Schema::create('proveedor_producto', function (Blueprint $table) {
            $table->id('id_proveedor_producto');
            // Relación «suministra»: es interna al servicio, por eso sí lleva clave foránea.
            $table->foreignId('id_proveedor')->constrained('proveedores', 'id_proveedor')->restrictOnDelete();
            // Dato de ms-catalogo: solo se guarda el identificador, sin clave foránea (RNF02).
            $table->unsignedBigInteger('id_producto')->index();
            $table->timestamp('fecha_asociacion')->useCurrent();

            // Un producto no se puede asociar dos veces al mismo proveedor (409 del contrato).
            $table->unique(['id_proveedor', 'id_producto']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('proveedor_producto');
    }
};
