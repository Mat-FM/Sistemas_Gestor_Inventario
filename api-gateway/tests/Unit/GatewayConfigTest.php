<?php

namespace Tests\Unit;

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

    public function test_el_primer_administrador_sigue_en_la_configuracion(): void
    {
        $this->assertArrayHasKey('correo', config('gateway.admin'));
        $this->assertArrayHasKey('contrasena', config('gateway.admin'));
    }
}
