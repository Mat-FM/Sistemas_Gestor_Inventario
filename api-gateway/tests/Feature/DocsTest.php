<?php

namespace Tests\Feature;

use App\Models\Rol;
use App\Models\Usuario;
use App\Support\Roles;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\Yaml\Yaml;
use Tests\Support\ApiHelpers;
use Tests\TestCase;

/**
 * Documentación OpenAPI propia del Gateway (RNF08): `GET /docs` (Swagger UI) y `GET /docs/openapi.yaml`.
 *
 * El documento describe solo las 12 operaciones que atiende el propio Gateway (Tabla 6 de la Entrega 2); cada
 * servicio publica la suya. Estas pruebas cruzan tres fuentes que deben decir lo mismo: el contrato (la lista
 * `CONTRATO`), las rutas registradas en Laravel y `openapi.yaml`. Además contrastan el documento con las respuestas
 * reales del Gateway (estados, códigos de error y forma de los cuerpos), para que no se desvíe del código.
 */
class DocsTest extends TestCase
{
    use ApiHelpers;

    private const METODOS_HTTP = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

    /**
     * Las 12 operaciones de la Tabla 6 y los estados que debe documentar cada una: los de la tabla más los que el
     * código devuelve de verdad (401/403 de la cadena de middleware, 422 de validación, 429, 500 y 503 genéricos).
     */
    private const CONTRATO = [
        'POST /api/auth/login' => ['200', '401', '403', '422', '429', '500', '503'],
        'POST /api/auth/logout' => ['204', '401', '429', '500', '503'],
        'GET /api/auth/me' => ['200', '401', '403', '429', '500', '503'],
        'PUT /api/auth/contrasena' => ['204', '401', '422', '429', '500', '503'],
        'GET /api/usuarios' => ['200', '401', '403', '422', '429', '500', '503'],
        'GET /api/usuarios/{id}' => ['200', '401', '403', '404', '429', '500', '503'],
        'POST /api/usuarios' => ['201', '401', '403', '404', '409', '422', '429', '500', '503'],
        'PUT /api/usuarios/{id}' => ['200', '401', '403', '404', '409', '422', '429', '500', '503'],
        'POST /api/usuarios/{id}/inactivar' => ['200', '401', '403', '404', '409', '429', '500', '503'],
        'POST /api/usuarios/{id}/activar' => ['200', '401', '403', '404', '429', '500', '503'],
        'POST /api/usuarios/{id}/restablecer-contrasena' => ['204', '401', '403', '404', '422', '429', '500', '503'],
        'GET /api/roles' => ['200', '401', '403', '429', '500', '503'],
    ];

    /** Las ocho operaciones de administración: método, ruta de prueba (el `{id}` es un número cualquiera) y cuerpo. */
    private const OPERACIONES_DE_ADMINISTRADOR = [
        'GET /api/usuarios' => ['GET', '/api/usuarios', []],
        'GET /api/usuarios/{id}' => ['GET', '/api/usuarios/1', []],
        'POST /api/usuarios' => ['POST', '/api/usuarios', []],
        'PUT /api/usuarios/{id}' => ['PUT', '/api/usuarios/1', []],
        'POST /api/usuarios/{id}/inactivar' => ['POST', '/api/usuarios/1/inactivar', []],
        'POST /api/usuarios/{id}/activar' => ['POST', '/api/usuarios/1/activar', []],
        'POST /api/usuarios/{id}/restablecer-contrasena' => ['POST', '/api/usuarios/1/restablecer-contrasena', []],
        'GET /api/roles' => ['GET', '/api/roles', []],
    ];

    private const CODIGOS_DE_ERROR = [
        'NO_AUTENTICADO', 'SIN_PERMISO', 'CAMBIO_CONTRASENA_REQUERIDO', 'DATOS_NO_VALIDOS', 'DEMASIADAS_PETICIONES',
        'CREDENCIALES_INVALIDAS', 'USUARIO_INACTIVO', 'CONTRASENA_ACTUAL_INCORRECTA', 'NO_EXISTE', 'CORREO_DUPLICADO',
        'CONFLICTO', 'SERVICIO_NO_DISPONIBLE', 'ERROR_INTERNO',
    ];

    /** @var array<string, mixed>|null */
    private static ?array $especificacion = null;

    // ---------------------------------------------------------------------------------------------------------
    // Qué sirve el Gateway
    // ---------------------------------------------------------------------------------------------------------

    public function test_docs_sirve_swagger_ui_y_la_especificacion(): void
    {
        $this->get('/docs')->assertOk()->assertSee('swagger-ui', false)->assertSee('/docs/openapi.yaml', false);
        $this->get('/docs/openapi.yaml')->assertOk();
    }

    public function test_docs_responde_html_y_es_publico_y_sin_limite(): void
    {
        // Aunque el cliente mande un token inválido: /docs no pasa por `jwt` ni por el limitador.
        $respuesta = $this->withToken('token-que-no-es-valido')->get('/docs');

        $respuesta->assertOk();
        $this->assertStringStartsWith('text/html', (string) $respuesta->headers->get('Content-Type'));
        $this->assertFalse($respuesta->headers->has('X-RateLimit-Limit'), '/docs no debe pasar por el limitador de peticiones.');

        $especificacion = $this->withToken('token-que-no-es-valido')->get('/docs/openapi.yaml');
        $especificacion->assertOk();
        $this->assertFalse($especificacion->headers->has('X-RateLimit-Limit'));
    }

    public function test_la_especificacion_se_sirve_en_crudo_como_yaml(): void
    {
        $respuesta = $this->get('/docs/openapi.yaml');

        $respuesta->assertOk();
        $this->assertSame('application/yaml; charset=utf-8', $respuesta->headers->get('Content-Type'));
        $this->assertSame(File::get(base_path('openapi.yaml')), $respuesta->getContent());
        $this->assertIsArray(Yaml::parse($respuesta->getContent()));
    }

    public function test_servir_la_documentacion_no_consulta_la_base_de_datos(): void
    {
        // RNF13: ni la página ni el documento dependen de la base.
        DB::flushQueryLog();
        DB::enableQueryLog();

        $this->get('/docs')->assertOk();
        $this->get('/docs/openapi.yaml')->assertOk();

        $this->assertSame([], DB::getQueryLog());
    }

