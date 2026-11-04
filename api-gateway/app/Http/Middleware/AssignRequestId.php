<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * El identificador de petición lo genera siempre el Gateway (D12): un UUID v4 nuevo por petición. El valor que
 * mande el cliente en `X-Request-Id` se descarta, no se valida ni se reaprovecha, para que nadie pueda
 * falsificar ni contaminar la trazabilidad de los registros.
 *
 * El identificador queda en el atributo `request_id`, en la cabecera `X-Request-Id` de la petición (para que
 * quien lea la cabecera vea el valor del Gateway y no el del cliente) y en la respuesta, también cuando es un
 * error: la tubería de rutas convierte las excepciones en respuesta antes de volver a este middleware.
 *
 * También se comparte con el registro durante toda la petición (`Log::shareContext`): cualquier línea, incluidos
 * los errores 5xx que registra el manejador de excepciones, lleva el `request_id` que recibió el cliente. Al
 * terminar la petición se retira del contexto compartido y de los canales ya creados, para que no pase a la
 * siguiente en un proceso que atiende varias (RNF05).
 */
class AssignRequestId
{
    public const CABECERA = 'X-Request-Id';

    public function handle(Request $request, Closure $next): Response
    {
        $id = (string) Str::uuid();

        $request->attributes->set('request_id', $id);
        $request->headers->set(self::CABECERA, $id);
        Log::shareContext(['request_id' => $id]);

        $respuesta = $next($request);
        $respuesta->headers->set(self::CABECERA, $id);

        return $respuesta;
    }

    /**
     * Laravel lo llama con la respuesta ya enviada. Corre antes que el `terminate` de `LogRequest`, que no depende
     * del contexto compartido: pone el `request_id` en su línea de forma explícita.
     */
    public function terminate(Request $request, Response $respuesta): void
    {
        Log::withoutContext(['request_id']);
        Log::flushSharedContext();
    }
}
