<?php

namespace Tests\Unit;

use FilesystemIterator;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;

/**
 * Guarda estática de la imagen del Gateway (RNF03): lee el `Dockerfile` y el `.dockerignore` como TEXTO y los contrasta con
 * el propio servicio (composer.json, .env.example, el disco y los archivos que el código lee en ejecución). No necesita
 * Docker: que la imagen construya y arranque contra MySQL se comprueba a mano (ver «Docker» en el README). Aquí solo se vigila
 * lo que puede desfasarse sin que ninguna otra prueba lo note, porque las demás corren fuera de la imagen: un `.dockerignore`
 * que deje fuera `openapi.yaml` (/docs respondería 500 solo en la imagen), un CACHE_STORE que no comparta el límite de
 * peticiones entre las copias (RNF05, RNF19) o un secreto horneado en la imagen.
 */
class DockerfileTest extends TestCase
{
    /** Lo que llega al ejecutar el contenedor: no puede ir fijado en la imagen. */
    private const VARIABLES_DE_EJECUCION = [
        'APP_KEY', 'JWT_SECRET', 'DB_HOST', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'ADMIN_EMAIL', 'ADMIN_PASSWORD',
    ];

    private static function raiz(): string
    {
        return dirname(__DIR__, 2);
    }

    private static function leer(string $ruta): string
    {
        $contenido = file_get_contents(self::raiz().'/'.$ruta);
        self::assertNotFalse($contenido, "No se pudo leer {$ruta}.");

        return $contenido;
    }

    /**
     * Las instrucciones del Dockerfile, una por elemento: sin comentarios ni líneas en blanco y con las continuaciones
     * (`\`) ya unidas. `nombre` va en mayúsculas y `argumentos` es el resto de la línea tal cual.
     *
     * @return list<array{nombre: string, argumentos: string}>
     */
    private static function instrucciones(): array
    {
        $resultado = [];
        $acumulada = '';

        foreach ((array) preg_split('/\R/', self::leer('Dockerfile')) as $cruda) {
            $linea = trim((string) $cruda);
            if ($linea === '' || str_starts_with($linea, '#')) {
                continue; // también dentro de una continuación, como hace Docker
            }

            $sigue = str_ends_with($linea, '\\');
            $acumulada = trim($acumulada.' '.($sigue ? substr($linea, 0, -1) : $linea));
            if ($sigue) {
                continue;
            }

            [$nombre, $argumentos] = array_pad((array) preg_split('/\s+/', $acumulada, 2), 2, '');
            $resultado[] = ['nombre' => strtoupper((string) $nombre), 'argumentos' => (string) $argumentos];
            $acumulada = '';
        }

        return $resultado;
    }

    /** @return list<string> los argumentos de cada instrucción de ese tipo, en orden */
    private static function deTipo(string $nombre): array
    {
        return array_values(array_map(
            fn (array $i): string => $i['argumentos'],
            array_filter(self::instrucciones(), fn (array $i): bool => $i['nombre'] === $nombre),
        ));
    }

    /** @return array<string, string> todas las variables que declaran los ENV (`A=1 B=2`) */
    private static function entorno(): array
    {
        $variables = [];
        foreach (self::deTipo('ENV') as $argumentos) {
            preg_match_all('/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)/', $argumentos, $m, PREG_SET_ORDER);
            foreach ($m as [, $nombre, $valor]) {
                $variables[$nombre] = trim($valor, '"');
            }
        }

        return $variables;
    }

    /** El valor de una variable de .env.example (sin comillas). */
    private static function deEnvExample(string $nombre): ?string
    {
        return preg_match('/^'.preg_quote($nombre, '/').'=(.*)$/m', self::leer('.env.example'), $m) === 1 ? trim($m[1], " \t\r\"") : null;
    }

    /** @return list<string> los patrones de .dockerignore, en orden, sin comentarios ni líneas en blanco */
    private static function patronesDeIgnore(): array
    {
        return array_values(array_filter(
            array_map(fn ($l): string => trim((string) $l), (array) preg_split('/\R/', self::leer('.dockerignore'))),
            fn (string $l): bool => $l !== '' && ! str_starts_with($l, '#'),
        ));
    }