    public function test_la_pagina_carga_swagger_ui_con_version_fija_e_integridad(): void
    {
        $html = (string) $this->get('/docs')->getContent();

        // Los únicos recursos externos son el CSS y el JS de swagger-ui-dist, con versión exacta (nunca `latest` ni
        // un rango), hash SRI sha384 y crossorigin anónimo (D14).
        preg_match_all('#<(?:link|script)\b[^>]*(?:href|src)="https?://[^>]*>#i', $html, $etiquetas);
        $this->assertCount(2, $etiquetas[0], 'Se esperaban exactamente dos recursos externos (CSS y JS).');

        $archivos = [];
        foreach ($etiquetas[0] as $etiqueta) {
            $this->assertMatchesRegularExpression(
                '#(?:href|src)="https://cdn\.jsdelivr\.net/npm/swagger-ui-dist@\d+\.\d+\.\d+/(swagger-ui\.css|swagger-ui-bundle\.js)"#',
                $etiqueta,
            );
            $this->assertMatchesRegularExpression('#\sintegrity="sha384-[A-Za-z0-9+/]{64}"#', $etiqueta);
            $this->assertMatchesRegularExpression('#\scrossorigin="anonymous"#', $etiqueta);
            preg_match('#/(swagger-ui\.css|swagger-ui-bundle\.js)"#', $etiqueta, $archivo);
            $archivos[] = $archivo[1];
        }
        sort($archivos);
        $this->assertSame(['swagger-ui-bundle.js', 'swagger-ui.css'], $archivos);

        // Todas las URLs de la página: solo ese CDN con versión fija (y el documento, que es relativo).
        preg_match_all('#https?://[^\s"\'<>]+#', $html, $urls);
        foreach ($urls[0] as $url) {
            $this->assertStringStartsWith('https://cdn.jsdelivr.net/npm/swagger-ui-dist@', $url);
        }
        $this->assertStringNotContainsString('latest', $html);
        $this->assertStringContainsString("url: '/docs/openapi.yaml'", $html);
    }

    public function test_no_se_publica_nada_mas_bajo_docs(): void
    {
        foreach (['/docs/openapi.json', '/docs/openapi.yml', '/docs/index.html', '/docs/otra-cosa', '/docs/openapi.yaml/x'] as $ruta) {
            $this->getJson($ruta)->assertStatus(404)->assertJsonPath('error.codigo', 'NO_EXISTE');
        }

        $this->postJson('/docs')->assertStatus(405);
    }

