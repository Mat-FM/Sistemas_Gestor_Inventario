<?php

namespace App\Services\Routing;

use App\Support\Roles;
use InvalidArgumentException;

/**
 * Mapa de las rutas públicas del Gateway (Tablas 4 y 7 a 12): decide a qué servicio va cada petición y qué roles
 * pueden hacerla. Es solo enrutamiento y autorización (RNF13): no consulta la base, no lee el usuario y no llama
 * a ningún servicio; el proxy aplica lo que este mapa decide.
 *
 * Lo que no está en el mapa no se publica y `resolve()` devuelve `null`; nunca hay un valor por defecto (RF-4).
 *
 * **Tabla.** Se construye con la lista de `config/gateway_routes.php`. Una tabla mal escrita (método no listado,
 * rol desconocido, ruta mal formada o repetida, ruta `/internas`) lanza una `InvalidArgumentException` al
 * construirla, así que un error de transcripción falla al arrancar y no abre un permiso en silencio.
 *
 * **Coincidencia.** Segmento a segmento; `{param}` casa con un único segmento no vacío. Si varias reglas del mismo
 * método casan, gana la que tiene un segmento literal más a la izquierda (por ejemplo `lotes/sugerencia-salida`
 * frente a `lotes/{id}`), sin importar el orden en que se declararon. Los segmentos literales distinguen
 * mayúsculas de minúsculas; el método no.
 *
 * **La ruta llega cruda.** `resolve()` recibe la ruta tal como llegó (sin el prefijo `/api/` ni la consulta), con
 * sus `%2e`, `%2f`, `//`, `\`... y la decodifica y valida él mismo, porque el parámetro que entrega el enrutador ya
 * viene decodificado y habría perdido esa información. Primero parte por `/` y después decodifica cada segmento
 * (al revés, un `%2f` pasaría a ser un separador). Devuelve `null` ante cualquiera de estos casos:
 *
 *  - un segmento vacío (`//`, barra inicial, más de una barra final);
 *  - un segmento `.` o `..`, también codificado (`%2e%2e`, `.%2e`);
 *  - una `/` o una `\` dentro de un segmento una vez decodificado (`%2f`, `%5c`);
 *  - un NUL o cualquier carácter de control, codificado o no (`%00`, `%0a`, `%7f`);
 *  - un escape `%` mal formado (`%zz`, `%2`, un `%` final) o una decodificación doble (`%252e`, `%252f`);
 *  - texto que no es UTF-8 válido (`%ff`, `%c0%ae`).
 *
 * Se tolera y quita una única barra final (`productos/25/` equivale a `productos/25`).
 *
 * **La ruta que se reenvía.** `RouteRule::$rutaInterna` no es el texto crudo: son los segmentos validados, vueltos
 * a codificar con `rawurlencode`. Así el servicio recibe exactamente lo que se autorizó y un `%3F` o un `%23`
 * dentro de un identificador no se convierte en una consulta o un fragmento al concatenarlo a la URL.
 */
class RouteMap
{
    private const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

    /** Primer segmento de las rutas que solo llaman otros servicios dentro del clúster. */
    private const PREFIJO_INTERNO = 'internas';

    /**
     * Reglas compiladas, por método y ordenadas de la más específica a la menos. Cada regla guarda sus
     * segmentos (`null` es un `{param}`), el servicio y los roles.
     *
     * @var array<string, list<array{segmentos: list<string|null>, servicio: string, roles: list<string>}>>
     */
    private readonly array $indice;

