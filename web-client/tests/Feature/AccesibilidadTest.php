<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Lo mínimo para usar el cliente web con teclado y lector de pantalla (WCAG 2.1 AA): saltar la barra lateral, saber en qué
 * sección se está y que cada navegación tenga nombre.
 */
class AccesibilidadTest extends TestCase
{
    private function pantalla(string $ruta, string $rol = 'ADMINISTRADOR'): string
    {
        $this->fingirGateway([
            'GET productos' => self::listado([]),
            'GET bodegas' => self::bodegas(),
            'GET notificaciones' => self::listado([], 0),
        ]);

        return $this->conSesion($rol)->get($ruta)->assertOk()->getContent();
    }

    public function test_hay_un_enlace_para_saltar_la_navegacion_que_lleva_al_contenido(): void
    {
        $html = $this->pantalla('/stock');

        $this->assertMatchesRegularExpression('/<a class="saltar" href="#contenido">Saltar al contenido<\/a>/', $html);
        $this->assertMatchesRegularExpression('/<main class="contenedor" id="contenido" tabindex="-1">/', $html);
        // El enlace es lo primero que recibe el foco: va antes de la barra lateral.
        $this->assertLessThan(strpos($html, 'class="lateral'), strpos($html, 'class="saltar"'));
    }

    public function test_la_seccion_actual_se_marca_con_aria_current_solo_una_vez_en_cada_menu(): void
    {
        $html = $this->pantalla('/stock');

        // Una vez en la barra lateral y otra en el menú inferior (el celular), nunca en otra sección.
        $this->assertSame(2, substr_count($html, 'aria-current="page"'));
        $this->assertMatchesRegularExpression('/<a class="enlace activo" href="[^"]*\/stock" aria-current="page">/', $html);
    }

    public function test_las_dos_navegaciones_tienen_nombre_distinto(): void
    {
        $html = $this->pantalla('/stock');

        $this->assertStringContainsString('<nav aria-label="Secciones" class="d-flex flex-column gap-1 overflow-auto">', $html);
        $this->assertStringContainsString('<nav class="menu-inferior d-md-none" aria-label="Menú principal">', $html);
    }

    public function test_el_acceso_no_trae_el_enlace_de_salto_porque_no_tiene_menu(): void
    {
        Http::fake();

        $this->get('/login')->assertOk()->assertDontSee('Saltar al contenido');
    }
}
