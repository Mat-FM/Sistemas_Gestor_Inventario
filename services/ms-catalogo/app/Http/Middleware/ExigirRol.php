<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Defensa de roles (RNF07, RNF09): 403 SIN_PERMISO si el rol de X-User-Rol no figura en config/permisos.php para la ruta. Una petición
 * sin rol es una llamada interna entre servicios y pasa, igual que una ruta cuya regla es null.
 */
class ExigirRol
{
    public function handle(Request $request, Closure $next): Response
    {
        $rol = (string) $request->headers->get('X-User-Rol');
        $ruta = $request->route();

        if ($rol !== '' && $ruta !== null) {
            $roles = config('permisos.rutas')[$request->method().' '.$ruta->uri()] ?? null;

            if ($roles !== null && ! in_array($rol, $roles, true)) {
                throw ApiException::sinPermiso();
            }
        }

        return $next($request);
    }
}
