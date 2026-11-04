<?php

namespace Tests\Feature;

use App\Services\Proxy\ProxyService;
use App\Services\Routing\RouteRule;
use App\Support\Roles;
use Closure;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request as PeticionEnviada;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Reenvío de las rutas públicas `/api/...` a los seis microservicios (RNF09, RNF18): mapa de rutas, permisos por
 * rol, cabeceras de identidad, cuerpo y consulta en bruto, respuestas tal cual y servicio caído. Ninguna prueba
 * toca la red: todo pasa por `Http::fake()` con `preventStrayRequests()`.
 */
class ProxyTest extends TestCase
{
    use ApiHelpers;

    /** UUID v4 en minúsculas, como lo genera AssignRequestId. */
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';

    /** Cabeceras que puede llevar una petición hacia un servicio: las del Gateway y las que pone el cliente HTTP. */
    private const CABECERAS_ADMITIDAS_HACIA_EL_SERVICIO = [
        'accept', 'content-type', 'idempotency-key',
        'x-user-id', 'x-user-rol', 'x-user-bodega', 'x-request-id',
        'host', 'user-agent', 'content-length',
    ];

    /**
     * Lo que responde el servicio falso en esta prueba; por defecto, 200 con un JSON.
     *
     * @var Closure(PeticionEnviada, array<string, mixed>): mixed
     */
    private Closure $servicio;

