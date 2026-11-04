<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
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
 */
class AssignRequestId
{
    public const CABECERA = 'X-Request-Id';

    public function handle(Request $request, Closure $next): Response
    {
        $id = (string) Str::uuid();

        $request->attributes->set('request_id', $id);
        $request->headers->set(self::CABECERA, $id);

        $respuesta = $next($request);
        $respuesta->headers->set(self::CABECERA, $id);

        return $respuesta;
    }
}
