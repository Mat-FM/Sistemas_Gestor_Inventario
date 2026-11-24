<?php

namespace App\Cache;

use Closure;
use Illuminate\Cache\DatabaseStore;
use Illuminate\Database\DetectsConcurrencyErrors;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * El almacén de caché `database` de Laravel, pero reintentando las operaciones que MySQL aborta por un deadlock.
 *
 * El contador del límite de peticiones (RNF19) vive en la tabla `cache` de MySQL para que las copias del Gateway lo compartan
 * (RNF05). Cada petición hace tres escrituras sobre las mismas claves (la marca de tiempo, el contador y su incremento), y
 * `add` además lee borrando lo vencido. Cuando varias llegan a la vez, sobre todo al abrirse la ventana de un minuto, MySQL
 * aborta una con «1213 Deadlock found»: es un error transitorio y de diseño de InnoDB (el motor lo dice: «try restarting
 * transaction»), y sin reintento el Gateway respondía 500 a una petición válida.
 */
class DatabaseStoreConReintento extends DatabaseStore
{
    use DetectsConcurrencyErrors;

    /** Intentos en total (el primero y los reintentos). Un deadlock se resuelve casi siempre al segundo. */
    public const INTENTOS = 4;

    public function many(array $keys)
    {
        return $this->reintentando(fn () => parent::many($keys));
    }

    public function add($key, $value, $seconds)
    {
        return $this->reintentando(fn () => parent::add($key, $value, $seconds));
    }

    public function put($key, $value, $seconds)
    {
        return $this->reintentando(fn () => parent::put($key, $value, $seconds));
    }

    public function putMany(array $values, $seconds)
    {
        return $this->reintentando(fn () => parent::putMany($values, $seconds));
    }

    protected function incrementOrDecrement($key, $value, Closure $callback)
    {
        return $this->reintentando(fn () => parent::incrementOrDecrement($key, $value, $callback));
    }

    public function forget($key)
    {
        return $this->reintentando(fn () => parent::forget($key));
    }

    public function forgetIfExpired($key)
    {
        return $this->reintentando(fn () => parent::forgetIfExpired($key));
    }

    /**
     * Con una transacción abierta por quien nos llama, el deadlock ya la invalidó entera: repetir solo esta sentencia sería
     * escribir fuera de ella. Entonces el error sube y lo decide quien abrió la transacción, como hace Laravel.
     */
    private function reintentando(Closure $operacion): mixed
    {
        if ($this->getConnection()->transactionLevel() > 0) {
            return $operacion();
        }

        return retry(
            self::INTENTOS,
            fn () => $operacion(),
            $this->esperarAntesDeReintentar(...),
            fn (Throwable $e) => $this->esDeadlock($e),
        );
    }

    /**
     * Milisegundos de espera antes del siguiente intento; `retry` la llama solo cuando va a reintentar. Es corta y crece con el
     * número de intento, con algo de azar para que las peticiones que chocaron no vuelvan a chocar a la vez. Deja un aviso para
     * ver cuánta contención hay sin que una petición válida falle.
     */
    private function esperarAntesDeReintentar(int $intento, Throwable $e): int
    {
        Log::warning('deadlock_reintentado', ['intento' => $intento, 'error' => $e->getMessage()]);

        return random_int(5, 15) * $intento;
    }

    private function esDeadlock(Throwable $e): bool
    {
        // «Lock wait timeout» también es un error de concurrencia para Laravel, pero MySQL ya esperó (50 s por defecto): reintentarlo
        // multiplicaría esa espera por los intentos. Solo los deadlocks, que MySQL resuelve al instante, valen la pena.
        return $this->causedByConcurrencyError($e) && ! str_contains($e->getMessage(), 'Lock wait timeout');
    }
}
