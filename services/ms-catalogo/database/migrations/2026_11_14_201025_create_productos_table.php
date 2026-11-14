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
        // Entidad Producto del modelo entidad-relación de la Entrega 2 (Figura 3).
        Schema::create('productos', function (Blueprint $table) {
            $table->id('id_producto');
            $table->string('codigo', 30)->unique();
            $table->string('nombre', 150);
            $table->string('descripcion', 500)->nullable();
            // Relación «clasifica»: cada producto tiene una sola categoría (participación total).
            // No se puede borrar una categoría que tenga productos.
            $table->foreignId('id_categoria')->constrained('categorias', 'id_categoria')->restrictOnDelete();
            $table->string('unidad_medida', 20);
            // Pesos colombianos; se usa en la valorización del inventario (RF11).
            $table->decimal('precio', 12, 2);
            // El producto no se borra: se da de baja (RF01).
            $table->enum('estado', ['ACTIVO', 'INACTIVO'])->default('ACTIVO');
            $table->timestamp('fecha_creacion')->nullable();
            $table->timestamp('fecha_actualizacion')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('productos');
    }
};
