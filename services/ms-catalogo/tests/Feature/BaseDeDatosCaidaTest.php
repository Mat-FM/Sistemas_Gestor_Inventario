<?php

namespace Tests\Feature;

use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use PDOException;
use Tests\TestCase;

/**
 * Con la base de datos del servicio inalcanzable toda ruta que la use responde 503 SERVICIO_NO_DISPONIBLE (RNF18) y no
 * 500: para el cliente un 503 se reintenta, un 500 es un fallo del código.
 */
class BaseDeDatosCaidaTest extends TestCase
{
    private const SECRETO = 'detalle-interno-sensible-3f9a';

    private function consultaFallida(string $mensajeDelDriver): QueryException
    {
        return new QueryException('mysql', 'select * from productos', [], new PDOException($mensajeDelDriver));
    }

    public function test_con_la_base_inalcanzable_un_listado_responde_503(): void
    {
        if (! extension_loaded('pdo_mysql')) {
            $this->markTestSkipped('Hace falta pdo_mysql para abrir una conexión real a un MySQL inalcanzable.');
        }

        // Un MySQL real que nadie escucha: la misma falla que con la base caída en producción.
        config([
            'database.connections.mysql_caida' => [
                'driver' => 'mysql', 'host' => '127.0.0.1', 'port' => 1, 'database' => 'catalogo_db', 'username' => 'nadie', 'password' => 'nada',
            ],
            'database.default' => 'mysql_caida',
        ]);
        DB::purge();

        $this->getJson('/productos')
            ->assertStatus(503)
            ->assertExactJson(['error' => ['codigo' => 'SERVICIO_NO_DISPONIBLE', 'mensaje' => 'El servicio no está disponible.', 'detalles' => []]]);
    }

    public function test_un_error_de_conexion_a_la_base_es_503_sin_exponer_el_detalle_y_se_registra(): void
    {
        Route::get('/_prueba/bd-caida', fn () => throw $this->consultaFallida('SQLSTATE[HY000] [2002] Connection refused '.self::SECRETO));
        Log::spy();

        $respuesta = $this->getJson('/_prueba/bd-caida');

        $respuesta->assertStatus(503)->assertJsonPath('error.codigo', 'SERVICIO_NO_DISPONIBLE');
        $this->assertStringNotContainsString(self::SECRETO, $respuesta->getContent());
        Log::shouldHaveReceived('error')->atLeast()->once();
    }

    public function test_un_error_de_sql_que_no_es_de_conexion_sigue_siendo_500(): void
    {
        Route::get('/_prueba/sql-malo', fn () => throw $this->consultaFallida('SQLSTATE[42S22]: Column not found: 1054 Unknown column '.self::SECRETO));

        $respuesta = $this->getJson('/_prueba/sql-malo');

        $respuesta->assertStatus(500)->assertJsonPath('error.codigo', 'ERROR_INTERNO');
        $this->assertStringNotContainsString(self::SECRETO, $respuesta->getContent());
    }
}
