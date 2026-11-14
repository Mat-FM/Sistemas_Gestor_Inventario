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
        // Entidad Categoria del modelo entidad-relación de la Entrega 2 (Figura 3).
        Schema::create('categorias', function (Blueprint $table) {
            $table->id('id_categoria');
            $table->string('nombre', 100);
            $table->string('descripcion')->nullable();
            // Relación «contiene» de la categoría consigo misma (RF02): una categoría principal no tiene padre.
            // No se puede borrar una categoría que tenga subcategorías.
            $table->foreignId('id_categoria_padre')->nullable()
                ->constrained('categorias', 'id_categoria')->restrictOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('categorias');
    }
};
