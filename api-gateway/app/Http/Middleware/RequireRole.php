<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use App\Support\Roles;
use Closure;
use Illuminate\Http\Request;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\Response;

/**
 * Se usa como `rol:ADMINISTRADOR,CONTADOR`: deja pasar solo a los usuarios con alguno de esos roles y responde
 * 403 SIN_PERMISO a los demás. El rol sale del usuario recién leído de la base por `jwt`, no del token.
 *
 * Va después de `jwt`; sin usuario autenticado responde 401 en vez de dejar pasar. Un nombre de rol que no
 * existe (p. ej. un error tipográfico en la definición de una ruta) lanza una excepción en vez de denegar en
 * silencio a un rol que sí debería entrar.
 */
class RequireRole
{
    public function handle(Request $request, Closure $next, string ...$roles): Response
    {
        $this->comprobarRoles($roles);

        $usuario = $request->attributes->get('usuario');

        if (! $usuario instanceof Usuario) {
            throw ApiException::noAutenticado();
        }

        if (! $usuario->tieneRol(...$roles)) {
            throw ApiException::sinPermiso();
        }

        return $next($request);
    }

    /**
     * @param  list<string>  $roles
     */
    private function comprobarRoles(array $roles): void
    {
        if ($roles === []) {
            throw new InvalidArgumentException('La ruta debe indicar al menos un rol (rol:ADMINISTRADOR,...).');
        }

        foreach ($roles as $rol) {
            if (! in_array($rol, Roles::TODOS, true)) {
                throw new InvalidArgumentException("El rol «{$rol}» no existe; los válidos son ".implode(', ', Roles::TODOS).'.');
            }
        }
    }
}
