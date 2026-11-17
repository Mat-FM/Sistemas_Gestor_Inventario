<?php

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Guarda estática de la imagen del cliente web (RNF03, RNF14): lee el Dockerfile y el .dockerignore como TEXTO y los contrasta
 * con el servicio. No necesita Docker: que la imagen construya y arranque como usuario sin privilegios se comprueba a mano
 * (ver «Docker» en el README). Aquí solo se vigila lo que puede desfasarse sin que otra prueba lo note: un secreto horneado
 * en la imagen, un USER por nombre (que Kubernetes rechaza con runAsNonRoot), el modo de depuración encendido o un
 * .dockerignore que deje fuera lo que la aplicación lee en ejecución.
 */
class DockerfileTest extends TestCase
{
    /** Llega al ejecutar el contenedor: no puede ir fijada en la imagen. */
    private const SECRETOS = ['APP_KEY', 'TRUSTED_PROXIES'];

    private static function leer(string $ruta): string
    {
        $contenido = file_get_contents(dirname(__DIR__, 2).'/'.$ruta);
        self::assertNotFalse($contenido, "No se pudo leer {$ruta}.");

        return $contenido;
    }

    /** @return array<string, string> Las variables que fija `ENV` en el Dockerfile. */
    private static function variablesFijadas(): array
    {
        $texto = preg_replace('/\\\\\R/', ' ', self::leer('Dockerfile'));
        $variables = [];
        foreach (preg_split('/\R/', (string) $texto) as $linea) {
            if (preg_match('/^\s*ENV\s+(.+)$/', $linea, $m) === 1) {
                preg_match_all('/([A-Z_]+)=(\S+)/', $m[1], $pares, PREG_SET_ORDER);
                foreach ($pares as [, $nombre, $valor]) {
                    $variables[$nombre] = $valor;
                }
            }
        }

        return $variables;
    }

    /** @return list<string> Las líneas del .dockerignore sin comentarios ni vacías. */
    private static function ignorados(): array
    {
        return array_values(array_filter(array_map('trim', preg_split('/\R/', self::leer('.dockerignore'))), fn ($l) => $l !== '' && ! str_starts_with($l, '#')));
    }

    public function test_corre_como_un_usuario_numerico_sin_privilegios(): void
    {
        $this->assertMatchesRegularExpression('/^USER\s+\d+\s*$/m', self::leer('Dockerfile'), 'USER debe ser un UID numérico: con runAsNonRoot Kubernetes rechaza un nombre.');
        $this->assertDoesNotMatchRegularExpression('/^USER\s+(root|0)\s*$/mi', self::leer('Dockerfile'));
    }

    public function test_la_imagen_viene_en_modo_produccion_sin_depuracion_y_con_el_registro_en_json(): void
    {
        $variables = self::variablesFijadas();

        $this->assertSame('production', $variables['APP_ENV'] ?? null);
        $this->assertSame('false', $variables['APP_DEBUG'] ?? null);
        $this->assertSame('json_stderr', $variables['LOG_CHANNEL'] ?? null);
    }

    public function test_ningun_secreto_ni_el_env_va_dentro_de_la_imagen(): void
    {
        $variables = self::variablesFijadas();
        foreach (self::SECRETOS as $nombre) {
            $this->assertArrayNotHasKey($nombre, $variables, "{$nombre} llega al ejecutar el contenedor; no se fija en la imagen.");
        }
        $this->assertDoesNotMatchRegularExpression('/^COPY\s+.*\.env(?!\.example)\b/mi', self::leer('Dockerfile'));
        $ignorados = self::ignorados();
        $this->assertContains('.env', $ignorados);
        $this->assertContains('.env.*', $ignorados);
    }

    public function test_sin_base_de_datos_y_con_la_sesion_en_cookie_igual_que_el_ejemplo_de_entorno(): void
    {
        $variables = self::variablesFijadas();
        $ejemplo = [];
        foreach (preg_split('/\R/', self::leer('.env.example')) as $linea) {
            if (! str_starts_with($linea, '#') && str_contains($linea, '=')) {
                [$clave, $valor] = explode('=', $linea, 2);
                $ejemplo[$clave] = $valor;
            }
        }

        foreach (['SESSION_DRIVER', 'SESSION_LIFETIME', 'SESSION_ENCRYPT', 'CACHE_STORE', 'QUEUE_CONNECTION', 'DB_CONNECTION', 'APP_TIMEZONE', 'LOG_CHANNEL'] as $nombre) {
            $this->assertSame($ejemplo[$nombre], $variables[$nombre] ?? null, "{$nombre} de la imagen debe coincidir con el .env.example.");
        }
        $this->assertSame('cookie', $variables['SESSION_DRIVER']);
        $this->assertStringContainsString('API_GATEWAY_URL', self::leer('Dockerfile'));
    }

    public function test_el_dockerignore_no_deja_fuera_lo_que_la_aplicacion_lee_en_ejecucion(): void
    {
        $ignorados = self::ignorados();

        foreach (['app', 'bootstrap', 'config', 'public', 'resources', 'routes', 'artisan', 'composer.json', 'composer.lock', 'public/vendor', 'public/css', 'public/js'] as $necesario) {
            $this->assertNotContains($necesario, $ignorados, "{$necesario} lo lee la imagen en ejecución o al construir.");
        }
        $this->assertContains('vendor', $ignorados, 'vendor se instala dentro de la imagen, sin los paquetes de desarrollo.');
        foreach (['public/vendor/bootstrap/bootstrap.min.css', 'public/css/app.css', 'public/js/app.js', 'resources/views/layouts/app.blade.php'] as $archivo) {
            $this->assertFileExists(dirname(__DIR__, 2).'/'.$archivo);
        }
    }

    public function test_apache_escucha_en_un_puerto_sin_privilegios_y_la_salud_no_depende_del_gateway(): void
    {
        $dockerfile = self::leer('Dockerfile');

        $this->assertStringContainsString('PORT=8000', $dockerfile);
        $this->assertStringContainsString('Listen ${PORT}', $dockerfile);
        $this->assertMatchesRegularExpression('/HEALTHCHECK.*\/up/s', $dockerfile, 'la sonda usa /up, que no consulta al Gateway');
        $this->assertSame(1, preg_match('/^EXPOSE\s+8000\s*$/m', $dockerfile));
    }
}
