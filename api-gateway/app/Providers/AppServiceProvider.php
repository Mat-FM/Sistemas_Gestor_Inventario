<?php

namespace App\Providers;

use App\Exceptions\ApiException;
use App\Services\Jwt\JwtService;
use App\Services\Proxy\ProxyService;
use App\Services\Routing\RouteMap;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // El cast a string convierte un secreto ausente en una InvalidArgumentException clara
        // (JwtService lo rechaza) y no en un TypeError.
        $this->app->singleton(JwtService::class, fn () => new JwtService(
            (string) config('gateway.jwt.secret'),
            (int) config('gateway.jwt.ttl_minutes'),
        ));

        // El mapa de rutas se construye con la tabla de config/gateway_routes.php y se comparte: es de solo
        // lectura y no accede a la base de datos (RNF13). El closure lee la configuración al resolverlo, no al
        // registrar, así que una tabla mal escrita falla en la primera petición proxy, con un error claro.
        $this->app->singleton(RouteMap::class, fn () => new RouteMap(config('gateway_routes')));

        // El proxy recibe las URLs de los servicios y el tiempo máximo ya leídos de la configuración (RNF14).
        $this->app->singleton(ProxyService::class, fn () => new ProxyService(
            (array) config('gateway.services'),
            (int) config('gateway.timeout_seconds'),
        ));
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        $this->configurarLimitadores();
    }

    /**
     * Límite de peticiones (RNF19). Los dos limitadores cuentan en el almacén de caché por defecto, que en
     * producción es `database` y se comparte entre las copias del Gateway (RNF05, D13). Los topes se leen de
     * `config('gateway.rate_limit')` en cada petición, no al arrancar.
     */
    private function configurarLimitadores(): void
    {
        // `throttle:api`: 100 por minuto por usuario autenticado. Va después de `jwt` (AuthenticateJwt lo garantiza
        // con el marcador AuthenticatesRequests) para leer el usuario ya autenticado. Sin usuario (cadena mal
        // armada) responde 401, igual que EnforcePasswordChange, en vez de contar por IP en silencio.
        RateLimiter::for('api', function (Request $request): Limit {
            $usuario = $request->user() ?? throw ApiException::noAutenticado();

            return Limit::perMinute((int) config('gateway.rate_limit.por_usuario'))
                ->by('usuario:'.$usuario->getKey());
        });

        // `throttle:login`: 10 intentos por minuto por IP en POST /api/auth/login. Cuentan todos, también los
        // correctos, y la clave es solo la IP: cambiar de correo en cada intento no da un contador nuevo.
        RateLimiter::for('login', fn (Request $request): Limit => Limit::perMinute((int) config('gateway.rate_limit.login_por_ip'))
            ->by((string) $request->ip()));
    }
}
