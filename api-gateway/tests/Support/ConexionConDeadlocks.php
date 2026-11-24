<?php

namespace Tests\Support;

use Illuminate\Database\QueryException;
use Illuminate\Database\SQLiteConnection;
use PDOException;

/**
 * Una conexión SQLite que falla como lo hace MySQL bajo concurrencia: las sentencias que escriben (insert, update, delete) o
 * leen con bloqueo (select … for update) lanzan el error elegido las primeras `$fallosPendientes` veces y luego funcionan.
 * Cuenta cuántas veces se intentó cada una para que las pruebas comprueben los reintentos.
 */
class ConexionConDeadlocks extends SQLiteConnection
{
    public const DEADLOCK = 'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction';

    public int $fallosPendientes = 0;

    public string $mensaje = self::DEADLOCK;

    /** @var string Fragmento (en minúsculas) de la sentencia que debe fallar. */
    public string $sobre = 'insert';

    /** @var int Cuántas veces se intentó una sentencia que coincide con `$sobre`. */
    public int $intentos = 0;

    public function fallar(string $sobre, int $veces = 1, string $mensaje = self::DEADLOCK): void
    {
        $this->sobre = strtolower($sobre);
        $this->fallosPendientes = $veces;
        $this->mensaje = $mensaje;
        $this->intentos = 0;
    }

    private function simularFallo(string $consulta, array $bindings): void
    {
        if (! str_contains(strtolower($consulta), $this->sobre)) {
            return;
        }

        $this->intentos++;

        if ($this->fallosPendientes > 0) {
            $this->fallosPendientes--;

            throw new QueryException($this->getName() ?? 'sqlite', $consulta, $bindings, new PDOException($this->mensaje));
        }
    }

    public function affectingStatement($query, $bindings = [])
    {
        $this->simularFallo($query, $bindings);

        return parent::affectingStatement($query, $bindings);
    }

    public function select($query, $bindings = [], $useReadPdo = true, array $fetchUsing = [])
    {
        $this->simularFallo($query, $bindings);

        return parent::select($query, $bindings, $useReadPdo, $fetchUsing);
    }
}
