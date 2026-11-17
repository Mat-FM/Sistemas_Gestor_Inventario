<?php

namespace App\Providers;

use App\Services\Notificaciones;
use App\Support\Sesion;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;
use Throwable;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Las direcciones de los recursos van en español: /productos/nuevo y /productos/{id}/editar.
        Route::resourceVerbs(['create' => 'nuevo', 'edit' => 'editar']);

        // La campana del menú: cuántas alertas sin leer tiene el rol. Se guarda 30 s por usuario para no gastar el límite
        // de peticiones del Gateway en cada pantalla, y si falla simplemente no se muestra el número.
        View::composer('layouts.app', function ($vista): void {
            $sesion = app(Sesion::class);
            $sinLeer = null;
            if ($sesion->activa() && ! $sesion->debeCambiarContrasena()) {
                try {
                    $sinLeer = Cache::remember('alertas.sin_leer.'.($sesion->usuario()['id_usuario'] ?? 0), 30, fn () => app(Notificaciones::class)->sinLeer());
                } catch (Throwable) {
                    $sinLeer = null;
                }
            }
            $vista->with('alertasSinLeer', $sinLeer);
        });
    }
}
