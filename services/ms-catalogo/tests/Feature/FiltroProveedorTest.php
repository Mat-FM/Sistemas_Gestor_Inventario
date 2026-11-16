<?php

namespace Tests\Feature;

use App\Models\Categoria;
use App\Models\Producto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Sleep;
use Tests\TestCase;

/**
 * Filtro ?id_proveedor de GET /productos (RF12), que llama a ms-proveedores (llamada 8), y RNF18:
 * reintentos y cortacircuitos. ms-proveedores se simula con Http::fake; las esperas, con Sleep::fake.
 */
class FiltroProveedorTest extends TestCase
{
    use RefreshDatabase;

    private const URL = 'http://ms-proveedores.prueba';

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.ms_proveedores.url' => self::URL]);
        Http::preventStrayRequests();
        Sleep::fake();

        $categoria = Categoria::create(['nombre' => 'Café']);
        foreach (['P-1', 'P-2', 'P-3'] as $codigo) {
            Producto::create([
                'codigo' => $codigo, 'nombre' => "Producto {$codigo}", 'id_categoria' => $categoria->id_categoria,
                'unidad_medida' => 'UNIDAD', 'precio' => 1000, 'estado' => 'ACTIVO',
            ]);
        }
    }

    public function test_devuelve_solo_los_productos_del_proveedor_y_reenvia_el_x_request_id(): void
    {
        Http::fake([self::URL.'/proveedores/5/productos' => Http::response([
            ['id_proveedor_producto' => 1, 'id_producto' => 2, 'fecha_asociacion' => '2026-11-14T19:09:40Z'],
            ['id_proveedor_producto' => 2, 'id_producto' => 3, 'fecha_asociacion' => '2026-11-14T19:09:40Z'],
        ])]);

        $this->getJson('/productos?id_proveedor=5&codigo=P-2', ['X-Request-Id' => 'id-del-gateway'])
            ->assertOk()
            ->assertJsonPath('meta.total', 1)
            ->assertJsonPath('datos.0.codigo', 'P-2');

        Http::assertSent(fn (Request $r) => $r->url() === self::URL.'/proveedores/5/productos'
            && $r->header('X-Request-Id') === ['id-del-gateway']);
    }

    public function test_si_el_proveedor_no_existe_la_lista_sale_vacia(): void
    {
        Http::fake([self::URL.'/*' => Http::response(['error' => ['codigo' => 'NO_EXISTE']], 404)]);

        $this->getJson('/productos?id_proveedor=9')
            ->assertOk()
            ->assertJsonPath('meta.total', 0);

        Http::assertSentCount(1);
    }

    public function test_reintenta_ante_un_5xx_y_luego_responde_503(): void
    {
        Http::fake([self::URL.'/*' => Http::response('', 500)]);

        $this->getJson('/productos?id_proveedor=5')
            ->assertStatus(503)
            ->assertJsonPath('error.codigo', 'SERVICIO_NO_DISPONIBLE');

        // 1 intento + 3 reintentos.
        Http::assertSentCount(4);
    }

    public function test_reintenta_ante_un_fallo_de_conexion_y_luego_responde_503(): void
    {
        Http::fake(fn () => throw new ConnectionException('Connection refused'));

        $this->getJson('/productos?id_proveedor=5')
            ->assertStatus(503)
            ->assertJsonPath('error.codigo', 'SERVICIO_NO_DISPONIBLE');

        // 1 intento + 3 reintentos, con las esperas de RNF18.
        Sleep::assertSequence([Sleep::for(200)->milliseconds(), Sleep::for(400)->milliseconds(), Sleep::for(800)->milliseconds()]);
    }

    public function test_reintenta_y_se_recupera_si_ms_proveedores_vuelve_a_responder(): void
    {
        Http::fakeSequence(self::URL.'/*')
            ->push('', 503)
            ->push([['id_proveedor_producto' => 1, 'id_producto' => 1, 'fecha_asociacion' => '2026-11-14T19:09:40Z']]);

        $this->getJson('/productos?id_proveedor=5')
            ->assertOk()
            ->assertJsonPath('meta.total', 1);

        Http::assertSentCount(2);
    }

    public function test_no_reintenta_un_4xx_distinto_de_404(): void
    {
        Http::fake([self::URL.'/*' => Http::response('', 400)]);

        $this->getJson('/productos?id_proveedor=5')->assertStatus(503);

        Http::assertSentCount(1);
    }

    public function test_el_cortacircuitos_se_abre_tras_5_fallos_y_se_cierra_cuando_vuelve_a_responder(): void
    {
        $caido = true;
        // Por referencia (&), para poder "levantar" ms-proveedores más adelante en la prueba.
        Http::fake(function () use (&$caido) {
            return $caido ? Http::response('', 500) : Http::response([]);
        });

        foreach (range(1, 5) as $i) {
            $this->getJson('/productos?id_proveedor=5')->assertStatus(503);
        }
        Http::assertSentCount(20);

        // Abierto: responde 503 sin llamar a ms-proveedores.
        $this->getJson('/productos?id_proveedor=5')->assertStatus(503);
        Http::assertSentCount(20);

        // Pasados 30 s se vuelve a probar; ms-proveedores ya responde.
        $this->travel(31)->seconds();
        $caido = false;

        $this->getJson('/productos?id_proveedor=5')
            ->assertOk()
            ->assertJsonPath('meta.total', 0);
        Http::assertSentCount(21);
    }

    public function test_las_demas_busquedas_no_llaman_a_ms_proveedores(): void
    {
        Http::fake();

        $this->getJson('/productos?nombre=P-1')->assertOk();

        Http::assertNothingSent();
    }
}
