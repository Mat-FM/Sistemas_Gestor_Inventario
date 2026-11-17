<?php

namespace App\Http\Middleware;

use App\Support\Sesion;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Un registro por petición (RNF10): servicio, nivel, identificador de petición, método, ruta SIN la cadena de consulta,
 * estado, usuario y duración. El identificador lo genera siempre este servicio (un UUID por petición, el que mande el
 * cliente se descarta) y también viaja en la respuesta y en todo registro de la petición, como el del Gateway. Nunca se
 * escriben cabeceras, cuerpos ni el token.
 */
class RegistrarPeticion
{
    public const CABECERA = 'X-Request-Id';

    private const INICIO = 'peticion_inicio_ns';

    public function handle(Request $request, Closure $next): Response
    {
        $id = (string) Str::uuid();
        $request->attributes->set('request_id', $id);
        $request->attributes->set(self::INICIO, hrtime(true));
        Log::shareContext(['servicio' => 'web-client', 'request_id' => $id]);

        $respuesta = $next($request);
        $respuesta->headers->set(self::CABECERA, $id);

        return $respuesta;
    }

    /** Con la respuesta ya enviada; después se retira el contexto compartido para que no pase a la petición siguiente. */
    public function terminate(Request $request, Response $respuesta): void
    {
        $inicio = $request->attributes->get(self::INICIO);

        Log::info('peticion', [
            'metodo' => $request->method(),
            'ruta' => $request->getPathInfo(),
            'estado' => $respuesta->getStatusCode(),
            'id_usuario' => app(Sesion::class)->usuario()['id_usuario'] ?? null,
            'duracion_ms' => is_int($inicio) ? round((hrtime(true) - $inicio) / 1_000_000, 2) : 0.0,
        ]);

        Log::withoutContext(['servicio', 'request_id']);
        Log::flushSharedContext();
    }
}
