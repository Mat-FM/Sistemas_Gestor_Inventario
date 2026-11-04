<?php

namespace Tests\Unit;

use App\Exceptions\ApiException;
use App\Models\Rol;
use App\Models\Usuario;
use App\Services\Jwt\JwtService;
use Firebase\JWT\JWT;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use LogicException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * El servicio no toca la base de datos y esta clase no la migra: cualquier consulta fallaría en voz alta.
 *
 * Los tokens hostiles se arman a mano (base64url + hash_hmac), nunca con el servicio ni con JWT::encode, y cada
 * uno cambia una sola cosa respecto al token de control, que sí es válido. Así un rechazo no puede deberse a que
 * el token estuviera vencido o incompleto por otra causa.
 */
class JwtServiceTest extends TestCase
{
    private const SECRETO = 'secreto-falso-solo-para-pruebas-del-servicio-jwt';

    private const OTRO_SECRETO = 'otro-secreto-falso-distinto-del-anterior-0123456789';

    /** Instante fijo (2033-05-18T03:33:20Z), lejos del reloj real para que ninguna prueba dependa de él. */
    private const AHORA = 2000000000;

    private JwtService $jwt;

    protected function setUp(): void
    {
        parent::setUp();

        // Secreto y vigencia explícitos: un JWT_TTL_MINUTES local no debe alterar estas pruebas.
        $this->jwt = new JwtService(self::SECRETO, 60);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        JWT::$timestamp = null;
        JWT::$leeway = 0;

        parent::tearDown();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Ayudantes
    // ---------------------------------------------------------------------------------------------------------

    private function usuarioEnMemoria(int $id = 1, string $rol = 'ADMINISTRADOR', ?int $bodega = null): Usuario
    {
        $usuario = (new Usuario)->forceFill(['id_usuario' => $id, 'id_bodega' => $bodega]);
        $usuario->setRelation('rol', new Rol(['nombre' => $rol]));

        return $usuario;
    }

    private function congelarReloj(int $segundos = self::AHORA): void
    {
        Carbon::setTestNow(Carbon::createFromTimestampUTC($segundos));
    }

    private function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private function codificar(mixed $valor): string
    {
        return json_encode($valor, JSON_THROW_ON_ERROR);
    }

    /** @return array<string, mixed> */
    private function cabeceraValida(): array
    {
        return ['typ' => 'JWT', 'alg' => 'HS256'];
    }

    /**
     * Las claims de un token que el servicio aceptaría, con el reloj congelado en AHORA.
     *
     * @return array<string, mixed>
     */
    private function reclamosValidos(): array
    {
        return [
            'sub' => '5',
            'rol' => 'VENDEDOR',
            'id_bodega' => null,
            'iat' => self::AHORA,
            'exp' => self::AHORA + 3600,
            'jti' => 'abcdef0123456789abcdef0123456789',
        ];
    }

    /** Firma una cabecera y un payload ya serializados como JSON (o como cualquier texto) con HMAC. */
    private function armar(string $cabecera, string $payload, string $secreto = self::SECRETO, string $hash = 'sha256'): string
    {
        $entrada = $this->base64Url($cabecera).'.'.$this->base64Url($payload);

        return $entrada.'.'.$this->base64Url(hash_hmac($hash, $entrada, $secreto, true));
    }

    /** @param  array<string, mixed>  $cambios */
    private function controlCon(array $cambios = [], string $secreto = self::SECRETO): string
    {
        return $this->armar($this->codificar($this->cabeceraValida()), $this->codificar(array_merge($this->reclamosValidos(), $cambios)), $secreto);
    }

    /** @param  list<string>  $claves */
    private function controlSin(array $claves): string
    {
        $reclamos = array_diff_key($this->reclamosValidos(), array_flip($claves));

        return $this->armar($this->codificar($this->cabeceraValida()), $this->codificar($reclamos));
    }

    /** @return array{string, string, string} */
    private function partes(string $token): array
    {
        return explode('.', $token);
    }

    /** Exige que el token se rechace con la misma respuesta genérica, sea cual sea la causa. */
    private function assertRechazado(string $token, string $caso): void
    {
        try {
            $this->jwt->verificar($token);
        } catch (ApiException $e) {
            $this->assertSame(401, $e->status, $caso);
            $this->assertSame('NO_AUTENTICADO', $e->codigo, $caso);
            $this->assertSame('No autenticado.', $e->getMessage(), "{$caso}: el mensaje no debe revelar la causa.");
            $this->assertSame([], $e->detalles, $caso);
            $this->assertNull($e->getPrevious(), "{$caso}: no debe encadenar la excepción interna de la biblioteca.");

            return;
        }

        $this->fail("{$caso}: el token no fue rechazado.");
    }

    // ---------------------------------------------------------------------------------------------------------
    // Emisión y verificación
    // ---------------------------------------------------------------------------------------------------------

    public function test_emite_y_verifica_con_las_claims_esperadas(): void
    {
        $r = $this->jwt->emitir($this->usuarioEnMemoria(id: 5, rol: 'OPERADOR_BODEGA', bodega: 3));
        $p = $this->jwt->verificar($r['token']);

        $this->assertSame('5', $p->sub);
        $this->assertSame('OPERADOR_BODEGA', $p->rol);
        $this->assertSame(3, $p->id_bodega);
        $this->assertSame(3600, $p->exp - $p->iat);
        $this->assertSame(3600, $r['expira_en']);
        $this->assertSame(['token', 'expira_en'], array_keys($r));
    }

    public function test_un_usuario_sin_bodega_lleva_id_bodega_nulo_pero_presente(): void
    {
        $p = $this->jwt->verificar($this->jwt->emitir($this->usuarioEnMemoria(rol: 'VENDEDOR'))['token']);

        $this->assertTrue(property_exists($p, 'id_bodega'));
        $this->assertNull($p->id_bodega);
        $this->assertSame('VENDEDOR', $p->rol);
    }

    public function test_el_token_emitido_es_hs256_con_exactamente_estas_claims_y_la_firma_hmac_del_secreto(): void
    {
        $this->congelarReloj();

        $token = $this->jwt->emitir($this->usuarioEnMemoria(id: 9, rol: 'CONTADOR'))['token'];
        [$cabecera, $payload, $firma] = $this->partes($token);

        $this->assertSame(['typ' => 'JWT', 'alg' => 'HS256'], json_decode(base64_decode(strtr($cabecera, '-_', '+/')), true));

        $reclamos = json_decode(base64_decode(strtr($payload, '-_', '+/')), true);
        // Nada más viaja en el token: ni el correo ni la contraseña ni el nombre.
        $this->assertEqualsCanonicalizing(['sub', 'rol', 'id_bodega', 'iat', 'exp', 'jti'], array_keys($reclamos));
        $this->assertSame('9', $reclamos['sub']);
        $this->assertSame(self::AHORA, $reclamos['iat']);
        $this->assertSame(self::AHORA + 3600, $reclamos['exp']);

        // Verificación independiente de la firma: HMAC-SHA256 del secreto, sin pasar por la biblioteca.
        $esperada = $this->base64Url(hash_hmac('sha256', "{$cabecera}.{$payload}", self::SECRETO, true));
        $this->assertSame($esperada, $firma);
    }

    public function test_cada_token_lleva_un_jti_aleatorio_distinto(): void
    {
        $this->congelarReloj();
        $usuario = $this->usuarioEnMemoria();

        $a = $this->jwt->verificar($this->jwt->emitir($usuario)['token']);
        $b = $this->jwt->verificar($this->jwt->emitir($usuario)['token']);

        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $a->jti);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $b->jti);
        $this->assertNotSame($a->jti, $b->jti);
    }

    public function test_la_vigencia_sale_del_constructor(): void
    {
        $jwt = new JwtService(self::SECRETO, 5);
        $this->congelarReloj();

        $r = $jwt->emitir($this->usuarioEnMemoria());
        $p = $jwt->verificar($r['token']);

        $this->assertSame(300, $r['expira_en']);
        $this->assertSame(300, $p->exp - $p->iat);

        $this->congelarReloj(self::AHORA + 301);
        $this->expectException(ApiException::class);
        $jwt->verificar($r['token']);
    }

    public function test_emitir_y_verificar_no_hacen_ninguna_consulta_a_la_base(): void
    {
        DB::enableQueryLog();

        $this->jwt->verificar($this->jwt->emitir($this->usuarioEnMemoria(id: 2, rol: 'OPERADOR_BODEGA', bodega: 1))['token']);

        $this->assertSame([], DB::getQueryLog());
    }

    public function test_emitir_exige_el_rol_ya_cargado_y_no_lo_busca_en_la_base(): void
    {
        $sinRol = (new Usuario)->forceFill(['id_usuario' => 1, 'id_rol' => 1]);

        // Si buscara el rol por su cuenta, esta prueba (sin tablas) fallaría con una QueryException.
        $this->expectException(LogicException::class);
        $this->jwt->emitir($sinRol);
    }

    public function test_emitir_exige_un_usuario_ya_guardado(): void
    {
        $sinId = new Usuario;
        $sinId->setRelation('rol', new Rol(['nombre' => 'VENDEDOR']));

        $this->expectException(LogicException::class);
        $this->jwt->emitir($sinId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Vencimiento (el reloj de la biblioteca es el mismo que el de Carbon: Ruling 16)
    // ---------------------------------------------------------------------------------------------------------

    public function test_token_vencido_a_los_61_minutos_es_401(): void
    {
        $t = $this->jwt->emitir($this->usuarioEnMemoria())['token'];
        Carbon::setTestNow(now()->addMinutes(61));

        $this->assertRechazado($t, 'token vencido');
    }

    public function test_el_mismo_token_vale_a_los_59_minutos_y_vence_a_los_61(): void
    {
        $this->congelarReloj();
        $token = $this->jwt->emitir($this->usuarioEnMemoria(id: 7))['token'];

        $this->congelarReloj(self::AHORA + 59 * 60);
        $this->assertSame('7', $this->jwt->verificar($token)->sub, 'A los 59 minutos todavía debe valer.');

        $this->congelarReloj(self::AHORA + 61 * 60);
        $this->assertRechazado($token, 'a los 61 minutos');
    }

    public function test_el_limite_es_exacto_vale_un_segundo_antes_y_no_vale_en_el_segundo_60(): void
    {
        $this->congelarReloj();
        $token = $this->jwt->emitir($this->usuarioEnMemoria(id: 7))['token'];

        $this->congelarReloj(self::AHORA + 3599);
        $this->assertSame('7', $this->jwt->verificar($token)->sub);

        $this->congelarReloj(self::AHORA + 3600);
        $this->assertRechazado($token, 'en el segundo 3600');
    }

    public function test_con_el_reloj_fijado_en_el_pasado_un_token_recien_emitido_se_acepta(): void
    {
        // La biblioteca lee time(); si el servicio no la sincronizara con Carbon, este token (emitido en 2033
        // según Carbon) se vería como "de otra época" y se rechazaría aunque Carbon diga que está vigente.
        $this->congelarReloj(self::AHORA - 10 * 365 * 24 * 3600);

        $token = $this->jwt->emitir($this->usuarioEnMemoria(id: 3))['token'];

        $this->assertSame('3', $this->jwt->verificar($token)->sub);
    }

    public function test_un_token_con_iat_en_el_futuro_es_401(): void
    {
        $this->congelarReloj();

        $this->assertRechazado($this->controlCon(['iat' => self::AHORA + 60]), 'iat en el futuro');
    }

    public function test_la_holgura_de_la_biblioteca_se_fuerza_a_cero_aunque_otro_codigo_la_haya_cambiado(): void
    {
        JWT::$leeway = 120;
        $this->congelarReloj(self::AHORA + 3600 + 30);

        $this->assertRechazado($this->controlCon(), 'vencido hace 30 s con holgura externa de 120 s');
        // Se deja como estaba: el servicio no cambia el estado global de la biblioteca.
        $this->assertSame(120, JWT::$leeway);
    }

    public function test_no_deja_estado_estatico_colgado_en_la_biblioteca(): void
    {
        $this->congelarReloj();
        $usuario = $this->usuarioEnMemoria();

        $token = $this->jwt->emitir($usuario)['token'];
        $this->assertNull(JWT::$timestamp, 'tras emitir');
        $this->assertSame(0, JWT::$leeway, 'tras emitir');

        $this->jwt->verificar($token);
        $this->assertNull(JWT::$timestamp, 'tras verificar con éxito');
        $this->assertSame(0, JWT::$leeway, 'tras verificar con éxito');

        $this->congelarReloj(self::AHORA + 7200);
        $this->assertRechazado($token, 'vencido');
        $this->assertNull(JWT::$timestamp, 'tras un token vencido');
        $this->assertSame(0, JWT::$leeway, 'tras un token vencido');

        $this->assertRechazado('basura', 'basura');
        $this->assertNull(JWT::$timestamp, 'tras un token mal formado');
    }

    public function test_un_timestamp_estatico_sobrante_no_altera_la_verificacion_y_se_limpia(): void
    {
        JWT::$timestamp = 1;
        $this->congelarReloj();

        $this->assertSame('5', $this->jwt->verificar($this->controlCon())->sub);
        $this->assertNull(JWT::$timestamp);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Tokens hostiles
    // ---------------------------------------------------------------------------------------------------------

    public function test_el_token_de_control_armado_a_mano_es_valido(): void
    {
        $this->congelarReloj();

        $p = $this->jwt->verificar($this->controlCon());

        $this->assertSame('5', $p->sub);
        $this->assertSame('VENDEDOR', $p->rol);
        $this->assertNull($p->id_bodega);
        $this->assertSame(self::AHORA + 3600, $p->exp);
    }

    /** @return array<string, array{string}> */
    public static function tokensHostiles(): array
    {
        return [
            'payload alterado (rol → ADMINISTRADOR) con la firma original' => ['payload_alterado'],
            'firma alterada (primer carácter distinto)' => ['firma_alterada'],
            'firma truncada' => ['firma_truncada'],
            'firmado con otro secreto' => ['otro_secreto'],
            'alg none sin firma' => ['alg_none_sin_firma'],
            'alg none con la firma del token legítimo' => ['alg_none_con_firma'],
            'alg NONE en mayúsculas sin firma' => ['alg_NONE_sin_firma'],
            'alg HS256 con la firma eliminada' => ['hs256_sin_firma'],
            'HS384 con el mismo secreto' => ['hs384'],
            'HS512 con el mismo secreto' => ['hs512'],
            'alg en minúsculas (hs256)' => ['alg_minusculas'],
            'alg ausente' => ['alg_ausente'],
            'alg nulo' => ['alg_nulo'],
            'alg como lista' => ['alg_lista'],
            'alg RS256 con el secreto como si fuera una clave pública' => ['rs256'],
        ];
    }

    #[DataProvider('tokensHostiles')]
    public function test_firma_alterada_otro_secreto_alg_none_y_otro_algoritmo_son_401(string $caso): void
    {
        $this->congelarReloj();
        $control = $this->controlCon();
        [$cabecera, $cuerpo, $firma] = $this->partes($control);
        $reclamosHostiles = $this->codificar(array_merge($this->reclamosValidos(), ['rol' => 'ADMINISTRADOR']));
        $reclamos = $this->codificar($this->reclamosValidos());

        // Se comprueba el control en cada caso: lo único que cambia es lo que el caso describe.
        $this->assertSame('5', $this->jwt->verificar($control)->sub);

        $token = match ($caso) {
            'payload_alterado' => $cabecera.'.'.$this->base64Url($reclamosHostiles).'.'.$firma,
            'firma_alterada' => $cabecera.'.'.$cuerpo.'.'.($firma[0] === 'A' ? 'B' : 'A').substr($firma, 1),
            'firma_truncada' => substr($control, 0, -10),
            'otro_secreto' => $this->controlCon(secreto: self::OTRO_SECRETO),
            'alg_none_sin_firma' => $this->base64Url($this->codificar(['typ' => 'JWT', 'alg' => 'none'])).'.'.$this->base64Url($reclamos).'.',
            'alg_none_con_firma' => $this->base64Url($this->codificar(['typ' => 'JWT', 'alg' => 'none'])).'.'.$this->base64Url($reclamos).'.'.$firma,
            'alg_NONE_sin_firma' => $this->base64Url($this->codificar(['typ' => 'JWT', 'alg' => 'NONE'])).'.'.$this->base64Url($reclamos).'.',
            'hs256_sin_firma' => $cabecera.'.'.$cuerpo.'.',
            'hs384' => $this->armar($this->codificar(['typ' => 'JWT', 'alg' => 'HS384']), $reclamos, hash: 'sha384'),
            'hs512' => $this->armar($this->codificar(['typ' => 'JWT', 'alg' => 'HS512']), $reclamos, hash: 'sha512'),
            'alg_minusculas' => $this->armar($this->codificar(['typ' => 'JWT', 'alg' => 'hs256']), $reclamos),
            'alg_ausente' => $this->armar($this->codificar(['typ' => 'JWT']), $reclamos),
            'alg_nulo' => $this->armar($this->codificar(['typ' => 'JWT', 'alg' => null]), $reclamos),
            'alg_lista' => $this->armar($this->codificar(['typ' => 'JWT', 'alg' => ['HS256']]), $reclamos),
            'rs256' => $this->armar($this->codificar(['typ' => 'JWT', 'alg' => 'RS256']), $reclamos),
        };

        $this->assertNotSame($control, $token, 'El token hostil debe diferir del de control.');
        $this->assertRechazado($token, $caso);
    }

    /** @return array<string, array{string}> */
    public static function tokensMalFormados(): array
    {
        return [
            'vacío' => [''],
            'solo espacios' => ['   '],
            'una palabra' => ['abc'],
            'dos segmentos' => ['a.b'],
            'tres segmentos vacíos' => ['..'],
            'tres segmentos cualquiera' => ['a.b.c'],
            'cuatro segmentos' => ['a.b.c.d'],
            'un punto' => ['.'],
            'base64 inválido' => ['!!!.@@@.###'],
            'con byte nulo' => ["a\0b.c.d"],
            'con prefijo Bearer' => ['Bearer abc.def.ghi'],
            'token válido con un cuarto segmento' => ['valido_cuatro_segmentos'],
            'token válido sin la firma (dos segmentos)' => ['valido_sin_firma'],
            'cabecera que no es JSON' => ['cabecera_no_json'],
            'cabecera lista vacía' => ['cabecera_lista'],
            'cabecera escalar' => ['cabecera_escalar'],
            'payload que no es JSON' => ['payload_no_json'],
            'payload escalar' => ['payload_escalar'],
            'payload lista' => ['payload_lista'],
            'payload nulo' => ['payload_nulo'],
        ];
    }

    #[DataProvider('tokensMalFormados')]
    public function test_basura_vacio_y_formatos_incompletos_son_401(string $crudo): void
    {
        $this->congelarReloj();
        $control = $this->controlCon();
        $this->assertSame('5', $this->jwt->verificar($control)->sub);
        $reclamos = $this->codificar($this->reclamosValidos());

        $token = match ($crudo) {
            'valido_cuatro_segmentos' => $control.'.x',
            'valido_sin_firma' => implode('.', array_slice($this->partes($control), 0, 2)),
            'cabecera_no_json' => $this->armar('esto no es json', $reclamos),
            'cabecera_lista' => $this->armar('[]', $reclamos),
            'cabecera_escalar' => $this->armar('"HS256"', $reclamos),
            'payload_no_json' => $this->armar($this->codificar($this->cabeceraValida()), 'esto no es json'),
            'payload_escalar' => $this->armar($this->codificar($this->cabeceraValida()), '"hola"'),
            'payload_lista' => $this->armar($this->codificar($this->cabeceraValida()), '[]'),
            'payload_nulo' => $this->armar($this->codificar($this->cabeceraValida()), 'null'),
            default => $crudo,
        };

        $this->assertRechazado($token, $crudo === '' ? '(vacío)' : $crudo);
    }

    /** @return array<string, array{string}> */
    public static function tokensBienFirmadosPeroIncompletos(): array
    {
        return [
            'sin exp' => ['sin_exp'],
            'exp como texto' => ['exp_texto'],
            'exp decimal' => ['exp_decimal'],
            'sin sub' => ['sin_sub'],
            'sub vacío' => ['sub_vacio'],
            'sub numérico en vez de texto' => ['sub_numerico'],
            'sub con un objeto' => ['sub_objeto'],
            'sin rol' => ['sin_rol'],
            'rol que no es texto' => ['rol_numerico'],
            'sin iat' => ['sin_iat'],
            'sin id_bodega' => ['sin_id_bodega'],
            'id_bodega como texto' => ['id_bodega_texto'],
            'nbf en el futuro' => ['nbf_futuro'],
        ];
    }

    #[DataProvider('tokensBienFirmadosPeroIncompletos')]
    public function test_un_token_bien_firmado_pero_con_claims_incompletas_o_de_otro_tipo_es_401(string $caso): void
    {
        $this->congelarReloj();

        $token = match ($caso) {
            'sin_exp' => $this->controlSin(['exp']),
            'exp_texto' => $this->controlCon(['exp' => (string) (self::AHORA + 3600)]),
            'exp_decimal' => $this->controlCon(['exp' => self::AHORA + 3600.5]),
            'sin_sub' => $this->controlSin(['sub']),
            'sub_vacio' => $this->controlCon(['sub' => '']),
            'sub_numerico' => $this->controlCon(['sub' => 5]),
            'sub_objeto' => $this->controlCon(['sub' => ['id' => 5]]),
            'sin_rol' => $this->controlSin(['rol']),
            'rol_numerico' => $this->controlCon(['rol' => 1]),
            'sin_iat' => $this->controlSin(['iat']),
            'sin_id_bodega' => $this->controlSin(['id_bodega']),
            'id_bodega_texto' => $this->controlCon(['id_bodega' => '3']),
            'nbf_futuro' => $this->controlCon(['nbf' => self::AHORA + 60]),
        };

        $this->assertRechazado($token, $caso);
    }

    public function test_un_token_sin_exp_se_rechaza_aunque_el_reloj_avance_un_siglo(): void
    {
        $this->congelarReloj(self::AHORA + 100 * 365 * 24 * 3600);

        // La biblioteca solo valida exp si existe; el servicio debe exigirla.
        $this->assertRechazado($this->controlSin(['exp']), 'sin exp, un siglo después');
    }

    // ---------------------------------------------------------------------------------------------------------
    // Construcción y contenedor
    // ---------------------------------------------------------------------------------------------------------

    public function test_secreto_corto_se_rechaza_al_construir(): void
    {
        $this->expectException(InvalidArgumentException::class);
        new JwtService('corto');
    }

    public function test_el_limite_del_secreto_es_32_caracteres(): void
    {
        $this->assertInstanceOf(JwtService::class, new JwtService(str_repeat('a', 32)));

        $this->expectException(InvalidArgumentException::class);
        new JwtService(str_repeat('a', 31));
    }

    public function test_el_mensaje_de_error_del_secreto_no_lo_repite_y_el_vacio_tambien_se_rechaza(): void
    {
        try {
            new JwtService('corto-pero-secreto');
            $this->fail('Debía rechazar el secreto corto.');
        } catch (InvalidArgumentException $e) {
            $this->assertStringNotContainsString('corto-pero-secreto', $e->getMessage());
        }

        $this->expectException(InvalidArgumentException::class);
        new JwtService('');
    }

    /** @return array<string, array{int}> */
    public static function vigenciasNoValidas(): array
    {
        return ['cero' => [0], 'negativa' => [-5]];
    }

    #[DataProvider('vigenciasNoValidas')]
    public function test_una_vigencia_menor_de_un_minuto_se_rechaza_al_construir(int $minutos): void
    {
        $this->expectException(InvalidArgumentException::class);
        new JwtService(self::SECRETO, $minutos);
    }

    public function test_el_contenedor_entrega_el_servicio_configurado_con_gateway_jwt(): void
    {
        $servicio = $this->app->make(JwtService::class);

        $this->assertSame($servicio, $this->app->make(JwtService::class), 'Debe ser un único servicio por aplicación.');

        // El secreto de config('gateway.jwt') es el de phpunit.xml: un token firmado a mano con él debe valer...
        $this->congelarReloj();
        $manual = $this->armar($this->codificar($this->cabeceraValida()), $this->codificar($this->reclamosValidos()), (string) config('gateway.jwt.secret'));
        $this->assertSame('5', $servicio->verificar($manual)->sub);

        // ...y la vigencia es la configurada.
        $this->assertSame(config('gateway.jwt.ttl_minutes') * 60, $servicio->emitir($this->usuarioEnMemoria())['expira_en']);
    }

    public function test_sin_secreto_configurado_el_contenedor_falla_con_invalid_argument_y_no_con_type_error(): void
    {
        config(['gateway.jwt.secret' => null]);

        $this->expectException(InvalidArgumentException::class);
        $this->app->make(JwtService::class);
    }
}