    /**
     * Un patrón de .dockerignore como expresión regular. Imita a Docker: los patrones se anclan a la raíz del contexto, `*` y
     * `?` no cruzan `/` y `**` sí cruza directorios (`**` + `/` admite cero carpetas: `**\/.env` también excluye `.env`).
     */
    private static function patronARegex(string $patron): string
    {
        $expresion = '';
        for ($i = 0, $n = strlen($patron); $i < $n; $i++) {
            $c = $patron[$i];
            if ($c === '*' && ($patron[$i + 1] ?? '') === '*') {
                $i++;
                if (($patron[$i + 1] ?? '') === '/') {
                    $i++;
                    $expresion .= '(?:.*/)?';
                } else {
                    $expresion .= '.*';
                }
            } elseif ($c === '*') {
                $expresion .= '[^/]*';
            } elseif ($c === '?') {
                $expresion .= '[^/]';
            } else {
                $expresion .= preg_quote($c, '#');
            }
        }

        return '#^'.$expresion.'$#';
    }

    /**
     * ¿Deja .dockerignore fuera del contexto a `$ruta` (relativa a la raíz del Gateway)? Un patrón excluye la ruta si coincide
     * con ella o con CUALQUIERA de sus carpetas padre (`storage/framework` excluye `storage/framework/views/x.php`); una
     * línea con `!` la vuelve a incluir. Manda la última que coincide.
     */
    private static function estaIgnorada(string $ruta): bool
    {
        $partes = explode('/', $ruta);
        $ancestros = [];
        foreach (array_keys($partes) as $i) {
            $ancestros[] = implode('/', array_slice($partes, 0, $i + 1));
        }

        $ignorada = false;
        foreach (self::patronesDeIgnore() as $linea) {
            $negada = str_starts_with($linea, '!');
            $patron = trim($negada ? substr($linea, 1) : $linea, '/');
            foreach ($ancestros as $ancestro) {
                if (preg_match(self::patronARegex($patron), $ancestro) === 1) {
                    $ignorada = ! $negada;
                    break;
                }
            }
        }

        return $ignorada;
    }

    /** @return list<string> todos los archivos de una carpeta (rutas relativas a la raíz del Gateway, con `/`), dotfiles incluidos */
    private static function archivosDe(string $carpeta): array
    {
        $raiz = self::raiz();
        $archivos = [];
        $recorrido = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("{$raiz}/{$carpeta}", FilesystemIterator::SKIP_DOTS));
        foreach ($recorrido as $archivo) {
            if ($archivo->isFile()) {
                $archivos[] = str_replace('\\', '/', substr($archivo->getPathname(), strlen($raiz) + 1));
            }
        }
        sort($archivos);

