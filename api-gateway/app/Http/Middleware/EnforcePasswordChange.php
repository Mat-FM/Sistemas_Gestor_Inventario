<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Con el cambio de contraseña pendiente (`debe_cambiar_contrasena`, p. ej. el administrador sembrado o una
 * contraseña restablecida) solo se puede cambiar la contraseña o cerrar la sesión; todo lo demás es 403
 * CAMBIO_CONTRASENA_REQUERIDO, también para los administradores.
 *
 * Va después de `jwt`. Si no hay usuario autenticado en la petición (cadena mal armada) responde 401 en vez de
 * dejar pasar.
 */
class EnforcePasswordChange
{
    /**
     * Método y ruta, tal como los ve el enrutador. La comparación es exacta: ni subrutas, ni otras mayúsculas,
     * ni barras de más al inicio.
     *
     * @var list<array{string, string}>
     */
    private const PERMITIDAS = [
        ['PUT', '/api/auth/contrasena'],
        ['POST', '/api/auth/logout'],
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $usuario = $request->attributes->get('usuario');

        if (! $usuario instanceof Usuario) {
            throw ApiException::noAutenticado();
        }

        if ($usuario->debe_cambiar_contrasena && ! $this->esPermitida($request)) {
            throw new ApiException(403, 'CAMBIO_CONTRASENA_REQUERIDO', 'Debe cambiar su contraseña antes de continuar.');
        }

        return $next($request);
    }

    private function esPermitida(Request $request): bool
    {
        // Mismo recorte que hace el enrutador (UriValidator): solo se quitan las barras finales. `path()` también
        // quita las iniciales, y `//api/auth/contrasena` no coincide con la ruta real aunque `path()` lo iguale.
        $ruta = rtrim($request->getPathInfo(), '/');

        foreach (self::PERMITIDAS as [$metodo, $permitida]) {
            if ($request->method() === $metodo && $ruta === $permitida) {
                return true;
            }
        }

        return false;
    }
}