    /**
     * @param  array<mixed>  $reglas  lista de `['metodo' => 'GET', 'ruta' => 'productos/{id}', 'servicio' => 'ms-catalogo', 'roles' => [...]]`
     *
     * @throws InvalidArgumentException si alguna regla está mal formada o repetida
     */
    public function __construct(array $reglas)
    {
        $indice = [];
        $vistas = [];

        foreach ($reglas as $posicion => $regla) {
            $compilada = self::compilar($regla, $posicion);

            // Los nombres de los comodines no cuentan: `a/{id}` y `a/{otro}` son la misma forma.
            $forma = $compilada['metodo'].' '.implode('/', array_map(fn (?string $s): string => $s ?? '{}', $compilada['segmentos']));
            if (isset($vistas[$forma])) {
                throw new InvalidArgumentException("La regla #{$posicion} repite «{$forma}».");
            }
            $vistas[$forma] = true;

            $indice[$compilada['metodo']][] = [
                'segmentos' => $compilada['segmentos'],
                'servicio' => $compilada['servicio'],
                'roles' => $compilada['roles'],
            ];
        }

        // usort es estable: las reglas de igual especificidad conservan su orden de declaración.
        foreach ($indice as &$delMetodo) {
            usort($delMetodo, self::masEspecificaPrimero(...));
        }
        unset($delMetodo);

        $this->indice = $indice;
    }

    /**
     * La regla publicada para ese método y esa ruta, o `null` si no está publicada (o si la ruta no es válida).
     *
     * @param  string  $metodo  verbo HTTP, sin distinguir mayúsculas; HEAD, OPTIONS y los demás no listados dan `null`
     * @param  string  $ruta  ruta cruda sin el prefijo `/api/` ni cadena de consulta, por ejemplo `productos/25`
     */
    public function resolve(string $metodo, string $ruta): ?RouteRule
    {
        $reglas = $this->indice[strtoupper($metodo)] ?? null;
        if ($reglas === null) {
            return null;
        }

        $segmentos = self::segmentosValidos($ruta);
        if ($segmentos === null) {
            return null;
        }

        foreach ($reglas as $regla) {
            if (self::casa($regla['segmentos'], $segmentos)) {
                return new RouteRule(
                    $regla['servicio'],
                    $regla['roles'],
                    implode('/', array_map('rawurlencode', $segmentos)),
                );
            }
        }

        return null;
    }

    /**
     * Quita una única barra final, parte por `/` y decodifica y valida cada segmento. `null` si algo no vale.
     *
     * @return list<string>|null los segmentos decodificados
     */
    private static function segmentosValidos(string $ruta): ?array
    {
        // Exactamente una: `productos/25//` deja un segmento vacío y se rechaza. Sin rtrim.
        if (str_ends_with($ruta, '/')) {
            $ruta = substr($ruta, 0, -1);
        }

        $segmentos = [];
        foreach (explode('/', $ruta) as $crudo) {
            $segmento = self::decodificar($crudo);
            if ($segmento === null) {
                return null;
            }
            $segmentos[] = $segmento;
        }

        return $segmentos;
    }