    public function test_el_comodin_del_proxy_no_atiende_docs_ni_health(): void
    {
        foreach (['docs', 'docs/openapi.yaml', 'health'] as $uri) {
            $ruta = app('router')->getRoutes()->match(Request::create('/'.$uri, 'GET'));

            $this->assertSame($uri, $ruta->uri(), "/{$uri} lo atiende una ruta propia, no el comodín de reenvío.");
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Paridad entre el contrato, las rutas registradas y openapi.yaml
    // ---------------------------------------------------------------------------------------------------------

    public function test_cada_ruta_propia_del_gateway_esta_documentada_y_viceversa(): void
    {
        $documentadas = array_keys($this->operaciones());
        $registradas = $this->operacionesRegistradas();
        $contrato = array_keys(self::CONTRATO);
        sort($documentadas);
        sort($registradas);
        sort($contrato);

        // Primero, qué falta en cada sentido (el mensaje nombra las operaciones)...
        $sinDocumentar = array_values(array_diff($registradas, $documentadas));
        $sinRuta = array_values(array_diff($documentadas, $registradas));
        $this->assertSame([], $sinDocumentar, 'Rutas registradas que faltan en openapi.yaml: '.implode(', ', $sinDocumentar));
        $this->assertSame([], $sinRuta, 'Operaciones de openapi.yaml sin ruta registrada: '.implode(', ', $sinRuta));

        // ...y después la cuenta: dos conjuntos vacíos no pueden pasar como paridad.
        $this->assertCount(12, $registradas, 'Se esperaban 12 rutas propias registradas (Tabla 6).');
        $this->assertCount(12, $documentadas, 'Se esperaban 12 operaciones en openapi.yaml (Tabla 6).');

        $this->assertSame($registradas, $documentadas);
        $this->assertSame($contrato, $registradas, 'Las rutas propias no coinciden con la Tabla 6.');
    }

    public function test_el_documento_describe_solo_las_rutas_propias(): void
    {
        $especificacion = $this->especificacion();

        $this->assertStringStartsWith('3.', (string) $especificacion['openapi']);

        foreach ($especificacion['paths'] as $ruta => $operaciones) {
            $this->assertMatchesRegularExpression('#^/api/(auth|usuarios|roles)(/|$)#', $ruta);
            $this->assertStringNotContainsString('{path}', $ruta, 'El comodín de reenvío no forma parte del documento.');

            // Los parámetros de ruta se llaman `{id}`, igual que en las rutas de Laravel.
            preg_match_all('#\{([^}]*)\}#', $ruta, $parametros);
            foreach ($parametros[1] as $nombre) {
                $this->assertSame('id', $nombre);
            }

            // Cada clave del elemento de ruta es un método HTTP: una clave rara (`parameters`, un error de
            // escritura) no contaría como operación y pasaría desapercibida en la paridad.
            foreach (array_keys($operaciones) as $metodo) {
                $this->assertContains($metodo, self::METODOS_HTTP, "La clave «{$metodo}» de {$ruta} no es un método HTTP en minúsculas.");
            }
        }

        // La nota para el lector: lo demás de /api se reenvía y cada servicio publica su documentación.
        $descripcion = (string) $especificacion['info']['description'];
        $this->assertStringContainsString('microservicios', $descripcion);
        $this->assertStringContainsString('documentación', $descripcion);
    }

    public function test_todas_las_referencias_internas_existen(): void
    {
        $referencias = $this->referencias($this->especificacion());

        $this->assertGreaterThan(20, count($referencias), 'El documento debería reutilizar esquemas y respuestas con $ref.');
        foreach ($referencias as $referencia) {
            $this->apuntar($referencia); // falla con un mensaje claro si no existe
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Forma de cada operación
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Reglas estructurales de OpenAPI 3.0 que Swagger UI perdona sin avisar (no se usa un validador externo: RNF15).
     */
    public function test_el_documento_cumple_las_reglas_estructurales_de_openapi(): void
    {
        $especificacion = $this->especificacion();

        // Los campos obligatorios de la raíz.
        foreach (['openapi', 'info', 'paths'] as $campo) {
            $this->assertArrayHasKey($campo, $especificacion);
        }
        $this->assertNotSame('', trim((string) ($especificacion['info']['title'] ?? '')));
        $this->assertNotSame('', trim((string) ($especificacion['info']['version'] ?? '')));

        $etiquetas = array_column($especificacion['tags'] ?? [], 'name');
        $esquemasDeSeguridad = array_keys($especificacion['components']['securitySchemes'] ?? []);

        foreach ($this->operaciones() as $nombre => $operacion) {
            // Las etiquetas y la seguridad que usa la operación existen.
            foreach ($operacion['tags'] ?? [] as $etiqueta) {
                $this->assertContains($etiqueta, $etiquetas, "{$nombre}: la etiqueta «{$etiqueta}» no está declarada.");
            }
            foreach ($operacion['security'] ?? [] as $requisito) {
                foreach (array_keys($requisito) as $esquema) {
                    $this->assertContains($esquema, $esquemasDeSeguridad, "{$nombre}: el esquema de seguridad «{$esquema}» no existe.");
                }
            }

            // Cada `{parametro}` de la ruta está declarado como parámetro de ruta obligatorio, y viceversa.
            [, $ruta] = explode(' ', $nombre, 2);
            preg_match_all('#\{([^}]*)\}#', $ruta, $enLaRuta);
            $declarados = [];
            foreach ($operacion['parameters'] ?? [] as $parametro) {
                $parametro = $this->resolver($parametro);
                foreach (['name', 'in', 'schema'] as $campo) {
                    $this->assertArrayHasKey($campo, $parametro, "{$nombre}: a un parámetro le falta «{$campo}».");
                }
                if ($parametro['in'] === 'path') {
                    $this->assertTrue($parametro['required'] ?? false, "{$nombre}: el parámetro de ruta {$parametro['name']} debe ser required: true.");
                    $declarados[] = $parametro['name'];
                }
            }
            $this->assertEqualsCanonicalizing($enLaRuta[1], $declarados, "{$nombre}: los parámetros de ruta no coinciden con la ruta.");

            // Un cuerpo de petición declara su contenido; toda respuesta tiene `description` (obligatoria).
            if (isset($operacion['requestBody'])) {
                $this->assertNotEmpty($this->resolver($operacion['requestBody'])['content'] ?? [], "{$nombre}: requestBody sin content.");
            }
            foreach ($operacion['responses'] as $estado => $respuesta) {
                $this->assertNotSame('', trim((string) ($this->resolver($respuesta)['description'] ?? '')), "{$nombre} {$estado}: la respuesta no tiene description.");
            }
        }

        foreach ($especificacion['components']['responses'] as $nombre => $respuesta) {
            $this->assertNotSame('', trim((string) ($respuesta['description'] ?? '')), "components.responses.{$nombre} no tiene description.");
        }

        $this->afirmarEstructura($especificacion, '#');
    }

    /** Recorre el documento: un `$ref` no admite hermanos (se ignoran) y todo `required` nombra propiedades que existen. */
    private function afirmarEstructura(mixed $nodo, string $ruta): void
    {
        if (! is_array($nodo)) {
            return;
        }

        if (array_key_exists('$ref', $nodo)) {
            $this->assertCount(1, $nodo, "{$ruta}: un \$ref no puede tener otras claves (OpenAPI 3.0 las ignora).");
        }

        if (($nodo['type'] ?? null) === 'object' && isset($nodo['required']) && is_array($nodo['required']) && isset($nodo['properties'])) {
            $inexistentes = array_diff($nodo['required'], array_keys($nodo['properties']));
            $this->assertSame([], array_values($inexistentes), "{$ruta}: required nombra propiedades que no existen: ".implode(', ', $inexistentes));
        }

        foreach ($nodo as $clave => $valor) {
            $this->afirmarEstructura($valor, "{$ruta}/{$clave}");
        }
    }

    public function test_cada_operacion_tiene_resumen_identificador_unico_y_respuestas(): void
    {
        $identificadores = [];

        foreach ($this->operaciones() as $nombre => $operacion) {
            $this->assertNotSame('', trim((string) ($operacion['summary'] ?? '')), "{$nombre} no tiene resumen.");
            $this->assertNotSame('', trim((string) ($operacion['operationId'] ?? '')), "{$nombre} no tiene operationId.");
            $identificadores[] = $operacion['operationId'];

            $this->assertIsArray($operacion['responses'] ?? null, "{$nombre} no tiene responses.");
            $this->assertNotEmpty($operacion['responses'], "{$nombre} no documenta ninguna respuesta.");
            $this->assertNotEmpty(
                array_filter(array_keys($operacion['responses']), fn ($estado) => $estado >= 200 && $estado < 300),
                "{$nombre} no documenta ninguna respuesta de éxito.",
            );
        }

        $this->assertSame($identificadores, array_values(array_unique($identificadores)), 'Hay operationId repetidos.');
    }

    #[DataProvider('estadosDelContrato')]
    public function test_cada_operacion_documenta_los_estados_del_contrato(string $operacion, array $estados): void
    {
        $documentados = array_map('strval', array_keys($this->operaciones()[$operacion]['responses']));
        sort($documentados);

        $this->assertSame($estados, $documentados, "Estados documentados de {$operacion}.");
    }

    /** @return array<string, array{string, list<string>}> */
    public static function estadosDelContrato(): array
    {
        $casos = [];
        foreach (self::CONTRATO as $operacion => $estados) {
            $casos[$operacion] = [$operacion, $estados];
        }

        return $casos;
    }

    public function test_todas_las_operaciones_salvo_el_login_declaran_la_seguridad_bearer(): void
    {
        $especificacion = $this->especificacion();
        $esquema = $especificacion['components']['securitySchemes']['bearerAuth'] ?? [];
        $this->assertSame('http', $esquema['type'] ?? null);
        $this->assertSame('bearer', $esquema['scheme'] ?? null);
        $this->assertSame('JWT', $esquema['bearerFormat'] ?? null);

        // Sin `security` global: cada operación declara lo suyo.
        $this->assertArrayNotHasKey('security', $especificacion);

        foreach ($this->operaciones() as $nombre => $operacion) {
            if ($nombre === 'POST /api/auth/login') {
                $this->assertEmpty($operacion['security'] ?? [], 'El inicio de sesión es público.');

                continue;
            }

            $this->assertSame([['bearerAuth' => []]], $operacion['security'] ?? null, "{$nombre} debe exigir bearerAuth.");
        }
    }

    public function test_los_errores_usan_el_esquema_error(): void
    {
        $revisadas = 0;

        foreach ($this->operaciones() as $nombre => $operacion) {
            $errores = 0;
            foreach ($operacion['responses'] as $estado => $respuesta) {
                if ((int) $estado < 400) {
                    continue;
                }

                $resuelta = $this->resolver($respuesta);
                $this->assertSame(
                    '#/components/schemas/Error',
                    $resuelta['content']['application/json']['schema']['$ref'] ?? null,
                    "{$nombre} {$estado} debe usar el esquema Error.",
                );
                $revisadas++;
                $errores++;
            }

            $this->assertGreaterThanOrEqual(3, $errores, "{$nombre} debería documentar al menos tres errores.");
        }

        $this->assertGreaterThanOrEqual(12 * 3, $revisadas);

        // La forma común de error: {error: {codigo, mensaje, detalles}}.
        $error = $this->especificacion()['components']['schemas']['Error'];
        $this->assertSame(['error'], $error['required']);
        $this->assertEqualsCanonicalizing(['codigo', 'mensaje', 'detalles'], $error['properties']['error']['required']);
        $this->assertEqualsCanonicalizing(['codigo', 'mensaje', 'detalles'], array_keys($error['properties']['error']['properties']));
    }

    public function test_el_429_declara_retry_after_en_todas_las_operaciones(): void
    {
        foreach ($this->operaciones() as $nombre => $operacion) {
            $respuesta = $this->resolver($operacion['responses']['429']);

            $this->assertArrayHasKey('Retry-After', $respuesta['headers'] ?? [], "{$nombre}: el 429 debe declarar Retry-After.");
            $this->assertSame('integer', $this->resolver($respuesta['headers']['Retry-After'])['schema']['type']);
        }
    }

    public function test_los_codigos_de_error_del_contrato_estan_documentados(): void
    {
        $documentados = $this->codigosEn($this->especificacion());

        foreach (self::CODIGOS_DE_ERROR as $codigo) {
            $this->assertContains($codigo, $documentados, "El código {$codigo} no aparece en ningún ejemplo de openapi.yaml.");
        }
    }

    public function test_los_tipos_numericos_del_contrato_son_enteros(): void
    {
        $esquemas = $this->especificacion()['components']['schemas'];

        // El código exige enteros JSON estrictos: "2" da 422.
        foreach (['UsuarioNuevo', 'UsuarioEditado'] as $nombre) {
            $this->assertSame('integer', $esquemas[$nombre]['properties']['id_rol']['type'], "{$nombre}.id_rol");
            $this->assertSame('integer', $esquemas[$nombre]['properties']['id_bodega']['type'], "{$nombre}.id_bodega");
            $this->assertTrue($esquemas[$nombre]['properties']['id_bodega']['nullable'] ?? false, "{$nombre}.id_bodega puede omitirse o ir en null.");
            $this->assertContains('id_rol', $esquemas[$nombre]['required']);
            $this->assertNotContains('id_bodega', $esquemas[$nombre]['required']);
        }

        // La vigencia del token, en segundos.
        $this->assertSame('integer', $esquemas['SesionIniciada']['properties']['expira_en']['type']);
        $this->assertSame(3600, $esquemas['SesionIniciada']['properties']['expira_en']['example']);

        foreach (['pagina', 'por_pagina', 'total'] as $campo) {
            $this->assertSame('integer', $esquemas['Meta']['properties'][$campo]['type'], "Meta.{$campo}");
        }

        foreach (['Usuario', 'UsuarioDeSesion'] as $nombre) {
            $this->assertSame('integer', $esquemas[$nombre]['properties']['id_usuario']['type'], "{$nombre}.id_usuario");
            $this->assertSame('integer', $esquemas[$nombre]['properties']['id_bodega']['type'], "{$nombre}.id_bodega");
        }
        $this->assertSame('integer', $esquemas['Rol']['properties']['id_rol']['type']);
    }

    // ---------------------------------------------------------------------------------------------------------
    // El documento frente al comportamiento real del Gateway
    // ---------------------------------------------------------------------------------------------------------

    /**
     * Ejecuta un escenario real y comprueba que openapi.yaml lo describe: el estado está documentado, el código
     * de error sale en los ejemplos de esa respuesta y el cuerpo cumple el esquema (campos, tipos y nulos).
     */
    #[DataProvider('casos')]
    public function test_la_respuesta_real_esta_documentada(string $operacion, int $estado, ?string $codigo, Closure $escenario): void
    {
        $respuesta = $escenario($this);

        $this->assertSame($estado, $respuesta->getStatusCode(), "{$operacion}: estado real distinto del esperado. Cuerpo: ".$respuesta->getContent());
        $this->assertTrue($respuesta->headers->has('X-Request-Id'), "{$operacion} {$estado}: la respuesta debe llevar X-Request-Id (el documento lo promete).");

        $definicion = $this->operaciones()[$operacion] ?? $this->fail("{$operacion} no está en openapi.yaml.");
        $this->assertArrayHasKey($estado, $definicion['responses'], "{$operacion} responde {$estado} pero openapi.yaml no lo documenta.");
        $documentada = $this->resolver($definicion['responses'][$estado]);

        foreach (array_keys($documentada['headers'] ?? []) as $cabecera) {
            $this->assertTrue($respuesta->headers->has($cabecera), "{$operacion} {$estado}: falta la cabecera documentada {$cabecera}.");
        }

        $cuerpo = (string) $respuesta->getContent();
        if (! isset($documentada['content'])) {
            $this->assertSame('', $cuerpo, "{$operacion} {$estado} está documentada sin cuerpo.");

            return;
        }

        $this->assertArrayHasKey('application/json', $documentada['content']);
        $this->assertStringStartsWith('application/json', (string) $respuesta->headers->get('Content-Type'));
        $datos = json_decode($cuerpo, true, 512, JSON_THROW_ON_ERROR);
        $this->conforme($datos, $documentada['content']['application/json']['schema'], "{$operacion} {$estado}");

        if ($estado >= 400) {
            $this->assertSame($codigo, $datos['error']['codigo']);
            $this->assertContains($datos['error']['codigo'], $this->codigosEn($documentada), "{$operacion} {$estado}: el código {$datos['error']['codigo']} no está en los ejemplos.");
        }
    }

    public function test_cada_estado_y_codigo_documentado_tiene_un_caso_real(): void
    {
        $cubiertos = [];
        foreach (self::casos() as [$operacion, $estado, $codigo]) {
            $cubiertos[$operacion][$estado][$codigo ?? ''] = true;
        }

        foreach ($this->operaciones() as $operacion => $definicion) {
            foreach ($definicion['responses'] as $estado => $respuesta) {
                // 429 se prueba en el login y en una operación autenticada; 500 y 503 son genéricos.
                if (in_array((int) $estado, [429, 500, 503], true)) {
                    continue;
                }

                $codigos = (int) $estado >= 400 ? $this->codigosEn($this->resolver($respuesta)) : [''];
                $this->assertNotSame([], $codigos, "{$operacion} {$estado}: los ejemplos deben llevar `codigo`.");

                foreach ($codigos as $codigo) {
                    $this->assertArrayHasKey($codigo, $cubiertos[$operacion][(int) $estado] ?? [], "{$operacion} {$estado} {$codigo}: documentado sin ningún caso real que lo produzca.");
                }
            }
        }
    }

    /**
     * Escenarios reales: [operación, estado esperado, código de error esperado, escenario]. El escenario recibe la
     * prueba para usar sus utilidades (usuarios, sesión, peticiones) y devuelve la respuesta.
     *
     * @return array<string, array{string, int, ?string, Closure}>
     */
    public static function casos(): array
    {
        $casos = [
            // --- POST /api/auth/login ---
            'login: sesión iniciada' => ['POST /api/auth/login', 200, null, static function (self $t): TestResponse {
                $t->usuario(Roles::OPE, ['correo' => 'operador@example.test', 'id_bodega' => 4]);

                return $t->postJson('/api/auth/login', ['correo' => 'operador@example.test', 'contrasena' => self::CONTRASENA_DE_PRUEBA]);
            }],
            'login: administrador sin bodega' => ['POST /api/auth/login', 200, null, static function (self $t): TestResponse {
                $t->usuario(Roles::ADM, ['correo' => 'admin@example.test']);

                return $t->postJson('/api/auth/login', ['correo' => 'admin@example.test', 'contrasena' => self::CONTRASENA_DE_PRUEBA]);
            }],
            'login: contraseña incorrecta' => ['POST /api/auth/login', 401, 'CREDENCIALES_INVALIDAS', static function (self $t): TestResponse {
                $t->usuario(Roles::VEN, ['correo' => 'ventas@example.test']);

                return $t->postJson('/api/auth/login', ['correo' => 'ventas@example.test', 'contrasena' => 'otra-clave']);
            }],
            'login: correo inexistente' => ['POST /api/auth/login', 401, 'CREDENCIALES_INVALIDAS', static fn (self $t): TestResponse => $t->postJson('/api/auth/login', ['correo' => 'nadie@example.test', 'contrasena' => 'otra-clave'])],
            'login: usuario inactivo' => ['POST /api/auth/login', 403, 'USUARIO_INACTIVO', static function (self $t): TestResponse {
                $t->usuario(Roles::VEN, ['correo' => 'inactivo@example.test', 'activo' => false]);

                return $t->postJson('/api/auth/login', ['correo' => 'inactivo@example.test', 'contrasena' => self::CONTRASENA_DE_PRUEBA]);
            }],
            'login: cuerpo vacío' => ['POST /api/auth/login', 422, 'DATOS_NO_VALIDOS', static fn (self $t): TestResponse => $t->postJson('/api/auth/login', [])],
            'login: más de 10 intentos por minuto' => ['POST /api/auth/login', 429, 'DEMASIADAS_PETICIONES', static function (self $t): TestResponse {
                for ($i = 0; $i < 10; $i++) {
                    $t->postJson('/api/auth/login', ['correo' => 'x@example.test', 'contrasena' => 'mala']);
                }

                return $t->postJson('/api/auth/login', ['correo' => 'x@example.test', 'contrasena' => 'mala']);
            }],

            // --- POST /api/auth/logout ---
            'logout: sesión cerrada' => ['POST /api/auth/logout', 204, null, static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/auth/logout');
            }],
            'logout: con cambio de contraseña pendiente también funciona' => ['POST /api/auth/logout', 204, null, static function (self $t): TestResponse {
                $t->conSesion($t->usuario(Roles::VEN, ['debe_cambiar_contrasena' => true]));

                return $t->postJson('/api/auth/logout');
            }],
            'logout: sin token' => ['POST /api/auth/logout', 401, 'NO_AUTENTICADO', static fn (self $t): TestResponse => $t->postJson('/api/auth/logout')],

            // --- GET /api/auth/me ---
            'me: administrador' => ['GET /api/auth/me', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->getJson('/api/auth/me');
            }],
            'me: operador con bodega' => ['GET /api/auth/me', 200, null, static function (self $t): TestResponse {
                $t->conSesion($t->usuario(Roles::OPE, ['id_bodega' => 9]));

                return $t->getJson('/api/auth/me');
            }],
            'me: sin token' => ['GET /api/auth/me', 401, 'NO_AUTENTICADO', static fn (self $t): TestResponse => $t->getJson('/api/auth/me')],
            'me: cambio de contraseña pendiente' => ['GET /api/auth/me', 403, 'CAMBIO_CONTRASENA_REQUERIDO', static function (self $t): TestResponse {
                $t->conSesion($t->usuario(Roles::VEN, ['debe_cambiar_contrasena' => true]));

                return $t->getJson('/api/auth/me');
            }],

            // --- PUT /api/auth/contrasena ---
            'contrasena: cambiada' => ['PUT /api/auth/contrasena', 204, null, static function (self $t): TestResponse {
                $t->conSesion($t->usuario(Roles::VEN, ['debe_cambiar_contrasena' => true]));

                return $t->putJson('/api/auth/contrasena', ['contrasena_actual' => self::CONTRASENA_DE_PRUEBA, 'contrasena_nueva' => 'Nueva2026Clave']);
            }],
            'contrasena: sin token' => ['PUT /api/auth/contrasena', 401, 'NO_AUTENTICADO', static fn (self $t): TestResponse => $t->putJson('/api/auth/contrasena', ['contrasena_actual' => 'a', 'contrasena_nueva' => 'b'])],
            'contrasena: la actual es incorrecta' => ['PUT /api/auth/contrasena', 401, 'CONTRASENA_ACTUAL_INCORRECTA', static function (self $t): TestResponse {
                $t->conSesion($t->usuario(Roles::VEN));

                return $t->putJson('/api/auth/contrasena', ['contrasena_actual' => 'no-es-esa', 'contrasena_nueva' => 'Nueva2026Clave']);
            }],
            'contrasena: la nueva no es válida' => ['PUT /api/auth/contrasena', 422, 'DATOS_NO_VALIDOS', static function (self $t): TestResponse {
                $t->conSesion($t->usuario(Roles::VEN));

                return $t->putJson('/api/auth/contrasena', ['contrasena_actual' => self::CONTRASENA_DE_PRUEBA, 'contrasena_nueva' => 'corta']);
            }],

            // --- GET /api/usuarios ---
            'usuarios: listado con filtros' => ['GET /api/usuarios', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $t->usuario(Roles::OPE, ['id_bodega' => 3]);
                $t->usuario(Roles::VEN, ['activo' => false]);

                return $t->getJson('/api/usuarios?activo=true&por_pagina=5&pagina=1&id_rol='.$t->idRol(Roles::ADM));
            }],
            'usuarios: listado completo' => ['GET /api/usuarios', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $t->usuario(Roles::OPE, ['id_bodega' => 3]);

                return $t->getJson('/api/usuarios');
            }],
            'usuarios: filtros no válidos' => ['GET /api/usuarios', 422, 'DATOS_NO_VALIDOS', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->getJson('/api/usuarios?por_pagina=1000&activo=si');
            }],

            // --- GET /api/usuarios/{id} ---
            'usuario: encontrado' => ['GET /api/usuarios/{id}', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::OPE, ['id_bodega' => 2]);

                return $t->getJson('/api/usuarios/'.$objetivo->id_usuario);
            }],
            'usuario: no existe' => ['GET /api/usuarios/{id}', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->getJson('/api/usuarios/999999');
            }],
            'usuario: id que no es un número' => ['GET /api/usuarios/{id}', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->getJson('/api/usuarios/abc');
            }],

            // --- POST /api/usuarios ---
            'crear: usuario creado' => ['POST /api/usuarios', 201, null, static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios', [
                    'nombre' => 'Rosa Vendedora', 'correo' => 'Rosa@Example.test', 'id_rol' => $t->idRol(Roles::VEN), 'contrasena_temporal' => 'Temporal2026',
                ]);
            }],
            'crear: operador con bodega' => ['POST /api/usuarios', 201, null, static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios', [
                    'nombre' => 'Omar Operador', 'correo' => 'omar@example.test', 'id_rol' => $t->idRol(Roles::OPE), 'id_bodega' => 7, 'contrasena_temporal' => 'Temporal2026',
                ]);
            }],
            'crear: el rol no existe' => ['POST /api/usuarios', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios', [
                    'nombre' => 'Sin Rol', 'correo' => 'sinrol@example.test', 'id_rol' => 9999, 'contrasena_temporal' => 'Temporal2026',
                ]);
            }],
            'crear: correo duplicado' => ['POST /api/usuarios', 409, 'CORREO_DUPLICADO', static function (self $t): TestResponse {
                $t->comoAdministrador();
                $t->usuario(Roles::VEN, ['correo' => 'repetido@example.test']);

                return $t->postJson('/api/usuarios', [
                    'nombre' => 'Repetido', 'correo' => 'repetido@example.test', 'id_rol' => $t->idRol(Roles::VEN), 'contrasena_temporal' => 'Temporal2026',
                ]);
            }],
            'crear: operador sin bodega' => ['POST /api/usuarios', 422, 'DATOS_NO_VALIDOS', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios', [
                    'nombre' => 'Sin Bodega', 'correo' => 'sinbodega@example.test', 'id_rol' => $t->idRol(Roles::OPE), 'contrasena_temporal' => 'Temporal2026',
                ]);
            }],
            'crear: id_rol como texto' => ['POST /api/usuarios', 422, 'DATOS_NO_VALIDOS', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios', [
                    'nombre' => 'Texto', 'correo' => 'texto@example.test', 'id_rol' => (string) $t->idRol(Roles::VEN), 'contrasena_temporal' => 'Temporal2026',
                ]);
            }],

            // --- PUT /api/usuarios/{id} ---
            'editar: usuario actualizado' => ['PUT /api/usuarios/{id}', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN);

                return $t->putJson('/api/usuarios/'.$objetivo->id_usuario, [
                    'nombre' => 'Nuevo Nombre', 'correo' => 'nuevo@example.test', 'id_rol' => $t->idRol(Roles::OPE), 'id_bodega' => 5,
                ]);
            }],
            'editar: el usuario no existe' => ['PUT /api/usuarios/{id}', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->putJson('/api/usuarios/999999', [
                    'nombre' => 'Nadie', 'correo' => 'nadie@example.test', 'id_rol' => $t->idRol(Roles::VEN),
                ]);
            }],
            'editar: el rol no existe' => ['PUT /api/usuarios/{id}', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN);

                return $t->putJson('/api/usuarios/'.$objetivo->id_usuario, [
                    'nombre' => 'Sin Rol', 'correo' => 'sinrol@example.test', 'id_rol' => 9999,
                ]);
            }],
            'editar: correo duplicado' => ['PUT /api/usuarios/{id}', 409, 'CORREO_DUPLICADO', static function (self $t): TestResponse {
                $t->comoAdministrador(['correo' => 'admin@example.test']);
                $objetivo = $t->usuario(Roles::VEN);

                return $t->putJson('/api/usuarios/'.$objetivo->id_usuario, [
                    'nombre' => 'Repetido', 'correo' => 'admin@example.test', 'id_rol' => $t->idRol(Roles::VEN),
                ]);
            }],
            'editar: el administrador se quita el rol a sí mismo' => ['PUT /api/usuarios/{id}', 409, 'CONFLICTO', static function (self $t): TestResponse {
                $admin = $t->comoAdministrador();

                return $t->putJson('/api/usuarios/'.$admin->id_usuario, [
                    'nombre' => 'Yo', 'correo' => 'yo@example.test', 'id_rol' => $t->idRol(Roles::VEN),
                ]);
            }],
            'editar: operador sin bodega' => ['PUT /api/usuarios/{id}', 422, 'DATOS_NO_VALIDOS', static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN);

                return $t->putJson('/api/usuarios/'.$objetivo->id_usuario, [
                    'nombre' => 'Sin Bodega', 'correo' => 'sinbodega@example.test', 'id_rol' => $t->idRol(Roles::OPE),
                ]);
            }],

            // --- POST /api/usuarios/{id}/inactivar ---
            'inactivar: usuario inactivado' => ['POST /api/usuarios/{id}/inactivar', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN);

                return $t->postJson('/api/usuarios/'.$objetivo->id_usuario.'/inactivar');
            }],
            'inactivar: el usuario no existe' => ['POST /api/usuarios/{id}/inactivar', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios/999999/inactivar');
            }],
            'inactivar: el administrador se inactiva a sí mismo' => ['POST /api/usuarios/{id}/inactivar', 409, 'CONFLICTO', static function (self $t): TestResponse {
                $admin = $t->comoAdministrador();

                return $t->postJson('/api/usuarios/'.$admin->id_usuario.'/inactivar');
            }],

            // --- POST /api/usuarios/{id}/activar ---
            'activar: usuario activado' => ['POST /api/usuarios/{id}/activar', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN, ['activo' => false]);

                return $t->postJson('/api/usuarios/'.$objetivo->id_usuario.'/activar');
            }],
            'activar: el usuario no existe' => ['POST /api/usuarios/{id}/activar', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios/999999/activar');
            }],

            // --- POST /api/usuarios/{id}/restablecer-contrasena ---
            'restablecer: contraseña restablecida' => ['POST /api/usuarios/{id}/restablecer-contrasena', 204, null, static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN);

                return $t->postJson('/api/usuarios/'.$objetivo->id_usuario.'/restablecer-contrasena', ['contrasena_temporal' => 'Temporal2026']);
            }],
            'restablecer: el usuario no existe' => ['POST /api/usuarios/{id}/restablecer-contrasena', 404, 'NO_EXISTE', static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->postJson('/api/usuarios/999999/restablecer-contrasena', ['contrasena_temporal' => 'Temporal2026']);
            }],
            'restablecer: contraseña temporal no válida' => ['POST /api/usuarios/{id}/restablecer-contrasena', 422, 'DATOS_NO_VALIDOS', static function (self $t): TestResponse {
                $t->comoAdministrador();
                $objetivo = $t->usuario(Roles::VEN);

                return $t->postJson('/api/usuarios/'.$objetivo->id_usuario.'/restablecer-contrasena', ['contrasena_temporal' => 'corta']);
            }],

            // --- GET /api/roles ---
            'roles: los cuatro roles' => ['GET /api/roles', 200, null, static function (self $t): TestResponse {
                $t->comoAdministrador();

                return $t->getJson('/api/roles');
            }],

            // --- Límite de 100 peticiones por minuto por usuario, en una operación autenticada ---
            'roles: más de 100 peticiones por minuto' => ['GET /api/roles', 429, 'DEMASIADAS_PETICIONES', static function (self $t): TestResponse {
                config(['gateway.rate_limit.por_usuario' => 2]);
                $t->comoAdministrador();
                $t->getJson('/api/roles');
                $t->getJson('/api/roles');

                return $t->getJson('/api/roles');
            }],
        ];

        // Las ocho operaciones de administración: sin token, con un rol que no puede y con el cambio de
        // contraseña pendiente (que se comprueba antes que el rol).
        foreach (self::OPERACIONES_DE_ADMINISTRADOR as $operacion => [$metodo, $ruta, $cuerpo]) {
            $casos["{$operacion}: sin token"] = [$operacion, 401, 'NO_AUTENTICADO', static fn (self $t): TestResponse => $t->json($metodo, $ruta, $cuerpo)];
            $casos["{$operacion}: rol sin permiso"] = [$operacion, 403, 'SIN_PERMISO', static function (self $t) use ($metodo, $ruta, $cuerpo): TestResponse {
                $t->conSesion($t->usuario(Roles::CON));

                return $t->json($metodo, $ruta, $cuerpo);
            }];
            $casos["{$operacion}: cambio de contraseña pendiente"] = [$operacion, 403, 'CAMBIO_CONTRASENA_REQUERIDO', static function (self $t) use ($metodo, $ruta, $cuerpo): TestResponse {
                $t->conSesion($t->usuario(Roles::ADM, ['debe_cambiar_contrasena' => true]));

                return $t->json($metodo, $ruta, $cuerpo);
            }];
        }

        return $casos;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Utilidades
    // ---------------------------------------------------------------------------------------------------------

    /** @param  array<string, mixed>  $atributos */
    private function comoAdministrador(array $atributos = []): Usuario
    {
        $administrador = $this->usuario(Roles::ADM, $atributos);
        $this->conSesion($administrador);

        return $administrador;
    }

    private function idRol(string $nombre): int
    {
        return (int) Rol::query()->where('nombre', $nombre)->value('id_rol');
    }

    /** El documento ya interpretado. Se lee del archivo, no de /docs/openapi.yaml, para no depender de la ruta. */
    private function especificacion(): array
    {
        return self::$especificacion ??= Yaml::parseFile(base_path('openapi.yaml'));
    }

    /**
     * Las operaciones del documento, como «MÉTODO /ruta» → definición, ordenadas. Los estados de `responses` son
     * enteros (PHP convierte las claves numéricas), por eso las pruebas comparan con `(string)` o `(int)`.
     *
     * @return array<string, array<string, mixed>>
     */
    private function operaciones(): array
    {
        $operaciones = [];
        foreach ($this->especificacion()['paths'] as $ruta => $metodos) {
            foreach ($metodos as $metodo => $definicion) {
                $operaciones[strtoupper($metodo).' '.$ruta] = $definicion;
            }
        }
        ksort($operaciones);

        return $operaciones;
    }

    /**
     * Las rutas propias registradas en Laravel (`api/auth*`, `api/usuarios*`, `api/roles*`) como «MÉTODO /ruta»,
     * ordenadas y sin HEAD. El comodín `api/{path}`, `/health` y `/docs` no entran.
     *
     * @return list<string>
     */
    private function operacionesRegistradas(): array
    {
        return collect(Route::getRoutes())
            ->filter(fn ($ruta) => preg_match('#^api/(auth|usuarios|roles)#', $ruta->uri()) === 1)
            ->flatMap(fn ($ruta) => collect($ruta->methods())
                ->reject(fn ($metodo) => $metodo === 'HEAD')
                ->map(fn ($metodo) => $metodo.' /'.$ruta->uri()))
            ->sort()
            ->values()
            ->all();
    }

    /** Sigue los `$ref` hasta llegar al objeto real. */
    private function resolver(mixed $nodo): array
    {
        $this->assertIsArray($nodo);
        $vistos = 0;
        while (isset($nodo['$ref'])) {
            $this->assertLessThan(10, ++$vistos, 'Cadena de $ref demasiado larga.');
            $nodo = $this->apuntar($nodo['$ref']);
            $this->assertIsArray($nodo);
        }

        return $nodo;
    }

    /** Resuelve un puntero local (`#/components/schemas/Usuario`); falla con el nombre del `$ref` roto. */
    private function apuntar(string $referencia): mixed
    {
        $this->assertStringStartsWith('#/', $referencia, "Solo se admiten \$ref locales: {$referencia}");

        $actual = $this->especificacion();
        foreach (explode('/', substr($referencia, 2)) as $parte) {
            $parte = str_replace(['~1', '~0'], ['/', '~'], $parte);
            $this->assertIsArray($actual, "El \$ref {$referencia} no existe.");
            $this->assertArrayHasKey($parte, $actual, "El \$ref {$referencia} no existe.");
            $actual = $actual[$parte];
        }

        return $actual;
    }

    /** Todos los `$ref` del documento, con repeticiones. @return list<string> */
    private function referencias(mixed $nodo): array
    {
        $referencias = [];
        if (is_array($nodo)) {
            foreach ($nodo as $clave => $valor) {
                if ($clave === '$ref' && is_string($valor)) {
                    $referencias[] = $valor;
                } else {
                    array_push($referencias, ...$this->referencias($valor));
                }
            }
        }

        return $referencias;
    }

    /** Los valores de `codigo` que aparecen en los ejemplos del nodo (no expande `$ref`). @return list<string> */
    private function codigosEn(mixed $nodo): array
    {
        $codigos = [];
        if (is_array($nodo)) {
            foreach ($nodo as $clave => $valor) {
                if ($clave === 'codigo' && is_string($valor)) {
                    $codigos[] = $valor;
                } else {
                    array_push($codigos, ...$this->codigosEn($valor));
                }
            }
        }

        return array_values(array_unique($codigos));
    }

    /**
     * Comprueba que un valor JSON ya decodificado cumple un esquema OpenAPI: tipos, nulos, enumerados, formatos y,
     * en los objetos, que los campos coincidan con los `properties` (ni sobren ni falten) y estén los `required`. Solo entiende el vocabulario que usa
     * openapi.yaml (sin oneOf/anyOf/allOf: un esquema sin `type` falla para que no pase en silencio).
     */
    private function conforme(mixed $valor, array $esquema, string $ruta): void
    {
        $esquema = $this->resolver($esquema);

        if ($valor === null) {
            $this->assertTrue($esquema['nullable'] ?? false, "{$ruta}: el esquema no admite null.");

            return;
        }

        if (isset($esquema['enum'])) {
            $this->assertContains($valor, $esquema['enum'], "{$ruta}: valor fuera del enumerado.");
        }

        switch ($esquema['type'] ?? null) {
            case 'object':
                $this->assertIsArray($valor, "{$ruta}: se esperaba un objeto.");
                $propiedades = $esquema['properties'] ?? [];
                $sobrantes = array_diff(array_keys($valor), array_keys($propiedades));
                $this->assertSame([], array_values($sobrantes), "{$ruta}: campos que el documento no describe: ".implode(', ', $sobrantes));
                $faltantes = array_diff($esquema['required'] ?? [], array_keys($valor));
                $this->assertSame([], array_values($faltantes), "{$ruta}: faltan campos obligatorios: ".implode(', ', $faltantes));
                // Las respuestas del Gateway siempre traen todos los campos (los vacíos van en null): un campo
                // documentado que la respuesta real no trae también es una desviación.
                $ausentes = array_diff(array_keys($propiedades), array_keys($valor));
                $this->assertSame([], array_values($ausentes), "{$ruta}: campos documentados que la respuesta no trae: ".implode(', ', $ausentes));
                foreach ($valor as $campo => $contenido) {
                    $this->conforme($contenido, $propiedades[$campo], "{$ruta}.{$campo}");
                }

                break;
            case 'array':
                $this->assertIsArray($valor, "{$ruta}: se esperaba una lista.");
                $this->assertTrue(array_is_list($valor), "{$ruta}: se esperaba una lista y es un objeto.");
                foreach ($valor as $indice => $elemento) {
                    $this->conforme($elemento, $esquema['items'], "{$ruta}[{$indice}]");
                }

                break;
            case 'integer':
                $this->assertIsInt($valor, "{$ruta}: se esperaba un entero.");

                break;
            case 'boolean':
                $this->assertIsBool($valor, "{$ruta}: se esperaba un booleano.");

                break;
            case 'string':
                $this->assertIsString($valor, "{$ruta}: se esperaba texto.");
                if (($esquema['format'] ?? null) === 'date-time') {
                    $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $valor, "{$ruta}: fecha ISO 8601.");
                }
                if (($esquema['format'] ?? null) === 'email') {
                    $this->assertNotFalse(filter_var($valor, FILTER_VALIDATE_EMAIL), "{$ruta}: correo.");
                }

                break;
            default:
                $this->fail("{$ruta}: el esquema no declara un `type` que esta prueba entienda.");
        }
    }
}
