<?php

use App\Http\Controllers\AuthController;
use Illuminate\Support\Facades\Route;

// Rutas públicas del Gateway (prefijo /api): /api/auth, /api/usuarios, /api/roles
// y el comodín de reenvío a los microservicios. Las dos últimas se agregan en las tareas siguientes.

Route::prefix('auth')->group(function (): void {
    // Público: no lleva `jwt`. El límite de intentos por IP lo añade la Tarea 6.
    Route::post('login', [AuthController::class, 'login']);

    // Con el cambio de contraseña pendiente solo pasan PUT contrasena y POST logout (EnforcePasswordChange).
    Route::middleware(['jwt', 'cambio.contrasena'])->group(function (): void {
        Route::post('logout', [AuthController::class, 'logout']);
        Route::get('me', [AuthController::class, 'me']);
        Route::put('contrasena', [AuthController::class, 'cambiarContrasena']);
    });
});
