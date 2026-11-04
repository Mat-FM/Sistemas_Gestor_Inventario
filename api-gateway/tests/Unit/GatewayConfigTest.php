<?php

namespace Tests\Unit;

use Dotenv\Dotenv;
use Tests\TestCase;

/**
 * config/gateway.php es el contrato que consumen el proxy, el mapa de rutas y los limitadores.
 */
class GatewayConfigTest extends TestCase
{
    public function test_los_seis_servicios_se_nombran_como_en_el_mapa_de_rutas_y_salen_del_entorno(): void
    {
        // Los valores vienen de phpunit.xml (variables de entorno), no de un literal del código.
        $this->assertSame([
            'ms-catalogo' => 'http://ms-catalogo:8000',
            'ms-proveedores' => 'http://ms-proveedores:8000',
            'ms-inventario' => 'http://ms-inventario:3000',
            'ms-compras' => 'http://ms-compras:3000',
            'ms-notificaciones' => 'http://ms-notificaciones:5000',
            'ms-reportes' => 'http://ms-reportes:5000',
        ], config('gateway.services'));
    }

    public function test_la_url_de_un_servicio_se_toma_de_su_variable_de_entorno_y_no_de_un_literal(): void
    {
        $env = $_ENV['MS_REPORTES_URL'] ?? null;
        $server = $_SERVER['MS_REPORTES_URL'] ?? null;

        try {
            $_ENV['MS_REPORTES_URL'] = $_SERVER['MS_REPORTES_URL'] = 'http://reportes.interno:9999';

            $recargada = require config_path('gateway.php');

            $this->assertSame('http://reportes.interno:9999', $recargada['services']['ms-reportes']);
        } finally {
            $env === null ? $this->quitar($_ENV) : $_ENV['MS_REPORTES_URL'] = $env;
            $server === null ? $this->quitar($_SERVER) : $_SERVER['MS_REPORTES_URL'] = $server;
        }
    }

    /** @param  array<string, mixed>  $superglobal */
    private function quitar(array &$superglobal): void
    {
        unset($superglobal['MS_REPORTES_URL']);
    }

    public function test_cada_llamada_a_un_servicio_espera_como_maximo_3_segundos(): void
    {
        $this->assertSame(3, config('gateway.timeout_seconds'));
    }

    public function test_los_limites_de_peticiones_son_los_del_rnf19(): void
    {
        $this->assertSame(['por_usuario' => 100, 'login_por_ip' => 10], config('gateway.rate_limit'));
    }

    public function test_la_sesion_dura_60_minutos_y_el_secreto_sale_del_entorno(): void
    {
        $this->assertSame(60, config('gateway.jwt.ttl_minutes'));
        $this->assertSame('secreto-de-pruebas-con-mas-de-32-caracteres', config('gateway.jwt.secret'));
    }

    public function test_env_example_deja_vacios_los_secretos_que_se_deben_generar_y_no_trae_valores_de_ejemplo_que_fallen(): void
    {
        $contenido = file_get_contents(base_path('.env.example'));
        $variables = Dotenv::parse($contenido);

        // Un secreto de ejemplo corto (p. ej. «change_me») haría fallar a JwtService al primer uso.
        $this->assertArrayHasKey('JWT_SECRET', $variables);
        $this->assertSame('', $variables['JWT_SECRET']);
        $this->assertStringContainsString('openssl rand -base64 48', $contenido);

        // El primer administrador no tiene valores de ejemplo: la contraseña debe elegirla quien instala.
        $this->assertArrayHasKey('ADMIN_EMAIL', $variables);
        $this->assertSame('', $variables['ADMIN_EMAIL']);
        $this->assertArrayHasKey('ADMIN_PASSWORD', $variables);
        $this->assertSame('', $variables['ADMIN_PASSWORD']);

        // Único valor de ejemplo permitido: la contraseña de la base de datos local, que coincide con la del
        // docker-compose.yml de la raíz y por eso funciona tal cual.
        $this->assertSame(['DB_PASSWORD'], array_keys(array_filter($variables, fn (string $valor): bool => $valor === 'change_me')));
    }

    public function test_el_primer_administrador_sigue_en_la_configuracion(): void
    {
        $this->assertArrayHasKey('correo', config('gateway.admin'));
        $this->assertArrayHasKey('contrasena', config('gateway.admin'));
    }

    public function test_los_proxies_de_confianza_salen_de_trusted_proxies_y_vacia_no_se_confia_en_ninguno(): void
    {
        // phpunit.xml la fija vacía; sin variable, el valor por defecto también es vacío (no confiar en nadie).
        $this->assertSame('', config('gateway.trusted_proxies'));

        $env = $_ENV['TRUSTED_PROXIES'] ?? null;
        $server = $_SERVER['TRUSTED_PROXIES'] ?? null;

        try {
            $_ENV['TRUSTED_PROXIES'] = $_SERVER['TRUSTED_PROXIES'] = '10.0.0.0/8';
            $this->assertSame('10.0.0.0/8', (require config_path('gateway.php'))['trusted_proxies']);

            unset($_ENV['TRUSTED_PROXIES'], $_SERVER['TRUSTED_PROXIES']);
            putenv('TRUSTED_PROXIES');
            $this->assertSame('', (require config_path('gateway.php'))['trusted_proxies']);
        } finally {
            $env === null ? $this->quitarVariable($_ENV, 'TRUSTED_PROXIES') : $_ENV['TRUSTED_PROXIES'] = $env;
            $server === null ? $this->quitarVariable($_SERVER, 'TRUSTED_PROXIES') : $_SERVER['TRUSTED_PROXIES'] = $server;
        }
    }

    public function test_env_example_trae_trusted_proxies_vacia_con_su_comentario(): void
    {
        $ejemplo = (string) file_get_contents(base_path('.env.example'));

        $this->assertMatchesRegularExpression('/^TRUSTED_PROXIES=$/m', $ejemplo);

        // El bloque de comentarios justo encima explica el formato, el valor vacío y el rechazo de «*».
        $this->assertSame(1, preg_match('/((?:^#.*\n)+)TRUSTED_PROXIES=/m', $ejemplo, $m));
        foreach (['CIDR', 'comas', 'vacía', '«*»', 'X-Forwarded-For'] as $texto) {
            $this->assertStringContainsString($texto, $m[1]);
        }
    }

    /** @param  array<string, mixed>  $superglobal */
    private function quitarVariable(array &$superglobal, string $nombre): void
    {
        unset($superglobal[$nombre]);
    }
}
