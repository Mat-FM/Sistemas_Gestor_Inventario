<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use App\Services\Proxy\ProxyService;
use App\Services\Routing\RouteMap;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Comodín de las rutas públicas `/api/...` que atienden los microservicios (Tabla 4). Decide si la petición se
 * reenvía y a dónde; el reenvío en sí es de ProxyService (RNF13).
 *
 * Orden: la ruta debe estar publicada en el mapa (si no, 404 `NO_EXISTE`, sin revelar nada más); el rol del usuario,
 * recién leído de la base por AuthenticateJwt, debe estar entre los de la regla (si no, 403 `SIN_PERMISO`); y solo
 * entonces se llama al servicio.
 */
class ProxyController extends Controller
{
    private const PREFIJO = '/api/';

    public function __construct(
        private readonly RouteMap $mapa,
        private readonly ProxyService $proxy,
    ) {}

    public function __invoke(Request $request): Response
    {
        $usuario = $request->attributes->get('usuario');
        if (! $usuario instanceof Usuario) {
            throw ApiException::noAutenticado();
        }

        // La ruta cruda (sin decodificar) y no el parámetro {path} del enrutador, que ya llega decodificado: RouteMap
        // decodifica y valida él mismo para rechazar `%2e%2e`, `%2f` y demás (Tarea 8).
        $ruta = $request->getPathInfo();
        if (! str_starts_with($ruta, self::PREFIJO)) {
            throw ApiException::noExiste();
        }

        // getMethod() y no getRealMethod(): se autoriza el mismo método que ProxyService envía, también si el
        // cliente lo cambió con `_method` o X-HTTP-Method-Override.
        $regla = $this->mapa->resolve($request->getMethod(), substr($ruta, strlen(self::PREFIJO)));
        if ($regla === null) {
            throw ApiException::noExiste();
        }

        if (! in_array($usuario->rol?->nombre, $regla->roles, true)) {
            throw ApiException::sinPermiso();
        }

        return $this->proxy->reenviar($request, $usuario, $regla);
    }
}
