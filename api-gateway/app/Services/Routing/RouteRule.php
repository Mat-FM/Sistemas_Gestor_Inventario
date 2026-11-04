<?php

namespace App\Services\Routing;

use App\Support\Roles;

/**
 * Lo que el mapa de rutas decide sobre una petición publicada: a qué servicio va, qué roles pueden hacerla y qué
 * ruta recibe el servicio. Es de solo lectura: quien la recibe (el proxy) no puede ampliar los roles ni cambiar
 * la ruta que se autorizó.
 */
final readonly class RouteRule
{
    /**
     * @param  string  $servicio  nombre del servicio destino, clave de `config('gateway.services')`
     * @param  list<string>  $roles  roles autorizados (valores de {@see Roles})
     * @param  string  $rutaInterna  ruta que recibe el servicio: sin el prefijo `/api` ni barra inicial o final, con
     *                               cada segmento decodificado, validado y codificado de nuevo con `rawurlencode`.
     *                               Puede concatenarse tal cual a la URL del servicio: no contiene `?`, `#`, `.` ni
     *                               `..` como segmento, ni separadores dentro de un segmento
     */
    public function __construct(
        public string $servicio,
        public array $roles,
        public string $rutaInterna,
    ) {}
}
