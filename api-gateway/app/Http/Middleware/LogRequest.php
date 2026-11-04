<?php

namespace App\Http\Middleware;

use App\Models\Usuario;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * Un registro por petición (RNF10), emitido con la respuesta ya enviada. El canal por defecto
 * (`json_stderr`) lo escribe como una línea JSON.
 *
 * Solo lleva las claves del contrato: nunca la cadena de consulta, las cabeceras ni el token.
 */
class LogRequest
{
    private const ATRIBUTO_INICIO = 'peticion_inicio_ns';

    public function handle(Request $request, Closure $next): Response
    {
        $request->attributes->set(self::ATRIBUTO_INICIO, hrtime(true));

        return $next($request);
    }

    /**
     * Laravel resuelve una instancia nueva de un middleware terminable, así que el inicio viaja en la petición
     * y no en una propiedad.
     */
    public function terminate(Request $request, Response $respuesta): void
    {
        $inicio = $request->attributes->get(self::ATRIBUTO_INICIO);
        $usuario = $request->attributes->get('usuario');

        Log::info('peticion', [
            'servicio' => 'api-gateway',
            'request_id' => $request->attributes->get('request_id'),
            'metodo' => $request->method(),
            'ruta' => $request->getPathInfo(),
            'estado' => $respuesta->getStatusCode(),
            'id_usuario' => $usuario instanceof Usuario ? $usuario->getKey() : null,
            'duracion_ms' => is_int($inicio) ? round((hrtime(true) - $inicio) / 1_000_000, 2) : 0.0,
        ]);
    }
}