        return $archivos;
    }

    /**
     * @param  list<string>  $rutas
     * @return list<string> las que .dockerignore deja fuera
     */
    private static function ignoradas(array $rutas): array
    {
        return array_values(array_filter($rutas, fn (string $r): bool => self::estaIgnorada($r)));
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // Dockerfile
    // ---------------------------------------------------------------------------------------------------------------------

    public function test_parte_de_php_con_apache_en_la_version_que_exige_composer_json(): void
    {
        $desdes = self::deTipo('FROM');
        $this->assertCount(1, $desdes, 'Una sola etapa: no hay nada que copiar de otra.');

        $composer = json_decode(self::leer('composer.json'), true);
        preg_match('/(\d+\.\d+)/', (string) $composer['require']['php'], $minimo);

        $this->assertSame("php:{$minimo[1]}-apache", $desdes[0]);
    }

    public function test_instala_solo_las_dependencias_de_produccion_en_una_capa_anterior_al_codigo(): void
    {
        $todas = self::instrucciones();
        $copiaDelCodigo = array_search('COPY . .', array_map(fn (array $i): string => $i['nombre'].' '.$i['argumentos'], $todas), true);
        $this->assertNotFalse($copiaDelCodigo, 'Falta `COPY . .`.');

        $instalaciones = array_keys(array_filter($todas, fn (array $i): bool => $i['nombre'] === 'RUN' && str_contains($i['argumentos'], 'composer install')));
        $this->assertCount(1, $instalaciones);
        $this->assertLessThan($copiaDelCodigo, $instalaciones[0], 'composer install debe ir antes de copiar el código.');
        $this->assertStringContainsString('--no-dev', $todas[$instalaciones[0]]['argumentos']);

        // Capa de dependencias: antes del composer install solo entran composer.json y composer.lock.
        $antes = array_filter(array_slice($todas, 0, $instalaciones[0]), fn (array $i): bool => $i['nombre'] === 'COPY' && ! str_contains($i['argumentos'], '--from'));
        $this->assertSame(['composer.json composer.lock ./'], array_values(array_map(fn (array $i): string => $i['argumentos'], $antes)));

        // El autoload final también sin dependencias de desarrollo: de lo contrario package:discover las nombraría.
        $dump = array_values(array_filter($todas, fn (array $i): bool => $i['nombre'] === 'RUN' && str_contains($i['argumentos'], 'composer dump-autoload')));
        $this->assertCount(1, $dump);
        $this->assertStringContainsString('--no-dev', $dump[0]['argumentos']);
    }

    public function test_no_corre_como_root_y_nombra_el_usuario_por_su_numero(): void
    {
        $usuarios = self::deTipo('USER');
        $this->assertNotEmpty($usuarios);

        // Por NÚMERO, no por nombre: con `runAsNonRoot: true` el kubelet rechaza una imagen cuyo USER no es numérico.
        $ultimo = end($usuarios);
        $this->assertMatchesRegularExpression('/^[1-9]\d*$/', $ultimo);
        $this->assertNotContains('root', $usuarios);
        $this->assertNotContains('0', $usuarios);
    }

    public function test_no_lleva_secretos_ni_la_configuracion_de_ejecucion_en_la_imagen(): void
    {
        $entorno = self::entorno();
        $this->assertNotEmpty($entorno);

        foreach (self::VARIABLES_DE_EJECUCION as $nombre) {
            $this->assertArrayNotHasKey($nombre, $entorno, "{$nombre} llega al ejecutar el contenedor, no va en la imagen.");
        }

        $this->assertSame([], self::deTipo('ARG'), 'Un ARG de construcción queda en el historial de la imagen.');
        foreach (array_merge(self::deTipo('COPY'), self::deTipo('ADD')) as $argumentos) {
            $this->assertStringNotContainsString('.env', $argumentos, 'La imagen no copia ningún .env.');
        }
    }

    public function test_el_limite_de_peticiones_se_cuenta_en_una_cache_compartida_entre_las_copias(): void
    {
        // Con `file` o `array`, cada copia contaría por su lado y el límite real sería de hasta cuatro veces lo configurado.
        $this->assertSame('database', self::entorno()['CACHE_STORE'] ?? null);
        $this->assertSame('database', self::deEnvExample('CACHE_STORE'));
        $this->assertStringContainsString("'default' => env('CACHE_STORE', 'database')", self::leer('config/cache.php'));
    }

    public function test_fija_el_modo_de_produccion_y_los_valores_del_env_example_que_no_son_secretos(): void
    {
        $entorno = self::entorno();

        $this->assertSame('production', $entorno['APP_ENV'] ?? null);
        $this->assertSame('false', $entorno['APP_DEBUG'] ?? null);
        $this->assertSame('mysql', $entorno['DB_CONNECTION'] ?? null);

        foreach (['LOG_CHANNEL', 'DB_CONNECTION', 'SESSION_DRIVER', 'APP_LOCALE', 'APP_FALLBACK_LOCALE', 'QUEUE_CONNECTION'] as $nombre) {
            $this->assertSame(self::deEnvExample($nombre), $entorno[$nombre] ?? null, "{$nombre} debe coincidir con .env.example.");
        }

        // DB_PORT es la excepción: el .env.example trae el puerto del equipo (3307); la imagen, el de MySQL en la red del clúster.
        $this->assertSame('3306', $entorno['DB_PORT'] ?? null);
    }

    public function test_apache_escucha_en_el_puerto_que_expone_y_la_sonda_consulta_health(): void
    {
        $entorno = self::entorno();
        $this->assertSame([$entorno['PORT'] ?? null], self::deTipo('EXPOSE'));
        $this->assertSame('8000', $entorno['PORT'], 'El Gateway publica el 8000 en el clúster.');

        $sondas = self::deTipo('HEALTHCHECK');
        $this->assertCount(1, $sondas);
        $this->assertMatchesRegularExpression('#http://127\.0\.0\.1:\$\{PORT\}/health(?![\w/])#', $sondas[0]);
    }

    public function test_no_congela_la_configuracion_ni_migra_al_arrancar(): void
    {
        foreach (self::instrucciones() as ['nombre' => $nombre, 'argumentos' => $argumentos]) {
            $this->assertDoesNotMatchRegularExpression('/\b(config|route|view|event):cache\b|artisan optimize\b/', $argumentos, 'La configuración llega al ejecutar el contenedor: cacharla al construir la congelaría vacía.');
            $this->assertNotSame('ENTRYPOINT', $nombre, 'El arranque es el de la imagen base (Apache).');
            $this->assertNotSame('CMD', $nombre, 'El arranque es el de la imagen base (Apache).');
            $this->assertDoesNotMatchRegularExpression('/\b(migrate|db:seed)\b/', $argumentos, 'Las migraciones y el sembrado no corren al construir ni al arrancar: varias copias lo harían a la vez.');
        }
    }

    public function test_crea_las_carpetas_de_storage_que_el_dockerignore_deja_fuera_y_las_entrega_a_www_data(): void
    {
        $ordenes = array_column(array_filter(self::instrucciones(), fn (array $i): bool => $i['nombre'] === 'RUN'), 'argumentos');
        $mkdir = array_values(array_filter($ordenes, fn (string $o): bool => str_contains($o, 'mkdir -p')));
        $this->assertCount(1, $mkdir);

        foreach (['storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/logs'] as $carpeta) {
            $this->assertStringContainsString($carpeta, $mkdir[0]);
            $this->assertTrue(self::estaIgnorada($carpeta.'/x'), "{$carpeta} la crea el Dockerfile: .dockerignore no debe traer la del equipo.");
        }
        $this->assertStringContainsString('chown -R www-data:www-data storage bootstrap/cache', $mkdir[0]);
    }

    // ---------------------------------------------------------------------------------------------------------------------
    // .dockerignore
    // ---------------------------------------------------------------------------------------------------------------------

    /** @return array<string, array{string}> */
    public static function rutasQueNoDebenEntrar(): array
    {
        $rutas = [
            '.env', '.env.production', '.env.example', 'config/.env', 'app/.env.local',
            'database/database.sqlite', 'database/database.sqlite-journal',
            'storage/logs/laravel.log', 'storage/framework/views/abc.php', 'storage/framework/cache/data/x', 'storage/framework/sessions/s',
            'storage/app/private/dato.csv', 'app/laravel.log',
            'bootstrap/cache/packages.php', 'bootstrap/cache/services.php',
            'vendor/autoload.php', 'tests/TestCase.php', 'phpunit.xml', '.phpunit.result.cache', '.phpunit.cache/x',
            'node_modules/x/index.js', 'package.json', '.git/config', 'app/.DS_Store', '.DS_Store',
        ];

        return array_combine($rutas, array_map(fn (string $r): array => [$r], $rutas));
    }

    #[DataProvider('rutasQueNoDebenEntrar')]
    public function test_el_dockerignore_deja_fuera_secretos_y_lo_generado_en_el_equipo(string $ruta): void
    {
        $this->assertTrue(self::estaIgnorada($ruta), "{$ruta} no debe entrar a la imagen.");
    }

    public function test_el_dockerignore_no_excluye_lo_que_el_codigo_lee_en_ejecucion(): void
    {
        // Las rutas que el código nombra con base_path('...') y resource_path('...'): hoy, openapi.yaml y la página de
        // /docs (DocsController), y routes/internal.php (bootstrap/app.php). Sin ellas la imagen arranca pero /docs responde 500.
        $leidas = [];
        foreach (['app', 'bootstrap', 'config', 'database', 'routes'] as $carpeta) {
            foreach (self::archivosDe($carpeta) as $archivo) {
                if (! str_ends_with($archivo, '.php')) {
                    continue;
                }
                preg_match_all("/\b(base_path|resource_path)\(\s*'([^']+)'\s*\)/", self::leer($archivo), $m, PREG_SET_ORDER);
                foreach ($m as [, $funcion, $ruta]) {
                    $leidas[] = $funcion === 'resource_path' ? "resources/{$ruta}" : $ruta;
                }
            }
        }
        $leidas = array_values(array_unique($leidas));

        $this->assertContains('openapi.yaml', $leidas);
        $this->assertContains('resources/docs/swagger-ui.html', $leidas);
        $this->assertSame([], self::ignoradas($leidas), 'La imagen necesita estos archivos en ejecución.');
        foreach ($leidas as $ruta) {
            $this->assertFileExists(self::raiz().'/'.$ruta);
        }
    }

    public function test_el_dockerignore_no_excluye_el_codigo_ni_los_datos_que_la_imagen_necesita(): void
    {
        $necesarios = ['artisan', 'composer.json', 'composer.lock', 'public/.htaccess', 'public/index.php', 'lang/es/validation.php', 'bootstrap/app.php', 'bootstrap/providers.php'];
        foreach (['app', 'config', 'routes', 'lang', 'database/migrations', 'database/seeders'] as $carpeta) {
            $archivos = self::archivosDe($carpeta);
            $this->assertNotEmpty($archivos, "{$carpeta} está vacía.");
            $necesarios = array_merge($necesarios, $archivos);
        }

        foreach ($necesarios as $ruta) {
            $this->assertFileExists(self::raiz().'/'.$ruta);
        }
        $this->assertSame([], self::ignoradas($necesarios), 'La imagen necesita estos archivos.');
    }
}
