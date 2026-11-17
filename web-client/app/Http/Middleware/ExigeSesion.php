<?php

namespace App\Http\Middleware;

use App\Support\Sesion;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Solo pasa quien tiene el token del Gateway vigente; y mientras tenga el cambio de contraseña pendiente, solo a esa pantalla. */
class ExigeSesion
{
    public function __construct(private readonly Sesion $sesion) {}

    public function handle(Request $request, Closure $next): Response
    {
        if (! $this->sesion->activa()) {
            $this->sesion->cerrar();

            return redirect()->route('login')->with('aviso', 'Tu sesión venció. Entra de nuevo.');
        }

        if ($this->sesion->debeCambiarContrasena() && ! $request->routeIs('contrasena.*', 'salir')) {
            return redirect()->route('contrasena.editar');
        }

        return $next($request);
    }
}
