<?php

namespace App\Http\Middleware;

use App\Support\Sesion;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Evita enlaces a pantallas que el rol no puede usar. No es la autoridad: el Gateway vuelve a comprobar el rol en cada
 * petición.
 */
class ExigeRol
{
    public function __construct(private readonly Sesion $sesion) {}

    public function handle(Request $request, Closure $next, string ...$roles): Response
    {
        abort_unless(in_array($this->sesion->rol(), $roles, true), 403, 'No tienes permiso para ver esta pantalla.');

        return $next($request);
    }
}
