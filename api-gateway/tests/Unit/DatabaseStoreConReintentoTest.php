<?php

namespace Tests\Unit;

use App\Cache\DatabaseStoreConReintento;
use Illuminate\Cache\RateLimiter;
use Illuminate\Cache\Repository;
use Illuminate\Database\QueryException;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Sleep;
use PDO;
use Tests\Support\ConexionConDeadlocks;
use Tests\TestCase;

/**
 * El contador del límite de peticiones (RNF19) vive en la tabla `cache` de MySQL para que las copias del Gateway lo compartan
 * (RNF05). Con varias peticiones a la vez, MySQL aborta una con «1213 Deadlock found» (leer borrando lo vencido, `insert ignore` y
 * `update` se cruzan sobre la misma clave) y el Gateway respondía 500 a una petición válida. El almacén reintenta esa operación.
 */
class DatabaseStoreConReintentoTest extends TestCase
{
    private ConexionConDeadlocks $conexion;

    private DatabaseStoreConReintento $almacen;

    protected function setUp(): void
    {
        parent::setUp();
        Sleep::fake();

        $this->conexion = new ConexionConDeadlocks(new PDO('sqlite::memory:'), ':memory:', '', []);
        $this->conexion->getSchemaBuilder()->create('cache', function (Blueprint $tabla) {
            $tabla->string('key')->primary();
            $tabla->mediumText('value');
            $tabla->integer('expiration');
        });
        $this->almacen = new DatabaseStoreConReintento($this->conexion, 'cache');
    }

    public function test_add_reintenta_tras_un_deadlock_y_guarda_la_clave(): void
    {
        $this->conexion->fallar('insert', 1);

        $this->assertTrue($this->almacen->add('clave', 7, 60));

        $this->assertSame(2, $this->conexion->intentos);
        $this->assertSame(7, $this->almacen->get('clave'));
    }

    public function test_increment_reintenta_tras_un_deadlock(): void
    {
        $this->almacen->put('contador', 0, 60);
        $this->conexion->fallar('update', 1);

        $this->assertSame(1, $this->almacen->increment('contador'));

        $this->assertSame(2, $this->conexion->intentos);
    }

    public function test_leer_una_clave_vencida_reintenta_el_borrado_que_hace_un_deadlock(): void
    {
        $this->conexion->table('cache')->insert(['key' => 'vieja', 'value' => serialize(1), 'expiration' => 1]);
        $this->conexion->fallar('delete', 1);

        $this->assertNull($this->almacen->get('vieja'));

        $this->assertSame(2, $this->conexion->intentos);
    }

    public function test_el_limitador_de_peticiones_sobrevive_a_un_deadlock_en_su_marca_de_tiempo(): void
    {
        $limitador = new RateLimiter(new Repository($this->almacen));
        $this->conexion->fallar('insert', 1);

        $this->assertSame(1, $limitador->hit('usuario:1', 60));
        $this->assertSame(2, $limitador->hit('usuario:1', 60));
    }

    public function test_si_el_deadlock_no_cede_se_rinde_tras_cuatro_intentos_y_lo_lanza(): void
    {
        $this->conexion->fallar('insert', 10);

        try {
            $this->almacen->add('clave', 1, 60);
            $this->fail('Debía lanzar el deadlock tras agotar los intentos.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('Deadlock found', $e->getMessage());
        }

        $this->assertSame(DatabaseStoreConReintento::INTENTOS, $this->conexion->intentos);
    }

    public function test_un_error_que_no_es_de_concurrencia_no_se_reintenta(): void
    {
        $this->conexion->fallar('insert', 1, 'SQLSTATE[42S02]: Base table or view not found: 1146 Table cache doesn\'t exist');

        $this->expectException(QueryException::class);

        try {
            $this->almacen->add('clave', 1, 60);
        } finally {
            $this->assertSame(1, $this->conexion->intentos);
        }
    }

    public function test_la_espera_por_un_bloqueo_no_se_reintenta_porque_ya_esperó_los_segundos_del_servidor(): void
    {
        $this->conexion->fallar('insert', 1, 'SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded; try restarting transaction');

        $this->expectException(QueryException::class);

        try {
            $this->almacen->add('clave', 1, 60);
        } finally {
            $this->assertSame(1, $this->conexion->intentos);
        }
    }

    public function test_dentro_de_una_transaccion_abierta_no_se_reintenta(): void
    {
        $this->conexion->fallar('insert', 1);

        $this->expectException(QueryException::class);

        try {
            $this->conexion->transaction(fn () => $this->almacen->add('clave', 1, 60));
        } finally {
            $this->assertSame(1, $this->conexion->intentos);
        }
    }

    public function test_cada_reintento_deja_un_aviso_en_el_registro(): void
    {
        Log::shouldReceive('warning')->twice()->with('deadlock_reintentado', \Mockery::on(
            fn (array $contexto) => isset($contexto['intento']) && $contexto['intento'] >= 1,
        ));
        $this->conexion->fallar('insert', 2);

        $this->assertTrue($this->almacen->add('clave', 1, 60));
    }

    public function test_sin_deadlock_no_se_escribe_ningun_aviso(): void
    {
        Log::shouldReceive('warning')->never();

        $this->assertTrue($this->almacen->add('clave', 1, 60));
    }

    public function test_el_almacen_database_de_la_aplicacion_es_el_que_reintenta(): void
    {
        $this->assertInstanceOf(DatabaseStoreConReintento::class, Cache::store('database')->getStore());
    }
}