    /**
     * Decodifica un segmento una sola vez y lo valida. `null` si el segmento no es aceptable.
     */
    private static function decodificar(string $crudo): ?string
    {
        // Vacío: `//`, barra inicial o la ruta vacía.
        if ($crudo === '') {
            return null;
        }

        // Todo `%` abre un escape completo: `%zz`, `%2` o un `%` final son una petición mal formada.
        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $crudo) === 1) {
            return null;
        }

        $segmento = rawurldecode($crudo);

        if ($segmento === '.' || $segmento === '..') {
            return null;
        }

        // Un separador que viaja codificado: no puede acabar siendo parte de otro nivel de la ruta.
        if (str_contains($segmento, '/') || str_contains($segmento, '\\')) {
            return null;
        }

        // Antes del patrón con /u: un texto que no es UTF-8 (`%ff`, `%c0%ae`) no vale.
        if (! mb_check_encoding($segmento, 'UTF-8')) {
            return null;
        }

        // NUL, controles C0 y C1 y DEL, codificados o no.
        if (preg_match('/\p{Cc}/u', $segmento) === 1) {
            return null;
        }

        // Decodificación doble: tras decodificar queda un escape (`%252e` -> `%2e`). Un `%` suelto sí es válido.
        if (preg_match('/%[0-9A-Fa-f]{2}/', $segmento) === 1) {
            return null;
        }

        return $segmento;
    }

    /**
     * @param  list<string|null>  $patron  segmentos de la regla (`null` es un `{param}`)
     * @param  list<string>  $segmentos  segmentos de la petición, ya validados (no vacíos)
     */
    private static function casa(array $patron, array $segmentos): bool
    {
        if (count($patron) !== count($segmentos)) {
            return false;
        }

        foreach ($patron as $posicion => $literal) {
            if ($literal !== null && $literal !== $segmentos[$posicion]) {
                return false;
            }
        }

        return true;
    }

    /**
     * Orden de las reglas de un método: primero las de menos segmentos (no compiten con las demás) y, entre las de
     * igual longitud, la que tiene un literal donde la otra tiene un `{param}`, mirando de izquierda a derecha.
     *
     * @param  array{segmentos: list<string|null>}  $a
     * @param  array{segmentos: list<string|null>}  $b
     */
    private static function masEspecificaPrimero(array $a, array $b): int
    {
        if (count($a['segmentos']) !== count($b['segmentos'])) {
            return count($a['segmentos']) <=> count($b['segmentos']);
        }

        foreach ($a['segmentos'] as $posicion => $segmento) {
            $esComodinA = $segmento === null;
            $esComodinB = $b['segmentos'][$posicion] === null;

            if ($esComodinA !== $esComodinB) {
                return $esComodinA <=> $esComodinB;
            }
        }

        return 0;
    }

    /**
     * Valida una regla de la tabla y la deja lista para comparar.
     *
     * @return array{metodo: string, segmentos: list<string|null>, servicio: string, roles: list<string>}
     *
     * @throws InvalidArgumentException
     */
    private static function compilar(mixed $regla, int|string $posicion): array
    {
        $donde = "La regla #{$posicion}";

        if (! is_array($regla)) {
            throw new InvalidArgumentException("{$donde} debe ser un arreglo.");
        }

        $metodo = $regla['metodo'] ?? null;
        if (! is_string($metodo) || ! in_array($metodo, self::METODOS, true)) {
            throw new InvalidArgumentException("{$donde} debe tener un método de ".implode(', ', self::METODOS).' en mayúsculas.');
        }

        $servicio = $regla['servicio'] ?? null;
        if (! is_string($servicio) || $servicio === '') {
            throw new InvalidArgumentException("{$donde} debe nombrar su servicio.");
        }

        $roles = $regla['roles'] ?? null;
        if (! is_array($roles) || $roles === [] || ! array_is_list($roles)) {
            throw new InvalidArgumentException("{$donde} debe listar al menos un rol (una regla sin roles no la podría usar nadie).");
        }
        foreach ($roles as $rol) {
            if (! is_string($rol) || ! in_array($rol, Roles::TODOS, true)) {
                throw new InvalidArgumentException("{$donde} tiene un rol desconocido.");
            }
        }

        $ruta = $regla['ruta'] ?? null;
        if (! is_string($ruta) || $ruta === '') {
            throw new InvalidArgumentException("{$donde} debe tener una ruta.");
        }

        $segmentos = [];
        foreach (explode('/', $ruta) as $segmento) {
            if ($segmento === '' || $segmento === '.' || $segmento === '..') {
                throw new InvalidArgumentException("{$donde}: la ruta «{$ruta}» no puede tener segmentos vacíos, «.» ni «..» (ni barra inicial o final).");
            }

            if (preg_match('/\A\{[a-z][a-z0-9_]*\}\z/', $segmento) === 1) {
                $segmentos[] = null;

                continue;
            }

            // Solo caracteres sin codificar: un literal con `%`, `\`, llaves sueltas... nunca casaría.
            if (preg_match('/\A[A-Za-z0-9._~-]+\z/', $segmento) !== 1) {
                throw new InvalidArgumentException("{$donde}: el segmento «{$segmento}» de la ruta no es un literal ni un {comodin} válido.");
            }

            $segmentos[] = $segmento;
        }

        // El primer segmento identifica el servicio y debe ser literal: un `{param}` ahí casaría con todo, también
        // con `internas`. Y las rutas `/internas` no se publican nunca.
        if ($segmentos[0] === null || $segmentos[0] === self::PREFIJO_INTERNO) {
            throw new InvalidArgumentException("{$donde}: la ruta «{$ruta}» debe empezar por un segmento literal que no sea «".self::PREFIJO_INTERNO.'».');
        }

        return ['metodo' => $metodo, 'segmentos' => $segmentos, 'servicio' => $servicio, 'roles' => $roles];
    }
}
