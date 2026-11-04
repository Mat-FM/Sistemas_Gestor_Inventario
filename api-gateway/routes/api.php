<?php

use App\Http\Controllers\AuthController;
use Illuminate\Support\Facades\Route;

// Rutas públicas del Gateway (prefijo /api): /api/auth, /api/usuarios, /api/roles
// y el comodín de reenvío a los microservicios. Las dos últimas se agregan en las tareas siguientes.

// Público: no lleva `jwt`. Límite de 10 intentos por minuto por IP (RNF19), exitosos o no.
Route::post('auth/login', [AuthController::class, 'login'])->middleware('throttle:login');

// Todo lo autenticado cuelga de este grupo; las rutas de /api/usuarios, /api/roles y el comodín de reenvío se
// agregan aquí dentro, sin repetir middleware. El orden importa:
//   jwt                 deja el usuario en la petición; sin token válido es 401 y no gasta el contador de nadie.
//                       (Laravel reordena según su lista de prioridad: AuthenticateJwt implementa el marcador
//                       AuthenticatesRequests para quedar siempre antes de throttle; RateLimitTest lo comprueba.)
//   throttle:api        100 por minuto por usuario (RNF19); cuenta también lo que rechaza `cambio.contrasena`.
//   cambio.contrasena   con el cambio pendiente solo pasan PUT contrasena y POST logout (EnforcePasswordChange).
Route::middleware(['jwt', 'throttle:api', 'cambio.contrasena'])->group(function (): void {
    Route::prefix('auth')->group(function (): void {
        Route::post('logout', [AuthController::class, 'logout']);
        Route::get('me', [AuthController::class, 'me']);
        Route::put('contrasena', [AuthController::class, 'cambiarContrasena']);
    });
});