    protected function setUp(): void
    {
        parent::setUp();

        // Un único stub que delega en $this->servicio: así cada prueba cambia la respuesta sin que un stub
        // registrado antes le gane al suyo.
        $this->servicio = fn () => Http::response(['ok' => true], 200);
        Http::preventStrayRequests();
        Http::fake(fn (PeticionEnviada $req, array $opciones) => ($this->servicio)($req, $opciones));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Destino, consulta y cabeceras de identidad
    // ---------------------------------------------------------------------------------------------------------

    public function test_reenvia_sin_prefijo_api_con_query_y_cabeceras_de_identidad(): void
    {
        $this->servicio = fn () => Http::response(['id_producto' => 25], 200);
        $u = $this->usuario(Roles::VEN);

        $r = $this->conSesion($u)->getJson('/api/productos/25?x=1&x=2');

        $r->assertOk()->assertJson(['id_producto' => 25]);
        $this->assertMatchesRegularExpression(self::UUID, (string) $r->headers->get('X-Request-Id'));
        Http::assertSentCount(1);
        Http::assertSent(fn (PeticionEnviada $req) => $req->url() === 'http://ms-catalogo:8000/productos/25?x=1&x=2'
            && $req->method() === 'GET'
            && $req->header('X-User-Id') === [(string) $u->id_usuario]
            && $req->header('X-User-Rol') === [Roles::VEN]
            && $req->header('X-Request-Id') === [$r->headers->get('X-Request-Id')]
            && ! $req->hasHeader('X-User-Bodega')
            && ! $req->hasHeader('Authorization'));
    }

    public function test_cada_servicio_recibe_la_peticion_en_su_url_base(): void
    {
        $casos = [
            ['GET', '/api/productos', 'http://ms-catalogo:8000/productos'],
            ['GET', '/api/proveedores', 'http://ms-proveedores:8000/proveedores'],
            ['GET', '/api/movimientos', 'http://ms-inventario:3000/movimientos'],
            ['GET', '/api/reportes/kardex', 'http://ms-reportes:5000/reportes/kardex'],
            ['GET', '/api/importaciones/7', 'http://ms-reportes:5000/importaciones/7'],
        ];
        $this->conSesion($this->usuario(Roles::ADM));

        foreach ($casos as [$metodo, $ruta, $destino]) {
            $this->json($metodo, $ruta)->assertOk();
            Http::assertSent(fn (PeticionEnviada $req) => $req->url() === $destino && $req->method() === $metodo);
        }
        Http::assertSentCount(count($casos));
    }

    public function test_la_consulta_cruda_llega_sin_reordenar_ni_normalizar(): void
    {
        $this->conSesion($this->usuario(Roles::VEN))->getJson('/api/productos?b=2&a=1&a=3&c=%20x+y&vacio')->assertOk();

        // getQueryString() la habría dejado como `a=1&a=3&b=2&c=%20x%20y&vacio=`.
        Http::assertSent(fn (PeticionEnviada $req) => $req->url() === 'http://ms-catalogo:8000/productos?b=2&a=1&a=3&c=%20x+y&vacio');
    }

    public function test_sin_consulta_la_url_no_lleva_signo_de_interrogacion(): void
    {
        $this->conSesion($this->usuario(Roles::VEN))->getJson('/api/productos/25/')->assertOk();

        Http::assertSent(fn (PeticionEnviada $req) => $req->url() === 'http://ms-catalogo:8000/productos/25');
    }

    public function test_el_operador_de_bodega_envia_su_bodega(): void
    {
        $u = $this->usuario(Roles::OPE, ['id_bodega' => 3]);

        $this->conSesion($u)->getJson('/api/movimientos')->assertOk();

        Http::assertSent(fn (PeticionEnviada $req) => $req->url() === 'http://ms-inventario:3000/movimientos'
            && $req->header('X-User-Id') === [(string) $u->id_usuario]
            && $req->header('X-User-Rol') === [Roles::OPE]
            && $req->header('X-User-Bodega') === ['3']);
    }

    public function test_los_demas_roles_no_envian_bodega_aunque_la_tengan_en_la_base(): void
    {
        foreach ([Roles::ADM, Roles::CON] as $rol) {
            $this->conSesion($this->usuario($rol, ['id_bodega' => 7]))->getJson('/api/movimientos')->assertOk();
        }

        Http::assertSentCount(2);
        Http::assertNotSent(fn (PeticionEnviada $req) => $req->hasHeader('X-User-Bodega'));
    }

    public function test_un_operador_sin_bodega_no_se_reenvia(): void
    {
        // D9 lo impide al crear o editar; si la base quedara así, el servicio no puede recibir un operador sin
        // bodega (podría tomarlo como «todas las bodegas»).
        $u = $this->usuario(Roles::OPE, ['id_bodega' => null]);

        $this->conSesion($u)->getJson('/api/movimientos')->assertStatus(500)->assertJsonPath('error.codigo', 'ERROR_INTERNO');

        Http::assertNothingSent();
    }

    public function test_el_rol_y_la_bodega_salen_de_la_base_y_no_del_token(): void
    {
        $u = $this->usuario(Roles::OPE, ['id_bodega' => 3]);
        $this->conSesion($u);

        // Después de emitir el token, el administrador le cambia el rol: el token sigue diciendo OPERADOR_BODEGA.
        $u->forceFill(['id_rol' => $this->usuario(Roles::CON)->id_rol, 'id_bodega' => null])->save();

        $this->getJson('/api/movimientos')->assertOk();
        $this->postJson('/api/movimientos', ['tipo' => 'ENTRADA'])->assertStatus(403);

        Http::assertSentCount(1);
        Http::assertSent(fn (PeticionEnviada $req) => $req->header('X-User-Rol') === [Roles::CON] && ! $req->hasHeader('X-User-Bodega'));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Suplantación y lista permitida de cabeceras (Review Focus 1)
    // ---------------------------------------------------------------------------------------------------------

    public function test_descarta_las_cabeceras_de_identidad_del_cliente(): void   // [RF-1]
    {
        $u = $this->usuario(Roles::VEN);

        $r = $this->conSesion($u)->withHeaders([
            'X-User-Id' => '999',
            'X-User-Rol' => Roles::ADM,
            'X-User-Bodega' => '9',
            'X-Request-Id' => 'evil',
        ])->getJson('/api/productos');

        $r->assertOk();
        $idPeticion = (string) $r->headers->get('X-Request-Id');
        $this->assertMatchesRegularExpression(self::UUID, $idPeticion);
        Http::assertSentCount(1);
        Http::assertSent(fn (PeticionEnviada $req) => $req->header('X-User-Id') === [(string) $u->id_usuario]
            && $req->header('X-User-Rol') === [Roles::VEN]
            && ! $req->hasHeader('X-User-Bodega')
            && $req->header('X-Request-Id') === [$idPeticion]);
    }

    public function test_el_operador_no_puede_cambiar_su_bodega_con_la_cabecera(): void
    {
        $this->conSesion($this->usuario(Roles::OPE, ['id_bodega' => 3]))
            ->withHeaders(['X-User-Bodega' => '9', 'x-user-bodega' => '8'])
            ->getJson('/api/movimientos')->assertOk();

        Http::assertSent(fn (PeticionEnviada $req) => $req->header('X-User-Bodega') === ['3']);
    }

    public function test_solo_reenvia_la_lista_permitida_de_cabeceras_del_cliente(): void
    {
        $this->conSesion($this->usuario(Roles::VEN))->withHeaders([
            'Cookie' => 'sesion=abc',
            'X-Forwarded-For' => '6.6.6.6',
            'X-Forwarded-Host' => 'evil.test',
            'Forwarded' => 'for=6.6.6.6',
            'Via' => '1.1 evil',
            'X-HTTP-Method-Override' => 'DELETE',
            'X-Otra' => 'valor',
            'Accept' => 'text/csv',
        ])->get('/api/productos')->assertOk();

        Http::assertSent(function (PeticionEnviada $req): bool {
            $nombres = array_map('strtolower', array_keys($req->headers()));

            return array_diff($nombres, self::CABECERAS_ADMITIDAS_HACIA_EL_SERVICIO) === []
                && $req->header('Host') === ['ms-catalogo:8000']
                && $req->header('Accept') === ['text/csv']
                && $req->method() === 'GET';
        });
    }

    public function test_sin_accept_del_cliente_envia_application_json(): void
    {
        $this->conSesion($this->usuario(Roles::VEN))->call('GET', '/api/productos', server: $this->transformHeadersToServerVars([]) + ['HTTP_ACCEPT' => ''])->assertOk();

        Http::assertSent(fn (PeticionEnviada $req) => $req->header('Accept') === ['application/json']);
    }

    /**
     * El servicio aplica la lista permitida por sí mismo, sin contar con que AuthenticateJwt o AssignRequestId
     * ya hayan limpiado la petición: aquí la petición le llega con todas las cabeceras del cliente.
     */
    public function test_el_servicio_de_reenvio_ignora_las_cabeceras_del_cliente_por_si_mismo(): void
    {
        $u = $this->usuario(Roles::VEN);
        $peticion = Request::create('http://gateway.test/api/productos?x=1&x=2', 'GET', server: [
            'HTTP_AUTHORIZATION' => 'Bearer token-del-cliente',
            'HTTP_COOKIE' => 'sesion=abc',
            'HTTP_X_USER_ID' => '999',
            'HTTP_X_USER_ROL' => Roles::ADM,
            'HTTP_X_USER_BODEGA' => '9',
            'HTTP_X_REQUEST_ID' => 'evil',
            'HTTP_X_FORWARDED_FOR' => '6.6.6.6',
            'HTTP_TRANSFER_ENCODING' => 'chunked',
            'HTTP_CONNECTION' => 'keep-alive, X-User-Id',
            'HTTP_IDEMPOTENCY_KEY' => 'k1',
        ]);
        $peticion->attributes->set('request_id', '0b9f5b8e-2f1a-4c3d-9e8f-7a6b5c4d3e2f');

        app(ProxyService::class)->reenviar($peticion, $u, new RouteRule('ms-catalogo', [Roles::VEN], 'productos'));

        Http::assertSent(function (PeticionEnviada $req) use ($u): bool {
            $nombres = array_map('strtolower', array_keys($req->headers()));

            return array_diff($nombres, self::CABECERAS_ADMITIDAS_HACIA_EL_SERVICIO) === []
                && $req->url() === 'http://ms-catalogo:8000/productos?x=1&x=2'
                && $req->header('Host') === ['ms-catalogo:8000']
                && $req->header('X-User-Id') === [(string) $u->id_usuario]
                && $req->header('X-User-Rol') === [Roles::VEN]
                && ! $req->hasHeader('X-User-Bodega')
                && $req->header('X-Request-Id') === ['0b9f5b8e-2f1a-4c3d-9e8f-7a6b5c4d3e2f']
                && $req->header('Idempotency-Key') === ['k1'];
        });
    }

    // ---------------------------------------------------------------------------------------------------------
    // Cuerpo (D11)
    // ---------------------------------------------------------------------------------------------------------

    public function test_reenvia_el_cuerpo_en_bruto_y_la_idempotency_key(): void
    {
        // Espacios, orden de claves, un decimal con ceros, un número enorme y escapes Unicode: todo debe llegar
        // byte a byte, sin decodificar y volver a codificar.
        $crudo = "{ \"tipo\":\"ENTRADA\",  \"cantidad\": 10.50, \"id\": 12345678901234567890, \"nota\": \"\\u00f1 \" }\n";

        $this->conSesion($this->usuario(Roles::OPE, ['id_bodega' => 3]))->call(
            'POST', '/api/movimientos',
            server: $this->transformHeadersToServerVars([
                'Content-Type' => 'application/json; charset=utf-8',
                'Accept' => 'application/json',
                'Idempotency-Key' => 'k1',
            ]),
            content: $crudo,
        )->assertOk();

        Http::assertSentCount(1);
        Http::assertSent(fn (PeticionEnviada $req) => $req->url() === 'http://ms-inventario:3000/movimientos'
            && $req->method() === 'POST'
            && $req->body() === $crudo
            && $req->header('Content-Type') === ['application/json; charset=utf-8']
            && $req->header('Idempotency-Key') === ['k1']);
    }

    public function test_reenvia_un_formulario_codificado_en_bruto(): void
    {
        $crudo = 'nombre=%20Caf%C3%A9%20&vacio=&x=1&x=2';

        $this->conSesion($this->usuario(Roles::ADM))->call(
            'POST', '/api/productos',
            ['nombre' => 'ignorado'],
            server: $this->transformHeadersToServerVars(['Content-Type' => 'application/x-www-form-urlencoded']),
            content: $crudo,
        )->assertOk();

        Http::assertSent(fn (PeticionEnviada $req) => $req->body() === $crudo
            && $req->header('Content-Type') === ['application/x-www-form-urlencoded']);
    }

    public function test_sin_cuerpo_ni_content_type_no_inventa_ninguno(): void
    {
        // Symfony pone application/x-www-form-urlencoded por defecto a un DELETE de prueba: se quita.
        $this->conSesion($this->usuario(Roles::ADM))->call('DELETE', '/api/proveedores/4/productos/9', server: $this->transformHeadersToServerVars([]) + ['CONTENT_TYPE' => ''])->assertOk();

        Http::assertSent(fn (PeticionEnviada $req) => $req->method() === 'DELETE'
            && $req->url() === 'http://ms-proveedores:8000/proveedores/4/productos/9'
            && $req->body() === ''
            && ! $req->hasHeader('Content-Type'));
    }

    public function test_reenvia_multipart_reconstruyendo_las_partes(): void
    {
        // Bytes que no son texto: NUL, 0xFF, un CRLF y algo que parece un separador de partes.
        $bytes = "codigo;nombre\r\nP-1;Caf\xC3\xA9\r\n\x00\xFF\xFE--frontera\r\n";
        $archivo = UploadedFile::fake()->createWithContent('productos.csv', $bytes);

        $this->conSesion($this->usuario(Roles::ADM))->post('/api/importaciones', [
            'tipo' => ' productos ',
            'vacio' => '',
            'meta' => ['origen' => 'web', 'columnas' => ['codigo', 'nombre']],
            'archivo' => $archivo,
        ], [
            'Content-Type' => 'multipart/form-data; boundary=FRONTERA-ORIGINAL',
            'Accept' => 'application/json',
        ])->assertOk();

        Http::assertSentCount(1);
        Http::assertSent(function (PeticionEnviada $req) use ($bytes): bool {
            $tipo = $req->header('Content-Type')[0] ?? '';
            if ($req->url() !== 'http://ms-reportes:5000/importaciones' || $req->method() !== 'POST'
                || preg_match('/^multipart\/form-data; boundary=(\S+)$/', $tipo, $m) !== 1 || str_contains($tipo, 'FRONTERA-ORIGINAL')) {
                return false;
            }

            $partes = $this->partesMultipart($req->body(), $m[1]);

            // Los campos llegan sin recortar ni convertir a null (TrimStrings y ConvertEmptyStringsToNull no los tocan).
            return $partes === [
                'tipo' => ['filename' => null, 'tipo' => null, 'contenido' => ' productos '],
                'vacio' => ['filename' => null, 'tipo' => null, 'contenido' => ''],
                'meta[origen]' => ['filename' => null, 'tipo' => null, 'contenido' => 'web'],
                'meta[columnas][0]' => ['filename' => null, 'tipo' => null, 'contenido' => 'codigo'],
                'meta[columnas][1]' => ['filename' => null, 'tipo' => null, 'contenido' => 'nombre'],
                'archivo' => ['filename' => 'productos.csv', 'tipo' => 'text/csv', 'contenido' => $bytes],
            ];
        });
    }

    public function test_un_archivo_que_no_se_recibio_bien_es_422_y_no_se_reenvia(): void
    {
        $roto = new UploadedFile(__FILE__, 'grande.csv', 'text/csv', UPLOAD_ERR_INI_SIZE, true);

        $this->conSesion($this->usuario(Roles::ADM))->post('/api/importaciones', ['archivo' => $roto], [
            'Content-Type' => 'multipart/form-data; boundary=x',
            'Accept' => 'application/json',
        ])->assertStatus(422)->assertJsonPath('error.codigo', 'DATOS_NO_VALIDOS')->assertJsonPath('error.detalles.0.campo', 'archivo');

        Http::assertNothingSent();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Permisos por rol
    // ---------------------------------------------------------------------------------------------------------

    public function test_un_rol_sin_permiso_recibe_403_y_el_servicio_no_se_llama(): void
    {
        $this->conSesion($this->usuario(Roles::VEN))
            ->postJson('/api/movimientos', ['tipo' => 'ENTRADA'])
            ->assertStatus(403)
            ->assertJsonPath('error.codigo', 'SIN_PERMISO');

        Http::assertNothingSent();
    }

    /**
     * @return array<string, array{string, string, string}>
     */
    public static function rutasSinPermiso(): array
    {
        return [
            'vendedor crea producto' => [Roles::VEN, 'POST', '/api/productos'],
            'contador crea movimiento' => [Roles::CON, 'POST', '/api/movimientos'],
            'operador importa' => [Roles::OPE, 'POST', '/api/importaciones'],
            'vendedor ve kardex' => [Roles::VEN, 'GET', '/api/reportes/kardex'],
            'operador borra asociación' => [Roles::OPE, 'DELETE', '/api/proveedores/1/productos/2'],
        ];
    }

    #[DataProvider('rutasSinPermiso')]
    public function test_cada_rol_solo_alcanza_lo_que_su_mapa_permite(string $rol, string $metodo, string $ruta): void
    {
        $this->conSesion($this->usuario($rol))->json($metodo, $ruta)->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');

        Http::assertNothingSent();
    }

    public function test_el_metodo_suplantado_se_autoriza_con_el_mismo_metodo_que_se_envia(): void
    {
        // Laravel interpreta `_method` y X-HTTP-Method-Override. El Gateway autoriza y reenvía con el mismo método,
        // así que un POST disfrazado de DELETE no puede llegar al servicio como POST con `_method=DELETE` (que un
        // servicio Laravel volvería a interpretar como DELETE sin que el Gateway lo haya autorizado).
        $this->conSesion($this->usuario(Roles::OPE, ['id_bodega' => 3]));

        $this->postJson('/api/movimientos?_method=DELETE', [])->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
        $this->postJson('/api/movimientos', ['_method' => 'DELETE'])->assertStatus(404);
        $this->postJson('/api/movimientos', [], ['X-HTTP-Method-Override' => 'DELETE'])->assertStatus(404);

        Http::assertNothingSent();
    }

    public function test_con_cambio_de_contrasena_pendiente_no_se_reenvia(): void
    {
        $this->conSesion($this->usuario(Roles::ADM, ['debe_cambiar_contrasena' => true]))
            ->getJson('/api/productos')
            ->assertStatus(403)
            ->assertJsonPath('error.codigo', 'CAMBIO_CONTRASENA_REQUERIDO');

        Http::assertNothingSent();
    }

    public function test_el_limite_de_peticiones_aplica_a_las_rutas_reenviadas(): void
    {
        config(['gateway.rate_limit.por_usuario' => 2]);
        $this->conSesion($this->usuario(Roles::VEN));

        $this->getJson('/api/productos')->assertOk();
        $this->getJson('/api/productos/1')->assertOk();
        $this->getJson('/api/productos')->assertStatus(429)->assertJsonPath('error.codigo', 'DEMASIADAS_PETICIONES')->assertHeader('Retry-After');

        Http::assertSentCount(2);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Respuesta del servicio
    // ---------------------------------------------------------------------------------------------------------

    /**
     * @return array<string, array{int, string}>
     */
    public static function erroresDelServicio(): array
    {
        return [
            '404' => [404, '{"error":{"codigo":"NO_EXISTE","mensaje":"El producto no existe.","detalles":[]}}'],
            '409' => [409, '{"error":{"codigo":"STOCK_INSUFICIENTE","mensaje":"No hay stock.","detalles":[{"disponible":2}]}}'],
            '422' => [422, '{"error":{"codigo":"DATOS_NO_VALIDOS","mensaje":"Datos.","detalles":[{"campo":"sku","mensaje":"Obligatorio."}]}}'],
            '500' => [500, '{"error":{"codigo":"ERROR_INTERNO","mensaje":"Falla propia del servicio.","detalles":[]}}'],
            '502 sin JSON' => [502, 'Bad Gateway'],
        ];
    }

    #[DataProvider('erroresDelServicio')]
    public function test_devuelve_tal_cual_los_4xx_y_5xx_del_servicio(int $estado, string $cuerpo): void
    {
        $this->servicio = fn () => Http::response($cuerpo, $estado, ['Content-Type' => 'application/json']);

        $r = $this->conSesion($this->usuario(Roles::ADM))->postJson('/api/movimientos', ['tipo' => 'SALIDA']);

        $r->assertStatus($estado)->assertHeader('Content-Type', 'application/json');
        $this->assertSame($cuerpo, $r->getContent());
        Http::assertSentCount(1);
    }

    public function test_devuelve_archivos_con_su_content_type_y_content_disposition(): void
    {
        $csv = "fecha;tipo;cantidad\r\n2026-11-01;ENTRADA;10\r\n\xEF\xBB\xBF\x00";
        $this->servicio = fn () => Http::response($csv, 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="kardex.csv"',
            'Set-Cookie' => 'sesion=del-servicio',
            'X-Powered-By' => 'Express',
            'Connection' => 'close',
        ]);

        $r = $this->conSesion($this->usuario(Roles::CON))->get('/api/reportes/kardex?formato=csv');

        $r->assertOk()
            ->assertHeader('Content-Type', 'text/csv; charset=utf-8')
            ->assertHeader('Content-Disposition', 'attachment; filename="kardex.csv"')
            ->assertHeaderMissing('Set-Cookie')
            ->assertHeaderMissing('X-Powered-By');
        $this->assertSame($csv, $r->getContent());
        $this->assertNotSame('close', $r->headers->get('Connection'));
        $this->assertMatchesRegularExpression(self::UUID, (string) $r->headers->get('X-Request-Id'));
    }

    public function test_no_sigue_redirecciones_y_usa_el_tiempo_maximo_de_3_segundos(): void
    {
        $opciones = null;
        $this->servicio = function (PeticionEnviada $req, array $o) use (&$opciones) {
            $opciones = $o;

            return Http::response('', 302, ['Location' => 'http://ms-catalogo:8000/otra']);
        };

        $r = $this->conSesion($this->usuario(Roles::VEN))->getJson('/api/productos');

        $r->assertStatus(302)->assertHeaderMissing('Location');
        Http::assertSentCount(1);
        $this->assertSame(3, $opciones['timeout'] ?? null);
        $this->assertSame(3, $opciones['connect_timeout'] ?? null);
        $this->assertFalse($opciones['allow_redirects'] ?? null);
    }

    public function test_servicio_caido_o_lento_es_503_servicio_no_disponible(): void   // [RF-5]
    {
        Log::spy();
        $this->servicio = fn () => throw new ConnectionException('cURL error 28: Operation timed out');

        $r = $this->conSesion($this->usuario())->getJson('/api/productos');

        $r->assertStatus(503)->assertJsonPath('error.codigo', 'SERVICIO_NO_DISPONIBLE');
        $this->assertSame(3, config('gateway.timeout_seconds'));
        $idPeticion = (string) $r->headers->get('X-Request-Id');
        $this->assertMatchesRegularExpression(self::UUID, $idPeticion);

        // Un registro con el servicio y el identificador de petición; nada de cuerpos, cabeceras ni tokens.
        Log::shouldHaveReceived('error')->withArgs(fn (string $mensaje, array $contexto = []) => $contexto === ['servicio' => 'ms-catalogo', 'request_id' => $idPeticion])->once();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Rutas no publicadas y rutas propias (Review Focus 4)
    // ---------------------------------------------------------------------------------------------------------

    /**
     * @return array<string, array{string, string}>
     */
    public static function rutasNoPublicadas(): array
    {
        return [
            'interna' => ['POST', '/api/internas/productos/lote'],
            'interna get' => ['GET', '/api/internas/productos/1'],
            'health' => ['GET', '/api/health'],
            'docs' => ['GET', '/api/docs'],
            'desconocida' => ['GET', '/api/desconocido'],
            'punto punto' => ['GET', '/api/productos/../usuarios'],
            'punto punto a interna' => ['GET', '/api/productos/../internas/productos/1'],
            'punto punto codificado' => ['GET', '/api/productos/%2e%2e/usuarios'],
            'punto punto mixto' => ['GET', '/api/productos/.%2E/internas/x'],
            'barra codificada' => ['GET', '/api/productos/25%2f..%2finternas'],
            // Decodificada sería `productos/25`, una ruta publicada: solo se rechaza si se mira la ruta cruda.
            'barra codificada que formaría una ruta publicada' => ['GET', '/api/productos%2f25'],
            'barra codificada en minúsculas y mayúsculas' => ['GET', '/api/proveedores%2F1%2fproductos'],
            'barra invertida codificada' => ['GET', '/api/productos/25%5cx'],
            'doble codificación' => ['GET', '/api/productos/%252e%252e'],
            'barra doble' => ['GET', '/api/productos//25'],
            'nul' => ['GET', '/api/productos/25%00'],
            'mayúsculas' => ['GET', '/api/Productos'],
            'método no listado' => ['PATCH', '/api/productos/25'],
            'head' => ['HEAD', '/api/productos'],
            'options' => ['OPTIONS', '/api/productos'],
            'método de usuarios no publicado' => ['PATCH', '/api/usuarios/1'],
        ];
    }

    #[DataProvider('rutasNoPublicadas')]
    public function test_rutas_no_publicadas_son_404_y_no_llegan_al_servicio(string $metodo, string $ruta): void   // [RF-4]
    {
        $r = $this->conSesion($this->usuario(Roles::ADM))->json($metodo, $ruta);

        $r->assertStatus(404);
        if ($metodo !== 'HEAD') {
            $r->assertJsonPath('error.codigo', 'NO_EXISTE');
        }
        Http::assertNothingSent();
    }

    public function test_sin_token_una_ruta_desconocida_es_401_antes_que_404(): void
    {
        foreach (['/api/desconocido', '/api/productos', '/api/internas/productos/lote', '/api/productos/../usuarios'] as $ruta) {
            $this->getJson($ruta)->assertStatus(401)->assertJsonPath('error.codigo', 'NO_AUTENTICADO');
        }

        // Con un token inválido tampoco se distingue lo publicado de lo que no existe.
        $this->withToken('no-es-un-jwt')->getJson('/api/desconocido')->assertStatus(401);
        $this->withToken('no-es-un-jwt')->getJson('/api/productos')->assertStatus(401);

        Http::assertNothingSent();
    }

    public function test_un_usuario_inactivo_no_llega_al_servicio(): void
    {
        $u = $this->usuario(Roles::ADM);
        $this->conSesion($u);
        $u->forceFill(['activo' => false])->save();

        $this->getJson('/api/productos')->assertStatus(401);

        Http::assertNothingSent();
    }

    public function test_las_rutas_propias_del_gateway_no_se_reenvian(): void
    {
        $adm = $this->usuario(Roles::ADM);

        $this->conSesion($adm)->getJson('/api/usuarios')->assertOk()->assertJsonStructure(['datos', 'meta']);
        $this->getJson('/api/roles')->assertOk()->assertJsonCount(4, 'datos');
        $this->getJson('/api/auth/me')->assertOk();
        $this->conSesion($this->usuario(Roles::VEN))->getJson('/api/usuarios')->assertStatus(403);

        Http::assertNothingSent();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Utilidades
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Separa un cuerpo multipart en sus partes: nombre => [filename, tipo, contenido]. Falla la prueba si el cuerpo
     * no respeta el formato (inicio, CRLF entre cabeceras y contenido, cierre).
     *
     * @return array<string, array{filename: string|null, tipo: string|null, contenido: string}>
     */
    private function partesMultipart(string $cuerpo, string $frontera): array
    {
        $this->assertStringStartsWith("--{$frontera}\r\n", $cuerpo);
        $this->assertStringEndsWith("\r\n--{$frontera}--\r\n", $cuerpo);

        $interior = substr($cuerpo, strlen("--{$frontera}\r\n"), -strlen("\r\n--{$frontera}--\r\n"));
        $partes = [];
        foreach (explode("\r\n--{$frontera}\r\n", $interior) as $parte) {
            [$bloque, $contenido] = explode("\r\n\r\n", $parte, 2);

            $cabeceras = [];
            foreach (explode("\r\n", $bloque) as $linea) {
                [$nombre, $valor] = explode(': ', $linea, 2);
                $cabeceras[strtolower($nombre)] = $valor;
            }

            $this->assertSame(1, preg_match('/^form-data; name="([^"]+)"(?:; filename="([^"]*)")?$/', $cabeceras['content-disposition'] ?? '', $m));
            $partes[$m[1]] = ['filename' => $m[2] ?? null, 'tipo' => $cabeceras['content-type'] ?? null, 'contenido' => $contenido];
        }

        return $partes;
    }
}
