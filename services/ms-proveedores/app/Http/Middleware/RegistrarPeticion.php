<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Registro de cada petición (RNF10). Envuelve todas las rutas de la API:
 *
 * 1. Toma el X-Request-Id que envía el Gateway, o el servicio que hace una llamada interna, para seguir
 *    la misma operación en los registros de todos los componentes (Entrega 2, sección 2.2). Si no llega
 *    o no es válido, genera uno nuevo.
 * 2. Lo comparte con todos los registros de la petición (también los errores 500) y lo devuelve en la respuesta.
 * 3. Escribe una línea por petición. Nunca registra el cuerpo, la cadena de consulta ni las cabeceras.
 */
class RegistrarPeticion
{
    public const CABECERA = 'X-Request-Id';

    public function handle(Request $request, Closure $next): Response
    {
        $inicio = hrtime(true);

        // Solo letras, números y guiones (como un UUID), para que no se pueda ensuciar el registro.
        $id = (string) $request->headers->get(self::CABECERA);
        if (! preg_match('/^[A-Za-z0-9-]{1,64}$/', $id)) {
            $id = (string) Str::uuid();
        }

        // El nombre del servicio sale de APP_NAME (RNF14).
        Log::shareContext(['servicio' => config('app.name'), 'request_id' => $id]);

        // Aquí ya llega la respuesta final, también cuando hubo un error (404, 422, 500...).
        $respuesta = $next($request);
        $respuesta->headers->set(self::CABECERA, $id);

        Log::info('peticion', [
            'metodo' => $request->method(),
            'ruta' => $request->getPathInfo(),
            'estado' => $respuesta->getStatusCode(),
            // Usuario que envía el Gateway; nulo en las llamadas internas entre servicios.
            'id_usuario' => $request->headers->get('X-User-Id'),
            'duracion_ms' => round((hrtime(true) - $inicio) / 1_000_000, 2),
        ]);

        return $respuesta;
    }
}
