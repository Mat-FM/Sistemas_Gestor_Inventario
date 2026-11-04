<?php

namespace Tests\Unit;

use App\Services\Routing\RouteMap;
use App\Services\Routing\RouteRule;
use App\Support\Roles;
use Error;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use LogicException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * El mapa de rutas es la tabla de autorización de todo el sistema: una fila o un rol mal transcritos son un
 * agujero de permisos. Por eso, además de las comprobaciones de comportamiento, cada servicio se compara con una
 * lista escrita aquí aparte, tomada de la tabla del contrato (Entrega 2, Tablas 7 a 12, p. 27 a 33) con la
 * columna *Roles* tal como la imprime el contrato; el descarte de las menciones «(interno)» y de las filas
 * `/internas/*` lo hace esta prueba, no se da por hecho.
 */
class RouteMapTest extends TestCase
{
    private RouteMap $mapa;

    protected function setUp(): void
    {
        parent::setUp();

        $this->mapa = $this->app->make(RouteMap::class);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Las tablas del contrato (método, ruta interna, columna Roles). Las filas /internas/* se incluyen a
    // propósito: el mapa no debe contenerlas.
    // ---------------------------------------------------------------------------------------------------------

    /** Tabla 7, ms-catalogo (12 filas, 1 interna). */
    private const TABLA_7 = [
        ['GET', '/productos', 'Todos; ms-reportes (interno)'],
        ['GET', '/productos/{id}', 'Todos; ms-inventario (interno)'],
        ['POST', '/productos', 'ADM'],
        ['PUT', '/productos/{id}', 'ADM'],
        ['POST', '/productos/{id}/inactivar', 'ADM'],
        ['POST', '/productos/{id}/activar', 'ADM'],
        ['GET', '/categorias', 'Todos; ms-reportes (interno)'],
        ['GET', '/categorias/{id}', 'Todos'],
        ['POST', '/categorias', 'ADM'],
        ['PUT', '/categorias/{id}', 'ADM'],
        ['DELETE', '/categorias/{id}', 'ADM'],
        ['POST', '/internas/productos/lote', 'ms-reportes (interno)'],
    ];

    /** Tabla 8, ms-proveedores (10 filas, 1 interna). */
    private const TABLA_8 = [
        ['GET', '/proveedores', 'ADM, OPE'],
        ['GET', '/proveedores/{id}', 'ADM, OPE'],
        ['POST', '/proveedores', 'ADM'],
        ['PUT', '/proveedores/{id}', 'ADM'],
        ['POST', '/proveedores/{id}/inactivar', 'ADM'],
        ['POST', '/proveedores/{id}/activar', 'ADM'],
        ['GET', '/proveedores/{id}/productos', 'ADM, OPE; ms-catalogo (interno)'],
        ['POST', '/proveedores/{id}/productos', 'ADM'],
        ['DELETE', '/proveedores/{id}/productos/{id_producto}', 'ADM'],
        ['POST', '/internas/proveedores/lote', 'ms-reportes (interno)'],
    ];

    /** Tabla 9, ms-inventario (24 filas, 1 interna). */
    private const TABLA_9 = [
        ['GET', '/bodegas', 'Todos; ms-reportes (interno)'],
        ['GET', '/bodegas/{id}', 'Todos'],
        ['POST', '/bodegas', 'ADM'],
        ['PUT', '/bodegas/{id}', 'ADM'],
        ['POST', '/bodegas/{id}/inactivar', 'ADM'],
        ['POST', '/bodegas/{id}/activar', 'ADM'],
        ['GET', '/saldos', 'Todos; ms-reportes (interno)'],
        ['GET', '/saldos/bajo-umbral', 'ADM; ms-notificaciones y ms-reportes (interno)'],
        ['GET', '/umbrales', 'ADM'],
        ['PUT', '/umbrales/{id_producto}', 'ADM'],
        ['POST', '/movimientos', 'ADM, OPE; ms-compras (interno)'],
        ['GET', '/movimientos', 'ADM, CON, OPE'],
        ['GET', '/movimientos/{id}', 'ADM, CON, OPE'],
        ['GET', '/lotes', 'ADM, OPE; ms-notificaciones y ms-reportes (interno)'],
        ['GET', '/lotes/sugerencia-salida', 'ADM, OPE'],
        ['POST', '/traslados', 'ADM, OPE'],
        ['POST', '/traslados/{id}/recepcion', 'ADM, OPE'],
        ['GET', '/traslados', 'ADM, OPE'],
        ['POST', '/conteos', 'ADM'],
        ['GET', '/conteos', 'ADM, OPE'],
        ['GET', '/conteos/{id}', 'ADM, OPE'],
        ['PUT', '/conteos/{id}/detalles', 'ADM, OPE'],
        ['POST', '/conteos/{id}/aprobacion', 'ADM'],
        ['POST', '/internas/saldos/carga-inicial', 'ms-reportes (interno)'],
    ];

    /** Tabla 10, ms-compras (9 filas, ninguna interna). */
    private const TABLA_10 = [
        ['GET', '/ordenes-compra', 'ADM, OPE; ms-reportes (interno)'],
        ['GET', '/ordenes-compra/{id}', 'ADM, OPE'],
        ['POST', '/ordenes-compra', 'ADM'],
        ['PUT', '/ordenes-compra/{id}', 'ADM'],
        ['PATCH', '/ordenes-compra/{id}/estado', 'ADM'],
        ['POST', '/ordenes-compra/{id}/recepciones', 'ADM, OPE'],
        ['GET', '/ordenes-compra/{id}/recepciones', 'ADM, OPE'],
        ['POST', '/devoluciones-proveedor', 'ADM, OPE'],
        ['GET', '/devoluciones-proveedor', 'ADM, OPE'],
    ];

    /** Tabla 11, ms-notificaciones (7 filas, 1 interna). */
    private const TABLA_11 = [
        ['GET', '/notificaciones', 'Todos'],
        ['POST', '/notificaciones/{id}/leida', 'Todos'],
        ['GET', '/preferencias/mia', 'Todos'],
        ['PUT', '/preferencias/mia', 'Todos'],
        ['GET', '/configuracion-alertas', 'ADM'],
        ['PUT', '/configuracion-alertas', 'ADM'],
        ['POST', '/internas/notificaciones', 'ms-inventario y ms-compras (interno)'],
    ];

    /** Tabla 12, ms-reportes (8 filas, ninguna interna). */
    private const TABLA_12 = [
        ['GET', '/reportes/existencias', 'ADM, CON'],
        ['GET', '/reportes/valorizacion', 'ADM, CON'],
        ['GET', '/reportes/rotacion', 'ADM, CON'],
        ['GET', '/reportes/kardex', 'ADM, CON'],
        ['GET', '/indicadores', 'ADM, CON'],
        ['POST', '/importaciones', 'ADM'],
        ['GET', '/importaciones', 'ADM'],
        ['GET', '/importaciones/{id}', 'ADM'],
    ];

    /** Tabla 4: primer segmento de cada ruta pública y el servicio al que el Gateway la reenvía. */
    private const TABLA_4 = [
        'productos' => 'ms-catalogo',
        'categorias' => 'ms-catalogo',
        'proveedores' => 'ms-proveedores',
        'bodegas' => 'ms-inventario',
        'saldos' => 'ms-inventario',
        'umbrales' => 'ms-inventario',
        'movimientos' => 'ms-inventario',
        'lotes' => 'ms-inventario',
        'traslados' => 'ms-inventario',
        'conteos' => 'ms-inventario',
        'ordenes-compra' => 'ms-compras',
        'devoluciones-proveedor' => 'ms-compras',
        'notificaciones' => 'ms-notificaciones',
        'preferencias' => 'ms-notificaciones',
        'configuracion-alertas' => 'ms-notificaciones',
        'reportes' => 'ms-reportes',
        'indicadores' => 'ms-reportes',
        'importaciones' => 'ms-reportes',
    ];

    // ---------------------------------------------------------------------------------------------------------
    // Ayudas
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Roles que el Gateway autoriza según el texto de la columna *Roles*: solo lo anterior al `;` (lo que sigue
     * son servicios internos). `Todos` son los cuatro roles. Una ficha desconocida es un error de la prueba.
     *
     * @return list<string> ordenados
     */
    private static function rolesDeLaColumna(string $columna): array
    {
        $fichas = [
            'ADM' => [Roles::ADM],
            'OPE' => [Roles::OPE],
            'VEN' => [Roles::VEN],
            'CON' => [Roles::CON],
            'Todos' => Roles::TODOS,
        ];

        $roles = [];
        foreach (explode(',', explode(';', $columna)[0]) as $ficha) {
            $roles = array_merge($roles, $fichas[trim($ficha)] ?? throw new LogicException("Ficha de rol desconocida: «{$ficha}»"));
        }

        sort($roles);

        return $roles;
    }

    /**
     * Las filas de una tabla del contrato que se publican, como `'METODO /ruta' => roles`. Descarta las que
     * empiezan por /internas.
     *
     * @param  list<array{string, string, string}>  $tabla
     * @return array<string, list<string>>
     */
    private static function publicasDe(array $tabla): array
    {
        $publicas = [];
        foreach ($tabla as [$metodo, $ruta, $columna]) {
            if (! str_starts_with($ruta, '/internas/')) {
                $publicas["{$metodo} {$ruta}"] = self::rolesDeLaColumna($columna);
            }
        }

        return $publicas;
    }

    /**
     * Las reglas del mapa de un servicio, como `'METODO /ruta' => roles`.
     *
     * @return array<string, list<string>>
     */
    private function reglasDelServicio(string $servicio): array
    {
        $reglas = [];
        foreach (config('gateway_routes') as $regla) {
            if ($regla['servicio'] === $servicio) {
                $roles = $regla['roles'];
                sort($roles);
                $reglas["{$regla['metodo']} /{$regla['ruta']}"] = $roles;
            }
        }

        return $reglas;
    }

    /**
     * `'METODO /ruta'` de las reglas del mapa que admiten el rol, ordenadas.
     *
     * @return list<string>
     */
    private function reglasQueAdmiten(string $rol, bool $soloEscritura = false): array
    {
        $reglas = [];
        foreach (config('gateway_routes') as $regla) {
            if (in_array($rol, $regla['roles'], true) && (! $soloEscritura || $regla['metodo'] !== 'GET')) {
                $reglas[] = "{$regla['metodo']} /{$regla['ruta']}";
            }
        }

        sort($reglas);

        return $reglas;
    }

    /**
     * @param  list<string>  $esperadas
     * @return list<string>
     */
    private static function ordenadas(array $esperadas): array
    {
        sort($esperadas);

        return $esperadas;
    }

    /**
     * Una regla para armar mapas pequeños en las pruebas del comportamiento del enrutador.
     *
     * @param  list<string>  $roles
     * @return array{metodo: string, ruta: string, servicio: string, roles: list<string>}
     */
    private static function regla(string $metodo, string $ruta, array $roles = [Roles::ADM], string $servicio = 'ms-catalogo'): array
    {
        return ['metodo' => $metodo, 'ruta' => $ruta, 'servicio' => $servicio, 'roles' => $roles];
    }

    // ---------------------------------------------------------------------------------------------------------
    // La configuración: 66 reglas
    // ---------------------------------------------------------------------------------------------------------

    public function test_hay_66_reglas_validas_y_ninguna_publica_rutas_internas(): void
    {
        $reglas = config('gateway_routes');
        $this->assertCount(66, $reglas);

        foreach ($reglas as $r) {
            $this->assertContains($r['metodo'], ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
            $this->assertNotEmpty($r['roles']);
            $this->assertSame([], array_diff($r['roles'], Roles::TODOS));
            $this->assertArrayHasKey($r['servicio'], config('gateway.services'));
            $this->assertStringStartsNotWith('internas', $r['ruta']);
            // Sin barra inicial: de lo contrario la comprobación anterior pasaría en vacío.
            $this->assertStringStartsNotWith('/', $r['ruta']);
            $this->assertStringEndsNotWith('/', $r['ruta']);
        }
    }

    public function test_el_recuento_por_servicio_es_el_del_contrato(): void
    {
        $this->assertSame(
            ['ms-catalogo' => 11, 'ms-proveedores' => 9, 'ms-inventario' => 23, 'ms-compras' => 9, 'ms-notificaciones' => 6, 'ms-reportes' => 8],
            array_count_values(array_column(config('gateway_routes'), 'servicio')),
        );
    }

    public function test_las_tablas_transcritas_en_esta_prueba_tienen_las_70_filas_del_contrato_y_4_internas(): void
    {
        // Guarda la propia prueba: 12 + 10 + 24 + 9 + 7 + 8 filas, de las que 4 empiezan por /internas.
        $tablas = [self::TABLA_7, self::TABLA_8, self::TABLA_9, self::TABLA_10, self::TABLA_11, self::TABLA_12];
        $this->assertSame([12, 10, 24, 9, 7, 8], array_map('count', $tablas));

        $internas = 0;
        foreach ($tablas as $tabla) {
            foreach ($tabla as [, $ruta]) {
                $internas += str_starts_with($ruta, '/internas/') ? 1 : 0;
            }
        }
        $this->assertSame(4, $internas);
    }

    /** @return array<string, array{string, list<array{string, string, string}>}> */
    public static function tablasPorServicio(): array
    {
        return [
            'ms-catalogo (Tabla 7)' => ['ms-catalogo', self::TABLA_7],
            'ms-proveedores (Tabla 8)' => ['ms-proveedores', self::TABLA_8],
            'ms-inventario (Tabla 9)' => ['ms-inventario', self::TABLA_9],
            'ms-compras (Tabla 10)' => ['ms-compras', self::TABLA_10],
            'ms-notificaciones (Tabla 11)' => ['ms-notificaciones', self::TABLA_11],
            'ms-reportes (Tabla 12)' => ['ms-reportes', self::TABLA_12],
        ];
    }

    /**
     * @param  list<array{string, string, string}>  $tabla
     */
    #[DataProvider('tablasPorServicio')]
    public function test_las_reglas_de_cada_servicio_son_exactamente_las_de_su_tabla(string $servicio, array $tabla): void
    {
        $esperadas = self::publicasDe($tabla);
        $reales = $this->reglasDelServicio($servicio);

        // assertEquals no depende del orden de las claves; el recuento detecta una fila repetida que el
        // arreglo indexado por «método ruta» fundiría en una.
        $this->assertEquals($esperadas, $reales);
        $this->assertSame(
            count($esperadas),
            count(array_filter(config('gateway_routes'), fn (array $r): bool => $r['servicio'] === $servicio)),
        );
    }

    public function test_cada_servicio_es_dueno_de_los_prefijos_que_le_asigna_la_tabla_4(): void
    {
        $vistos = [];
        foreach (config('gateway_routes') as $regla) {
            $prefijo = explode('/', $regla['ruta'])[0];
            $this->assertArrayHasKey($prefijo, self::TABLA_4, "El prefijo «{$prefijo}» no está en la Tabla 4.");
            $this->assertSame(self::TABLA_4[$prefijo], $regla['servicio'], "{$regla['metodo']} /{$regla['ruta']}");
            $vistos[$prefijo] = true;
        }

        // Y el reverso: cada prefijo de la Tabla 4 tiene al menos una regla.
        $this->assertEqualsCanonicalizing(array_keys(self::TABLA_4), array_keys($vistos));
    }

    public function test_ninguna_regla_publica_las_rutas_propias_del_gateway_ni_salud_ni_documentacion(): void
    {
        foreach (config('gateway_routes') as $regla) {
            $this->assertNotContains(
                explode('/', $regla['ruta'])[0],
                ['auth', 'usuarios', 'roles', 'internas', 'health', 'docs', 'api'],
                "{$regla['metodo']} /{$regla['ruta']}",
            );
        }
    }

    public function test_cada_regla_del_mapa_tiene_un_servicio_configurado_y_no_hay_dos_con_el_mismo_metodo_y_ruta(): void
    {
        $servicios = config('gateway.services');
        $vistas = [];

        foreach (config('gateway_routes') as $regla) {
            $this->assertArrayHasKey($regla['servicio'], $servicios);

            // {id} y {id_producto} son la misma forma: se normaliza el nombre del comodín.
            $forma = $regla['metodo'].' '.preg_replace('/\{[^}]*\}/', '{}', $regla['ruta']);
            $this->assertArrayNotHasKey($forma, $vistas, "Regla repetida: {$forma}");
            $vistas[$forma] = true;
        }

        $this->assertCount(66, $vistas);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Invariantes de la matriz de permisos (Tabla 5), una segunda fuente además de las Tablas 7 a 12
    // ---------------------------------------------------------------------------------------------------------

    public function test_el_administrador_esta_en_las_66_reglas(): void
    {
        $this->assertCount(66, $this->reglasQueAdmiten(Roles::ADM));
    }

    public function test_el_vendedor_solo_ve_catalogo_bodegas_existencias_y_sus_notificaciones(): void
    {
        // Tabla 5: Vendedor = Productos y categorías (Ver), Bodegas (Ver), Consultar existencias (Sí) y
        // Notificaciones de su rol y preferencia de correo (Sí). Nada más: son exactamente las filas «Todos».
        $this->assertSame(self::ordenadas([
            'GET /productos', 'GET /productos/{id}', 'GET /categorias', 'GET /categorias/{id}',
            'GET /bodegas', 'GET /bodegas/{id}',
            'GET /saldos',
            'GET /notificaciones', 'POST /notificaciones/{id}/leida', 'GET /preferencias/mia', 'PUT /preferencias/mia',
        ]), $this->reglasQueAdmiten(Roles::VEN));
    }

    public function test_el_contador_ve_lo_mismo_que_el_vendedor_mas_el_kardex_los_reportes_y_los_indicadores(): void
    {
        // Tabla 5: Contador = lo anterior, Kardex (Ver) y Reportes, panel de indicadores y de auditoría (Sí).
        $this->assertSame(self::ordenadas([
            ...$this->reglasQueAdmiten(Roles::VEN),
            'GET /movimientos', 'GET /movimientos/{id}',
            'GET /reportes/existencias', 'GET /reportes/valorizacion', 'GET /reportes/rotacion', 'GET /reportes/kardex',
            'GET /indicadores',
        ]), $this->reglasQueAdmiten(Roles::CON));
    }

    public function test_vendedor_y_contador_solo_consultan_salvo_marcar_leida_una_notificacion_y_su_preferencia(): void
    {
        $escrituraPermitida = ['POST /notificaciones/{id}/leida', 'PUT /preferencias/mia'];

        $this->assertSame($escrituraPermitida, $this->reglasQueAdmiten(Roles::VEN, soloEscritura: true));
        $this->assertSame($escrituraPermitida, $this->reglasQueAdmiten(Roles::CON, soloEscritura: true));
    }

    public function test_el_operador_de_bodega_solo_escribe_lo_de_su_bodega_y_sus_notificaciones(): void
    {
        // Tabla 5: «Su bodega» = movimientos, traslados (envío y recepción), registro de cantidades contadas, y
        // recibir mercancía y devolver a proveedor. Proveedores y órdenes de compra son «Ver»: solo GET.
        $this->assertSame(self::ordenadas([
            'POST /movimientos',
            'POST /traslados', 'POST /traslados/{id}/recepcion',
            'PUT /conteos/{id}/detalles',
            'POST /ordenes-compra/{id}/recepciones', 'POST /devoluciones-proveedor',
            'POST /notificaciones/{id}/leida', 'PUT /preferencias/mia',
        ]), $this->reglasQueAdmiten(Roles::OPE, soloEscritura: true));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Resolución
    // ---------------------------------------------------------------------------------------------------------

    /**
     * @param  list<string>  $roles
     */
    #[DataProvider('matriz')]
    public function test_resuelve_servicio_y_roles(string $metodo, string $ruta, string $servicio, array $roles): void
    {
        $r = $this->mapa->resolve($metodo, $ruta);

        $this->assertInstanceOf(RouteRule::class, $r);
        $this->assertSame($servicio, $r->servicio);
        $this->assertEqualsCanonicalizing($roles, $r->roles);
    }

    /** @return list<array{string, string, string, list<string>}> */
    public static function matriz(): array
    {
        return [
            ['GET',    'productos/25',            'ms-catalogo',      Roles::TODOS],
            ['POST',   'productos',               'ms-catalogo',      [Roles::ADM]],
            ['GET',    'proveedores',             'ms-proveedores',   [Roles::ADM, Roles::OPE]],
            ['DELETE', 'proveedores/3/productos/9', 'ms-proveedores', [Roles::ADM]],
            ['GET',    'saldos',                  'ms-inventario',    Roles::TODOS],
            ['POST',   'movimientos',             'ms-inventario',    [Roles::ADM, Roles::OPE]],
            ['GET',    'movimientos',             'ms-inventario',    [Roles::ADM, Roles::OPE, Roles::CON]],
            ['PUT',    'umbrales/5',              'ms-inventario',    [Roles::ADM]],
            ['POST',   'conteos',                 'ms-inventario',    [Roles::ADM]],
            ['PUT',    'conteos/3/detalles',      'ms-inventario',    [Roles::ADM, Roles::OPE]],
            ['GET',    'ordenes-compra',          'ms-compras',       [Roles::ADM, Roles::OPE]],
            ['PATCH',  'ordenes-compra/7/estado', 'ms-compras',       [Roles::ADM]],
            ['GET',    'notificaciones',          'ms-notificaciones', Roles::TODOS],
            ['PUT',    'configuracion-alertas',   'ms-notificaciones', [Roles::ADM]],
            ['GET',    'reportes/kardex',         'ms-reportes',      [Roles::ADM, Roles::CON]],
            ['POST',   'importaciones',           'ms-reportes',      [Roles::ADM]],
            // Las dos filas con segmento literal en la posición de un identificador, y las «interno» descartadas.
            ['GET',    'lotes/sugerencia-salida', 'ms-inventario',    [Roles::ADM, Roles::OPE]],
            ['GET',    'saldos/bajo-umbral',      'ms-inventario',    [Roles::ADM]],
            ['GET',    'bodegas',                 'ms-inventario',    Roles::TODOS],
            ['GET',    'proveedores/3/productos', 'ms-proveedores',   [Roles::ADM, Roles::OPE]],
            ['GET',    'lotes',                   'ms-inventario',    [Roles::ADM, Roles::OPE]],
            ['PUT',    'preferencias/mia',        'ms-notificaciones', Roles::TODOS],
            ['POST',   'notificaciones/9/leida',  'ms-notificaciones', Roles::TODOS],
            ['GET',    'indicadores',             'ms-reportes',      [Roles::ADM, Roles::CON]],
        ];
    }

    public function test_cada_una_de_las_66_reglas_se_resuelve_a_si_misma(): void
    {
        foreach (config('gateway_routes') as $regla) {
            $ruta = preg_replace('/\{[^}]*\}/', '7', $regla['ruta']);
            $r = $this->mapa->resolve($regla['metodo'], $ruta);

            $etiqueta = "{$regla['metodo']} {$ruta}";
            $this->assertNotNull($r, $etiqueta);
            $this->assertSame($regla['servicio'], $r->servicio, $etiqueta);
            $this->assertSame($regla['roles'], $r->roles, $etiqueta);
            $this->assertSame($ruta, $r->rutaInterna, $etiqueta);
        }
    }

    public function test_ruta_interna_la_misma_ruta_sin_prefijo_y_con_barra_final_normalizada(): void
    {
        $sinBarra = $this->mapa->resolve('GET', 'productos/25');
        $conBarra = $this->mapa->resolve('GET', 'productos/25/');

        $this->assertNotNull($sinBarra);
        $this->assertNotNull($conBarra);
        $this->assertSame('productos/25', $sinBarra->rutaInterna);
        $this->assertSame('productos/25', $conBarra->rutaInterna);

        // Sin el prefijo /api y sin barra inicial: es la ruta que el servicio recibe tal cual.
        $this->assertStringStartsNotWith('/', $conBarra->rutaInterna);
        $this->assertStringStartsNotWith('api', $conBarra->rutaInterna);

        // Y la barra final no cambia a quién se reenvía ni con qué roles.
        $this->assertSame($sinBarra->servicio, $conBarra->servicio);
        $this->assertSame($sinBarra->roles, $conBarra->roles);

        // También en una colección y en una ruta de varios niveles.
        $this->assertSame('productos', $this->mapa->resolve('GET', 'productos/')->rutaInterna);
        $this->assertSame('proveedores/3/productos/9', $this->mapa->resolve('DELETE', 'proveedores/3/productos/9/')->rutaInterna);
    }

    /** @return array<string, array{string, string, string}> método, ruta cruda, rutaInterna esperada */
    public static function rutasConCodificacion(): array
    {
        return [
            'tal cual' => ['GET', 'productos/25', 'productos/25'],
            'dígitos codificados se decodifican' => ['GET', 'productos/%32%35', 'productos/25'],
            'una letra codificada se decodifica' => ['GET', 'productos/%41', 'productos/A'],
            'el segmento literal codificado se normaliza' => ['GET', '%70roductos/25', 'productos/25'],
            'espacio codificado' => ['GET', 'productos/a%20b', 'productos/a%20b'],
            'espacio sin codificar se codifica' => ['GET', 'productos/a b', 'productos/a%20b'],
            '? codificado sigue codificado (no abre una consulta)' => ['GET', 'productos/25%3Fx=1', 'productos/25%3Fx%3D1'],
            '# codificado sigue codificado (no corta la ruta)' => ['GET', 'productos/25%23x', 'productos/25%23x'],
            '? sin codificar se codifica' => ['GET', 'productos/25?x=1', 'productos/25%3Fx%3D1'],
            'el hexadecimal se normaliza a mayúsculas' => ['GET', 'productos/a%3fb', 'productos/a%3Fb'],
            'un % codificado' => ['GET', 'productos/100%25', 'productos/100%25'],
            'eñe en UTF-8 codificada' => ['GET', 'categorias/%C3%B1', 'categorias/%C3%B1'],
            'eñe sin codificar se codifica' => ['GET', 'categorias/ñ', 'categorias/%C3%B1'],
            'puntos dentro de un segmento' => ['GET', 'productos/1.5', 'productos/1.5'],
            'tres puntos no son un segmento de salto' => ['GET', 'productos/...', 'productos/...'],
            'literal con guion' => ['GET', 'lotes/sugerencia-salida/', 'lotes/sugerencia-salida'],
        ];
    }

    #[DataProvider('rutasConCodificacion')]
    public function test_ruta_interna_es_la_forma_canonica_de_lo_que_se_autorizo(string $metodo, string $cruda, string $esperada): void
    {
        $r = $this->mapa->resolve($metodo, $cruda);

        $this->assertNotNull($r, "{$metodo} {$cruda}");
        $this->assertSame($esperada, $r->rutaInterna);
        // Nada que pueda cambiar el sentido de la URL al concatenarla: ni consulta, ni fragmento, ni salto.
        $this->assertDoesNotMatchRegularExpression('/[?#\\\\]|(^|\/)\.\.?(\/|$)|\/\/|%2[eEfF]|%5[cC]/', $r->rutaInterna);
    }

    /** @return array<string, array{string, string}> */
    public static function noPublicadas(): array
    {
        return [
            'interna de otro servicio: lote de productos' => ['POST', 'internas/productos/lote'],
            'interna de otro servicio: saldos' => ['GET', 'internas/saldos'],
            'interna de otro servicio: notificaciones' => ['POST', 'internas/notificaciones'],
            'interna aunque sea la ruta de un servicio' => ['POST', 'internas/proveedores/lote'],
            'prefijo desconocido' => ['GET', 'desconocido'],
            'método no listado para una ruta publicada' => ['DELETE', 'productos/1'],
            'salto con ..' => ['GET', 'productos/../usuarios'],
            'salto con %2e%2e' => ['GET', 'productos/%2e%2e/usuarios'],
            'segmento vacío en medio' => ['GET', 'productos//25'],
            'barra codificada dentro de un segmento' => ['GET', 'productos/25%2fx'],
            'GET /health no se publica' => ['GET', 'health'],
            'GET /docs no se publica' => ['GET', 'docs'],
            'barra invertida' => ['GET', 'productos\\25'],
            'rutas propias del Gateway: auth' => ['POST', 'auth/login'],
            'rutas propias del Gateway: usuarios' => ['GET', 'usuarios'],
            'rutas propias del Gateway: roles' => ['GET', 'roles'],
            'un segmento de más' => ['GET', 'productos/25/extra'],
            'ruta publicada solo para DELETE, pedida con GET' => ['GET', 'proveedores/3/productos/9/'],
            'colección sin la operación de crear' => ['PUT', 'conteos'],
            'recurso sin la operación de escribir' => ['POST', 'conteos/3'],
            'mayúsculas en un segmento literal' => ['GET', 'Productos/25'],
            'mayúsculas en el prefijo' => ['GET', 'PRODUCTOS'],
            'vacía' => ['GET', ''],
            'solo una barra' => ['GET', '/'],
            'barra inicial (el prefijo se quita antes)' => ['GET', '/productos/25'],
            'dos barras finales' => ['GET', 'productos/25//'],
            'solo barras' => ['GET', '//'],
            'prefijo /api todavía puesto' => ['GET', 'api/productos/25'],
            'HEAD no se publica aunque exista el GET' => ['HEAD', 'productos/25'],
            'OPTIONS no se publica' => ['OPTIONS', 'productos'],
            'TRACE no se publica' => ['TRACE', 'productos'],
            'CONNECT no se publica' => ['CONNECT', 'productos'],
            'método vacío' => ['', 'productos'],
            'método con espacio' => ['GET ', 'productos'],
        ];
    }

    #[DataProvider('noPublicadas')]
    public function test_lo_no_publicado_devuelve_null(string $metodo, string $ruta): void
    {   // [RF-4]
        $this->assertNull($this->mapa->resolve($metodo, $ruta));
    }

    /**
     * Cada uno de estos valores, puesto donde va un identificador de una regla publicada (donde sin la
     * validación SÍ casaría con `{id}`), debe dejar la ruta sin resolver.
     *
     * @return array<string, array{string}>
     */
    public static function segmentosHostiles(): array
    {
        return [
            'punto' => ['.'],
            'dos puntos' => ['..'],
            'punto codificado' => ['%2e'],
            'dos puntos codificados' => ['%2e%2e'],
            'dos puntos codificados en mayúsculas' => ['%2E%2E'],
            'punto y punto codificado' => ['.%2e'],
            'punto codificado y punto' => ['%2e.'],
            'barra codificada al final' => ['25%2f'],
            'barra codificada en mayúsculas' => ['25%2F'],
            'barra codificada al inicio' => ['%2f25'],
            'barra codificada sola' => ['%2f'],
            'barra invertida codificada' => ['25%5c'],
            'barra invertida codificada en mayúsculas' => ['25%5C'],
            'barra invertida' => ['25\\'],
            'barra invertida en medio' => ['2\\5'],
            'NUL codificado' => ['25%00'],
            'NUL sin codificar' => ["25\0"],
            'salto de línea codificado' => ['25%0a'],
            'retorno y salto codificados' => ['25%0d%0a'],
            'salto de línea sin codificar' => ["25\n"],
            'tabulador sin codificar' => ["25\t"],
            'DEL codificado' => ['25%7f'],
            'DEL sin codificar' => ["25\x7f"],
            'control C1 en UTF-8 (NEL)' => ['25%c2%85'],
            'doble codificación del punto' => ['%252e%252e'],
            'doble codificación de la barra' => ['25%252f'],
            'doble codificación de la barra invertida' => ['25%255c'],
            'doble codificación del propio %' => ['%2525'],
            'escape mal formado: letras no hexadecimales' => ['25%zz'],
            'escape mal formado: un solo dígito' => ['25%2'],
            'escape mal formado: % final' => ['25%'],
            'escape mal formado: % solo' => ['%'],
            'UTF-8 inválido' => ['%ff'],
            'UTF-8 sobrelargo del punto' => ['%c0%ae%c0%ae'],
            'UTF-8 truncado' => ['25%c3'],
        ];
    }

    /** Plantillas publicadas con un único %s: la posición de un comodín `{id}`. Método, plantilla. */
    private const PLANTILLAS_CON_COMODIN = [
        ['GET', 'productos/%s'],
        ['GET', 'proveedores/%s/productos'],
        ['DELETE', 'proveedores/3/productos/%s'],
    ];

    #[DataProvider('segmentosHostiles')]
    public function test_un_segmento_hostil_en_la_posicion_de_un_identificador_no_se_resuelve(string $hostil): void
    {
        foreach (self::PLANTILLAS_CON_COMODIN as [$metodo, $plantilla]) {
            // Control: con un identificador normal la plantilla sí está publicada.
            $this->assertNotNull($this->mapa->resolve($metodo, sprintf($plantilla, '25')), "control: {$plantilla}");

            $this->assertNull($this->mapa->resolve($metodo, sprintf($plantilla, $hostil)), sprintf($plantilla, $hostil));
            // Tampoco como segmento final de una ruta con barra final tolerada.
            $this->assertNull($this->mapa->resolve($metodo, sprintf($plantilla, $hostil).'/'), sprintf($plantilla, $hostil).'/');
        }
    }

    public function test_un_segmento_hostil_en_la_posicion_de_un_literal_tampoco_se_resuelve(): void
    {
        foreach (['.', '..', '%2e%2e', 'productos%2f..', 'productos%00', "productos\0", 'productos\\x', '%70roductos%2f', '%2570roductos'] as $hostil) {
            $this->assertNull($this->mapa->resolve('GET', $hostil.'/25'), $hostil);
        }
    }

    public function test_solo_se_quita_una_barra_final(): void
    {
        $this->assertNotNull($this->mapa->resolve('GET', 'productos/25/'));
        $this->assertNull($this->mapa->resolve('GET', 'productos/25//'));
        $this->assertNull($this->mapa->resolve('GET', 'productos//'));
        $this->assertNull($this->mapa->resolve('GET', 'productos/25%2f'));
    }

    public function test_el_metodo_se_compara_sin_distinguir_mayusculas(): void
    {
        foreach (['get', 'Get', 'GET', 'gEt'] as $metodo) {
            $r = $this->mapa->resolve($metodo, 'productos/25');
            $this->assertNotNull($r, $metodo);
            $this->assertSame('ms-catalogo', $r->servicio);
        }

        $this->assertNotNull($this->mapa->resolve('patch', 'ordenes-compra/7/estado'));
        $this->assertNull($this->mapa->resolve('head', 'productos/25'));
    }

    public function test_un_comodin_casa_con_un_unico_segmento_no_vacio(): void
    {
        $mapa = new RouteMap([self::regla('GET', 'a/{id}')]);

        $this->assertNotNull($mapa->resolve('GET', 'a/1'));
        $this->assertNotNull($mapa->resolve('GET', 'a/uno-dos_tres.4'));
        $this->assertNull($mapa->resolve('GET', 'a'));
        $this->assertNull($mapa->resolve('GET', 'a/'));
        $this->assertNull($mapa->resolve('GET', 'a//'));
        $this->assertNull($mapa->resolve('GET', 'a/1/2'));
        $this->assertNull($mapa->resolve('GET', 'b/1'));
    }

    /** @return array<string, array{list<array{metodo: string, ruta: string, servicio: string, roles: list<string>}>}> */
    public static function ordenesDeDeclaracion(): array
    {
        $comodin = self::regla('GET', 'a/{id}', [Roles::ADM], 'ms-catalogo');
        $literal = self::regla('GET', 'a/fijo', Roles::TODOS, 'ms-inventario');

        return [
            'primero el comodín' => [[$comodin, $literal]],
            'primero el literal' => [[$literal, $comodin]],
        ];
    }

    /**
     * @param  list<array{metodo: string, ruta: string, servicio: string, roles: list<string>}>  $reglas
     */
    #[DataProvider('ordenesDeDeclaracion')]
    public function test_un_segmento_literal_tiene_prioridad_sobre_un_comodin_sea_cual_sea_el_orden_de_declaracion(array $reglas): void
    {
        $mapa = new RouteMap($reglas);

        $fijo = $mapa->resolve('GET', 'a/fijo');
        $this->assertNotNull($fijo);
        $this->assertSame('ms-inventario', $fijo->servicio);
        $this->assertSame(Roles::TODOS, $fijo->roles);

        $otro = $mapa->resolve('GET', 'a/otro');
        $this->assertNotNull($otro);
        $this->assertSame('ms-catalogo', $otro->servicio);
        $this->assertSame([Roles::ADM], $otro->roles);
    }

    public function test_si_dos_reglas_casan_gana_la_que_tiene_el_literal_mas_a_la_izquierda(): void
    {
        foreach ([[0, 1], [1, 0]] as $orden) {
            $reglas = [
                self::regla('GET', 'a/{x}/c', [Roles::ADM], 'ms-catalogo'),
                self::regla('GET', 'a/b/{y}', [Roles::CON], 'ms-reportes'),
            ];
            $mapa = new RouteMap([$reglas[$orden[0]], $reglas[$orden[1]]]);

            $this->assertSame('ms-reportes', $mapa->resolve('GET', 'a/b/c')->servicio);
            $this->assertSame('ms-catalogo', $mapa->resolve('GET', 'a/z/c')->servicio);
            $this->assertSame('ms-reportes', $mapa->resolve('GET', 'a/b/z')->servicio);
        }
    }

    public function test_la_prioridad_del_literal_es_por_metodo_no_hereda_reglas_de_otro_metodo(): void
    {
        $mapa = new RouteMap([
            self::regla('GET', 'a/{id}', [Roles::ADM], 'ms-catalogo'),
            self::regla('POST', 'a/fijo', Roles::TODOS, 'ms-inventario'),
        ]);

        // Para GET solo existe la regla con comodín; la literal es de POST.
        $this->assertSame('ms-catalogo', $mapa->resolve('GET', 'a/fijo')->servicio);
        $this->assertSame('ms-inventario', $mapa->resolve('POST', 'a/fijo')->servicio);
        $this->assertNull($mapa->resolve('POST', 'a/otro'));
    }

    public function test_la_regla_resuelta_es_inmutable(): void
    {
        $r = $this->mapa->resolve('GET', 'productos/25');
        $this->assertNotNull($r);

        $this->expectException(Error::class);
        $r->servicio = 'ms-reportes';
    }

    public function test_los_roles_de_una_regla_resuelta_no_se_pueden_alterar_desde_fuera(): void
    {
        $r = $this->mapa->resolve('POST', 'productos');
        $this->assertNotNull($r);

        try {
            $r->roles[] = Roles::VEN;
            $this->fail('La propiedad roles debía ser de solo lectura.');
        } catch (Error) {
            $this->assertSame([Roles::ADM], $this->mapa->resolve('POST', 'productos')->roles);
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Una tabla de seguridad mal escrita no arranca
    // ---------------------------------------------------------------------------------------------------------

    /** @return array<string, array{array<mixed>}> */
    public static function reglasInvalidas(): array
    {
        $buena = self::regla('GET', 'a/{id}');

        return [
            'una regla que no es un arreglo' => [['GET a/{id}']],
            'sin método' => [[['ruta' => 'a', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]]]],
            'método fuera de GET, POST, PUT, PATCH y DELETE: HEAD' => [[self::regla('HEAD', 'a')]],
            'método fuera de lista: OPTIONS' => [[self::regla('OPTIONS', 'a')]],
            'método en minúsculas' => [[self::regla('get', 'a')]],
            'sin ruta' => [[['metodo' => 'GET', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]]]],
            'ruta vacía' => [[self::regla('GET', '')]],
            'ruta con barra inicial' => [[self::regla('GET', '/a')]],
            'ruta con barra final' => [[self::regla('GET', 'a/')]],
            'ruta con segmento vacío' => [[self::regla('GET', 'a//b')]],
            'ruta con segmento .' => [[self::regla('GET', 'a/./b')]],
            'ruta con segmento ..' => [[self::regla('GET', 'a/../b')]],
            'ruta interna' => [[self::regla('POST', 'internas/productos/lote')]],
            'ruta interna con un solo segmento' => [[self::regla('GET', 'internas')]],
            'primer segmento comodín (casaría también con internas/...)' => [[self::regla('POST', '{servicio}/lote')]],
            'solo un comodín' => [[self::regla('GET', '{id}')]],
            'comodín sin cerrar' => [[self::regla('GET', 'a/{id')]],
            'comodín mezclado con texto' => [[self::regla('GET', 'a/x{id}')]],
            'comodín con nombre no válido' => [[self::regla('GET', 'a/{Id-1}')]],
            'literal con un % (nunca casaría)' => [[self::regla('GET', 'a/b%20c')]],
            'literal con una barra invertida' => [[self::regla('GET', 'a\\b')]],
            'sin servicio' => [[['metodo' => 'GET', 'ruta' => 'a', 'roles' => [Roles::ADM]]]],
            'servicio vacío' => [[self::regla('GET', 'a', [Roles::ADM], '')]],
            'sin roles' => [[['metodo' => 'GET', 'ruta' => 'a', 'servicio' => 'ms-catalogo']]],
            'lista de roles vacía (nadie podría usarla)' => [[self::regla('GET', 'a', [])]],
            'rol desconocido' => [[self::regla('GET', 'a', ['ADMIN'])]],
            'rol con otra capitalización' => [[self::regla('GET', 'a', ['administrador'])]],
            'roles que no son una lista' => [[self::regla('GET', 'a', [1 => Roles::ADM])]],
            'roles que no son texto' => [[self::regla('GET', 'a', [1])]],
            'dos reglas con el mismo método y ruta' => [[$buena, $buena]],
            'dos reglas con la misma forma y distinto nombre de comodín' => [[$buena, self::regla('GET', 'a/{otro}')]],
        ];
    }

    /**
     * @param  array<mixed>  $reglas
     */
    #[DataProvider('reglasInvalidas')]
    public function test_una_tabla_mal_formada_se_rechaza_al_construir_el_mapa(array $reglas): void
    {
        $this->expectException(InvalidArgumentException::class);

        new RouteMap($reglas);
    }

    public function test_el_mismo_texto_con_distinto_metodo_no_es_un_duplicado(): void
    {
        $mapa = new RouteMap([
            self::regla('GET', 'a/{id}', [Roles::ADM]),
            self::regla('PUT', 'a/{id}', [Roles::CON]),
            self::regla('DELETE', 'a/{id}', [Roles::OPE]),
        ]);

        $this->assertSame([Roles::ADM], $mapa->resolve('GET', 'a/1')->roles);
        $this->assertSame([Roles::CON], $mapa->resolve('PUT', 'a/1')->roles);
        $this->assertSame([Roles::OPE], $mapa->resolve('DELETE', 'a/1')->roles);
    }

    public function test_un_mapa_vacio_no_publica_nada(): void
    {
        $this->assertNull((new RouteMap([]))->resolve('GET', 'productos/25'));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Enlace en el contenedor
    // ---------------------------------------------------------------------------------------------------------

    public function test_el_contenedor_entrega_un_unico_mapa_y_resolver_no_toca_la_base_de_datos(): void
    {
        DB::enableQueryLog();

        $this->assertSame($this->mapa, $this->app->make(RouteMap::class));
        $this->assertNotNull($this->mapa->resolve('GET', 'productos/25'));
        $this->assertNull($this->mapa->resolve('GET', 'internas/saldos'));

        $this->assertSame([], DB::getQueryLog());
    }

    public function test_el_mapa_del_contenedor_sale_de_config_gateway_routes(): void
    {
        config(['gateway_routes' => [self::regla('GET', 'solo/{id}', [Roles::CON], 'ms-reportes')]]);
        $this->app->forgetInstance(RouteMap::class);

        $mapa = $this->app->make(RouteMap::class);

        $this->assertNotSame($this->mapa, $mapa);
        $r = $mapa->resolve('GET', 'solo/1');
        $this->assertNotNull($r);
        $this->assertSame('ms-reportes', $r->servicio);
        $this->assertSame([Roles::CON], $r->roles);
        // Lo que ya no está en la configuración no se publica.
        $this->assertNull($mapa->resolve('GET', 'productos/25'));
    }
}
