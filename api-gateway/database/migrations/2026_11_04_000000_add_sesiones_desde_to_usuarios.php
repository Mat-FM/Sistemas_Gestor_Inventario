<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * `sesiones_desde` marca «los tokens emitidos antes de este instante ya no valen» (revocación de sesiones). Nula
     * mientras nadie haya restablecido la contraseña del usuario ni lo haya inactivado: sin valor por defecto, así
     * los usuarios que ya existen conservan sus sesiones.
     */
    public function up(): void
    {
        Schema::table('usuarios', function (Blueprint $table) {
            $table->timestamp('sesiones_desde')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('usuarios', function (Blueprint $table) {
            $table->dropColumn('sesiones_desde');
        });
    }
};
