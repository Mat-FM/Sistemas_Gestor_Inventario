<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use App\Services\Jwt\JwtService;
use Closure;
use Illuminate\Contracts\Auth\Middleware\AuthenticatesRequests;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Autentica con `Authorization: Bearer <token>` y deja el usuario en el atributo `usuario` de la petición
 * (y como `$request->user()`).
 *
 * El token solo identifica al usuario (`sub`): en cada petición se vuelve a leer de la base, y el rol y la
 * bodega que usa el resto de la cadena salen de ese modelo recién leído, nunca de las claims del token (D3).
 * Por eso un usuario inactivado, borrado o con otro rol deja de servir, o cambia de efecto, en la petición
 * siguiente aunque su token no haya vencido.
 *
 * Además, si el usuario tiene `sesiones_desde` (la fijan restablecer su contraseña e inactivarlo), un token emitido
 * antes de esa marca tampoco sirve, aunque no haya vencido: así los tokens anteriores a un restablecimiento no
 * reviven cuando el usuario fija su contraseña ni cuando se le reactiva.
 *
 * Todo fallo es el mismo 401 NO_AUTENTICADO, sin indicar la causa.
 *
 * Implementa `AuthenticatesRequests`, un marcador sin métodos: Laravel ordena el middleware de cada ruta según
 * su lista de prioridad, y ese marcador es el que coloca la autenticación antes de `ThrottleRequests`. Sin él,
 * `throttle:api` se ejecutaría antes que `jwt` aunque la ruta los declare al revés, no vería al usuario y
 * contaría por IP en vez de por usuario.
 */
class AuthenticateJwt implements AuthenticatesRequests
{
    /** Cabeceras que solo el Gateway puede poner hacia los servicios (Tarea 9); las del cliente se descartan. */
    private const CABECERAS_DE_IDENTIDAD = ['X-User-Id', 'X-User-Rol', 'X-User-Bodega'];

    public function __construct(private readonly JwtService $jwt) {}

    public function handle(Request $request, Closure $next): Response
    {
        foreach (self::CABECERAS_DE_IDENTIDAD as $cabecera) {
            $request->headers->remove($cabecera);
        }

        $reclamos = $this->jwt->verificar($this->tokenDe($request));
        $usuario = $this->cargarUsuario($reclamos->sub);
        $this->comprobarQueNoEstaRevocado($usuario, $reclamos->iat);

        $request->attributes->set('usuario', $usuario);
        $request->setUserResolver(static fn (): Usuario => $usuario);

        return $next($request);
    }

    private function tokenDe(Request $request): string
    {
        $cabecera = $request->headers->get('Authorization');

        if (! is_string($cabecera) || preg_match('/^Bearer +(\S+)$/i', $cabecera, $coincidencias) !== 1) {
            throw ApiException::noAutenticado();
        }

        return $coincidencias[1];
    }

    private function cargarUsuario(string $sub): Usuario
    {
        // Solo el id en su forma canónica: sin signo, espacios, ceros a la izquierda, decimales ni notación
        // científica, y con tope de longitud para que quepa en un entero.
        if (preg_match('/^[1-9][0-9]{0,17}$/', $sub) !== 1) {
            throw ApiException::noAutenticado();
        }

        $usuario = Usuario::query()->with('rol')->find((int) $sub);

        if ($usuario === null || ! $usuario->activo || $usuario->rol === null) {
            throw ApiException::noAutenticado();
        }

        return $usuario;
    }

    /**
     * Revocación de sesiones: restablecer la contraseña o inactivar al usuario fija `sesiones_desde`, y un token
     * emitido (`iat`, en segundos) antes de esa marca ya no vale. Con `iat` igual o posterior sí: así quien inicia
     * sesión con la contraseña temporal en el mismo segundo del restablecimiento no queda bloqueado. Esa ventana de
     * un segundo es una limitación aceptada: un token emitido en ese mismo segundo sobrevive a la revocación.
     *
     * Es el mismo 401 genérico de cualquier otro token no válido, sin indicar que fue por revocación.
     */
    private function comprobarQueNoEstaRevocado(Usuario $usuario, int $iat): void
    {
        if ($usuario->sesiones_desde !== null && $iat < $usuario->sesiones_desde->getTimestamp()) {
            throw ApiException::noAutenticado();
        }
    }
}
