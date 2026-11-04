<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\Response;

/**
 * Proxies de confianza por entorno (`TRUSTED_PROXIES`, leída en `config('gateway.trusted_proxies')`): una lista
 * de IP o CIDR separados por comas. Solo de esas direcciones se aceptan `X-Forwarded-For`, `-Host`, `-Port` y
 * `-Proto`; así, detrás de un Service o un Ingress de Kubernetes, `$request->ip()` es la del cliente real y el
 * límite de inicio de sesión por IP cuenta por cliente y no se vuelve global.
 *
 * Sustituye al TrustProxies de Laravel en la pila global (bootstrap/app.php) por dos motivos:
 * - la lista se lee en cada petición, con la configuración ya cargada; `trustProxies(at:)` en `withMiddleware`
 *   se evalúa al resolver el kernel HTTP, antes de cargar `.env` y la configuración;
 * - con la lista vacía no se confía en nadie: el de Laravel confía en todos si el Host (que pone el cliente)
 *   termina en `.on-forge.com` o `.on-vapor.com`, y un cliente podría falsificar su IP.
 *
 * Confiar en todos (`*`, `REMOTE_ADDR` o un rango `/0`) se rechaza: permitiría falsificar `X-Forwarded-For` y
 * esquivar el límite por IP. No guarda estado entre peticiones: la lista de Symfony se reescribe en cada una.
 */
class ConfiarEnProxies extends TrustProxies
{
    /** @var int */
    protected $headers = Request::HEADER_X_FORWARDED_FOR
        | Request::HEADER_X_FORWARDED_HOST
        | Request::HEADER_X_FORWARDED_PORT
        | Request::HEADER_X_FORWARDED_PROTO;

    public function handle(Request $request, Closure $next): Response
    {
        $request::setTrustedProxies(self::analizar(config('gateway.trusted_proxies')), $this->headers);

        return $next($request);
    }

    /**
     * Separa la lista por comas e ignora las entradas vacías y los espacios.
     *
     * @return list<string>
     *
     * @throws InvalidArgumentException si alguna entrada confía en todos los proxies
     */
    public static function analizar(mixed $valor): array
    {
        $proxies = array_values(array_filter(
            array_map(trim(...), explode(',', is_string($valor) ? $valor : '')),
            fn (string $entrada): bool => $entrada !== '',
        ));

        foreach ($proxies as $entrada) {
            if (str_contains($entrada, '*') || strcasecmp($entrada, 'REMOTE_ADDR') === 0 || preg_match('#/0+$#', $entrada) === 1) {
                throw new InvalidArgumentException(
                    'TRUSTED_PROXIES no admite «*» ni otra forma de confiar en todos los proxies (REMOTE_ADDR o un rango /0): '
                    .'permitiría falsificar X-Forwarded-For y esquivar el límite de peticiones por IP. '
                    .'Indique las IP o los CIDR concretos de los proxies, separados por comas.'
                );
            }
        }

        return $proxies;
    }
}
