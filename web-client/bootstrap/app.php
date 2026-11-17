<?php

use App\Gateway\GatewayException;
use App\Http\Middleware\ConfiarEnProxies;
use App\Http\Middleware\ExigeRol;
use App\Http\Middleware\ExigeSesion;
use App\Http\Middleware\RegistrarPeticion;
use App\Support\Sesion;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Proxies de confianza por entorno (TRUSTED_PROXIES), leídos en cada petición: ver ConfiarEnProxies.
        $middleware->replace(TrustProxies::class, ConfiarEnProxies::class);
        // El registro de cada petición (RNF10) y su identificador.
        $middleware->web(prepend: [RegistrarPeticion::class]);
        $middleware->alias([
            'sesion' => ExigeSesion::class,
            'rol' => ExigeRol::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Si una validación falla, Laravel devuelve lo escrito al formulario: las contraseñas no deben guardarse en la sesión.
        $exceptions->dontFlash(['contrasena', 'contrasena_actual', 'contrasena_nueva', 'contrasena_nueva_confirmation', 'contrasena_temporal']);

        // Los errores del Gateway se atienden en un solo lugar: la sesión vencida vuelve al inicio de sesión, el cambio de
        // contraseña pendiente va a su pantalla y lo demás se explica en lenguaje cotidiano.
        $exceptions->render(function (GatewayException $e, Request $request) {
            if ($e->sesionVencida()) {
                app(Sesion::class)->cerrar();

                return redirect()->route('login')->with('aviso', 'Tu sesión venció. Entra de nuevo.');
            }

            if ($e->exigeCambioDeContrasena()) {
                app(Sesion::class)->marcarCambioPendiente(true);

                return redirect()->route('contrasena.editar');
            }

            if ($e->estado >= 500) {
                // El Gateway o un servicio detrás de él falló: se anota con el identificador que él devolvió, para seguir la petición.
                Log::error('gateway_error', ['estado' => $e->estado, 'codigo' => $e->codigo, 'gateway_request_id' => $e->idPeticionGateway]);
            }

            [$titulo, $texto] = match (true) {
                $e->estado === 403 => ['No tienes permiso', 'Tu rol no puede hacer esto. Si crees que es un error, habla con el administrador.'],
                $e->estado === 404 => ['No lo encontramos', 'Lo que buscas ya no existe o fue dado de baja.'],
                $e->estado === 429 => ['Vas muy rápido', 'Hiciste muchas peticiones seguidas.'.($e->reintentarEn > 0 ? " Espera {$e->reintentarEn} segundos e intenta de nuevo." : ' Espera un momento e intenta de nuevo.')],
                $e->estado >= 500 => ['Servicio no disponible', 'Una parte del sistema no responde por ahora. Intenta de nuevo en unos minutos.'],
                default => ['No se pudo completar', $e->getMessage() ?: 'Revisa los datos e intenta de nuevo.'],
            };

            return response()->view('errores.pagina', ['titulo' => $titulo, 'texto' => $texto], $e->estado >= 400 ? $e->estado : 500);
        });
    })->create();
