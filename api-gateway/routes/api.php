<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\ProxyController;
use App\Http\Controllers\RolController;
use App\Http\Controllers\UsuarioController;
use Illuminate\Support\Facades\Route;

// Rutas públicas del Gateway (prefijo /api): /api/auth, /api/usuarios, /api/roles
// y el comodín de reenvío a los microservicios (que se agrega en una tarea posterior).

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

    // Usuarios y roles (RF07, Tabla 6): solo ADMINISTRADOR (403 SIN_PERMISO a los demás). Las ocho rutas de la tabla
    // y ninguna más: sin apiResource, porque agregaría PATCH y DELETE (los usuarios no se borran, se inactivan). El
    // `{id}` se valida en UsuarioService::obtener y no con `where`, para que 401 y 403 le ganen al 404 de un id malo.
    Route::middleware('rol:ADMINISTRADOR')->group(function (): void {
        Route::prefix('usuarios')->group(function (): void {
            Route::get('/', [UsuarioController::class, 'index']);
            Route::post('/', [UsuarioController::class, 'store']);
            Route::get('{id}', [UsuarioController::class, 'show']);
            Route::put('{id}', [UsuarioController::class, 'update']);
            Route::post('{id}/inactivar', [UsuarioController::class, 'inactivar']);
            Route::post('{id}/activar', [UsuarioController::class, 'activar']);
            Route::post('{id}/restablecer-contrasena', [UsuarioController::class, 'restablecerContrasena']);
        });

        Route::get('roles', [RolController::class, 'index']);
    });

    // Reenvío a los microservicios (Tabla 4). Por estar dentro del grupo, una ruta desconocida sin token es 401
    // antes que 404 (no revela qué rutas existen). ProxyController decide con el mapa de rutas (404 si no está
    // publicada, 403 si el rol no puede). `fallback()` hace que el enrutador lo pruebe siempre después de todas
    // las demás rutas, también de las que se registren más tarde, así que las rutas propias siempre ganan. Como
    // acepta todos los métodos, un método no listado en /api es 401 sin token y 404 con token, nunca 405.
    Route::any('{path}', ProxyController::class)->where('path', '.*')->fallback();
});
