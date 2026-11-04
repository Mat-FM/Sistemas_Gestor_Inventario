<?php

namespace App\Services\Jwt;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Illuminate\Support\Carbon;
use InvalidArgumentException;
use LogicException;
use Throwable;

/**
 * Emite y verifica el JWT de sesión (RNF07): HS256, `sub`, `rol`, `id_bodega`, `iat`, `exp` y `jti`.
 *
 * Es una pieza de seguridad y nada más (RNF13): no consulta la base, no enruta y no gestiona usuarios; recibe el
 * Usuario ya cargado para emitir. El algoritmo se fija en la llave, así que lo que diga la cabecera del token
 * no cuenta: `none` y cualquier otro algoritmo fallan. Toda causa de rechazo sale como el mismo 401
 * NO_AUTENTICADO genérico, sin el mensaje interno de la biblioteca.
 */
class JwtService
{
    private const ALGORITMO = 'HS256';

    private const LONGITUD_MINIMA_SECRETO = 32;

    private readonly Key $llave;

    public function __construct(#[\SensitiveParameter] private readonly string $secreto, private readonly int $ttlMinutes = 60)
    {
        if (strlen($secreto) < self::LONGITUD_MINIMA_SECRETO) {
            throw new InvalidArgumentException('El secreto del JWT debe tener al menos '.self::LONGITUD_MINIMA_SECRETO.' caracteres.');
        }

        if ($ttlMinutes < 1) {
            throw new InvalidArgumentException('La vigencia del JWT debe ser de al menos un minuto.');
        }

        $this->llave = new Key($secreto, self::ALGORITMO);
    }

    /**
     * El usuario debe venir guardado y con la relación `rol` cargada (el servicio no la busca en la base).
     *
     * @return array{token: string, expira_en: int} `expira_en` en segundos
     */
    public function emitir(Usuario $usuario): array
    {
        if ($usuario->getKey() === null || ! $usuario->relationLoaded('rol') || $usuario->rol === null) {
            throw new LogicException('El usuario debe estar guardado y traer su rol cargado.');
        }

        // Una sola lectura del reloj: iat, exp y el reloj de la biblioteca salen del mismo instante.
        $ahora = Carbon::now()->getTimestamp();
        $segundos = $this->ttlMinutes * 60;

        $token = $this->conRelojFijo($ahora, fn (): string => JWT::encode([
            'sub' => (string) $usuario->getKey(),
            'rol' => $usuario->rol->nombre,
            'id_bodega' => $usuario->id_bodega,
            'iat' => $ahora,
            'exp' => $ahora + $segundos,
            'jti' => bin2hex(random_bytes(16)),
        ], $this->secreto, self::ALGORITMO));

        return ['token' => $token, 'expira_en' => $segundos];
    }

    /**
     * Devuelve las claims (`sub` como texto, `rol`, `id_bodega` entero o nulo, `iat`, `exp`, `jti`) de un token
     * con firma HS256 válida, vigente y con todas esas claims del tipo esperado.
     *
     * Las claims `rol` e `id_bodega` son solo informativas: quien autoriza debe leerlas de la base (D3).
     *
     * @throws ApiException 401 NO_AUTENTICADO ante cualquier fallo
     */
    public function verificar(string $token): object
    {
        try {
            $reclamos = $this->conRelojFijo(
                Carbon::now()->getTimestamp(),
                fn () => JWT::decode($token, $this->llave),
            );
        } catch (Throwable) {
            throw ApiException::noAutenticado();
        }

        if (! $this->reclamosCompletas($reclamos)) {
            throw ApiException::noAutenticado();
        }

        return $reclamos;
    }

    /**
     * firebase/php-jwt mide el vencimiento con time() o con la propiedad estática JWT::$timestamp, nunca con
     * Carbon. Se fija esa propiedad al instante de Carbon mientras dura la operación para que ambos relojes
     * coincidan (y Carbon::setTestNow() alcance a la biblioteca), con la holgura en 0, y se restablece en un
     * finally: la biblioteca guarda ese estado en la clase, así que no puede quedar colgado entre peticiones
     * (Octane, colas) ni entre pruebas.
     *
     * Hoy JWT::encode() no lee el reloj; se fija igualmente para que emitir y verificar usen siempre el mismo.
     *
     * @template T
     *
     * @param  callable(): T  $operacion
     * @return T
     */
    private function conRelojFijo(int $ahora, callable $operacion): mixed
    {
        $holguraPrevia = JWT::$leeway;

        JWT::$timestamp = $ahora;
        JWT::$leeway = 0;

        try {
            return $operacion();
        } finally {
            JWT::$timestamp = null;
            JWT::$leeway = $holguraPrevia;
        }
    }

    /**
     * La biblioteca solo comprueba `exp` si el token la trae: un token bien firmado sin `exp` no vencería nunca.
     */
    private function reclamosCompletas(object $r): bool
    {
        return isset($r->sub) && is_string($r->sub) && $r->sub !== ''
            && isset($r->rol) && is_string($r->rol)
            && isset($r->exp) && is_int($r->exp)
            && isset($r->iat) && is_int($r->iat)
            && property_exists($r, 'id_bodega') && ($r->id_bodega === null || is_int($r->id_bodega));
    }
}
