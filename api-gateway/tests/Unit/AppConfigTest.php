<?php

namespace Tests\Unit;

use Tests\TestCase;

/**
 * config/app.php: el idioma por defecto del Gateway es el español (mensajes de validación y errores, T7).
 */
class AppConfigTest extends TestCase
{
    private const VARIABLES = ['APP_LOCALE', 'APP_FALLBACK_LOCALE'];

    public function test_sin_variables_de_entorno_el_idioma_y_el_idioma_de_respaldo_son_es(): void
    {
        // phpunit.xml fija APP_LOCALE y APP_FALLBACK_LOCALE en «es»; para ver el valor por defecto del archivo
        // se quitan de todos los lugares donde env() las busca y se restauran al terminar.
        $respaldo = $this->quitarVariables();

        try {
            $this->assertNull(env('APP_LOCALE'), 'APP_LOCALE debía quedar sin definir para esta prueba.');
            $this->assertNull(env('APP_FALLBACK_LOCALE'), 'APP_FALLBACK_LOCALE debía quedar sin definir para esta prueba.');

            $configuracion = require config_path('app.php');

            $this->assertSame('es', $configuracion['locale']);
            $this->assertSame('es', $configuracion['fallback_locale']);
        } finally {
            $this->restaurarVariables($respaldo);
        }
    }

    public function test_el_idioma_se_puede_cambiar_con_las_variables_de_entorno(): void
    {
        $respaldo = $this->quitarVariables();

        try {
            foreach (self::VARIABLES as $nombre) {
                $_ENV[$nombre] = $_SERVER[$nombre] = 'en';
                putenv("{$nombre}=en");
            }

            $configuracion = require config_path('app.php');

            $this->assertSame('en', $configuracion['locale']);
            $this->assertSame('en', $configuracion['fallback_locale']);
        } finally {
            $this->quitarVariables();
            $this->restaurarVariables($respaldo);
        }
    }

    /**
     * @return array<string, array{env: mixed, server: mixed, getenv: string|false}>
     */
    private function quitarVariables(): array
    {
        $respaldo = [];

        foreach (self::VARIABLES as $nombre) {
            $respaldo[$nombre] = [
                'env' => $_ENV[$nombre] ?? null,
                'server' => $_SERVER[$nombre] ?? null,
                'getenv' => getenv($nombre),
            ];

            unset($_ENV[$nombre], $_SERVER[$nombre]);
            putenv($nombre);
        }

        return $respaldo;
    }

    /** @param  array<string, array{env: mixed, server: mixed, getenv: string|false}>  $respaldo */
    private function restaurarVariables(array $respaldo): void
    {
        foreach ($respaldo as $nombre => $valores) {
            if ($valores['env'] !== null) {
                $_ENV[$nombre] = $valores['env'];
            }
            if ($valores['server'] !== null) {
                $_SERVER[$nombre] = $valores['server'];
            }
            if ($valores['getenv'] !== false) {
                putenv("{$nombre}={$valores['getenv']}");
            }
        }
    }
}
