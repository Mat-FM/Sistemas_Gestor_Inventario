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
        Schema::create('roles', function (Blueprint $table) {
            $table->id('id_rol');
            $table->string('nombre', 50)->unique();
            $table->string('descripcion')->nullable();
        });

        Schema::create('usuarios', function (Blueprint $table) {
            $table->id('id_usuario');
            $table->string('nombre', 100);
            $table->string('correo')->unique();
            $table->string('contrasena_cifrada');
            $table->foreignId('id_rol')->constrained('roles', 'id_rol')->restrictOnDelete();
            // Dato de ms-inventario: solo se guarda para el operador de bodega, sin clave foránea.
            $table->unsignedInteger('id_bodega')->nullable();
            $table->boolean('activo')->default(true);
            $table->boolean('debe_cambiar_contrasena')->default(false);
            $table->timestamp('fecha_creacion')->useCurrent();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('usuarios');
        Schema::dropIfExists('roles');
    }
};
