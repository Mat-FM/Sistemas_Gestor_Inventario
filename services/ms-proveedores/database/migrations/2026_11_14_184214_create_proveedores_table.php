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
        // Entidad Proveedor del modelo entidad-relación de la Entrega 2 (Figura 4).
        Schema::create('proveedores', function (Blueprint $table) {
            $table->id('id_proveedor');
            $table->string('nit', 20)->unique();
            $table->string('razon_social', 150);
            $table->string('nombre_contacto', 100);
            $table->string('telefono', 20);
            $table->string('correo');
            $table->string('direccion');
            // El proveedor no se borra: se inactiva y se vuelve a activar (RF03).
            $table->enum('estado', ['ACTIVO', 'INACTIVO'])->default('ACTIVO');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('proveedores');
    }
};
