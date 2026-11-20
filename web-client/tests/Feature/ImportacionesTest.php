<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ImportacionesTest extends TestCase
{
    private function importacion(int $id = 3, string $estado = 'PROCESADA', array $errores = []): array
    {
        return ['id_importacion' => $id, 'tipo' => 'PRODUCTOS', 'nombre_archivo' => 'productos.csv', 'estado' => $estado,
            'filas_totales' => 10, 'filas_validas' => $estado === 'PROCESADA' ? 10 : 7, 'filas_con_error' => count($errores) ?: ($estado === 'PROCESADA' ? 0 : 3),
            'id_usuario' => 7, 'fecha' => '2026-11-16T15:00:00Z', 'errores' => $errores];
    }

    private function csv(string $contenido = "codigo;nombre\nP1;Café\n", string $nombre = 'productos.csv'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($nombre, $contenido);
    }

    public function test_solo_el_administrador_importa(): void
    {
        $this->fingirGateway([]);

        foreach (['OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'] as $rol) {
            $this->conSesion($rol, 1)->get('/importaciones')->assertForbidden();
            $this->conSesion($rol, 1)->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => $this->csv()])->assertForbidden();
        }
        $this->assertFalse($this->seEnvio('POST', 'importaciones'));
    }

    public function test_mas_enlaza_a_las_importaciones_solo_para_el_administrador(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('ADMINISTRADOR')->get('/administrar')->assertOk()->assertSee(route('importaciones.index'));
        $this->conSesion('OPERADOR_BODEGA', 1)->get('/administrar')->assertForbidden();
    }

    public function test_el_historial_muestra_las_importaciones_y_las_plantillas(): void
    {
        $this->fingirGateway(['GET importaciones' => self::listado([$this->importacion(3), $this->importacion(2, 'CON_ERRORES')])]);

        $this->conSesion('ADMINISTRADOR')->get('/importaciones')->assertOk()
            ->assertSee('productos.csv')->assertSee('Sin errores')->assertSee('Con errores')->assertSee('7 de 10 filas creadas')
            ->assertSee(route('importaciones.plantilla', 'STOCK_INICIAL'));
    }

    public function test_si_el_historial_no_carga_el_formulario_sigue_disponible(): void
    {
        $this->fingirGateway(['GET importaciones' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->get('/importaciones')->assertOk()->assertSee('No pudimos cargar el historial')->assertSee('Subir un archivo');
    }

    public function test_la_plantilla_trae_solo_las_columnas_del_tipo(): void
    {
        $this->fingirGateway([]);

        $r = $this->conSesion('ADMINISTRADOR')->get('/importaciones/plantilla/STOCK_INICIAL')->assertOk()
            ->assertHeader('Content-Disposition', 'attachment; filename="plantilla-stock-inicial.csv"');
        $this->assertSame("\xEF\xBB\xBFcodigo_producto;codigo_bodega;cantidad;codigo_lote;fecha_vencimiento\r\n", $r->getContent());
        $this->conSesion('ADMINISTRADOR')->get('/importaciones/plantilla/OTRA')->assertNotFound();
    }

    public function test_importar_sube_el_archivo_como_multipart_con_el_tipo(): void
    {
        $this->fingirGateway(['POST importaciones' => Http::response($this->importacion(8), 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => $this->csv()])
            ->assertRedirect('/importaciones/8')->assertSessionHas('exito', 'Importación terminada: se crearon 10 filas sin errores.');

        $this->assertTrue($this->seEnvio('POST', 'importaciones', function (Request $p) {
            $partes = collect($p->data())->keyBy('name');

            return $p->isMultipart()
                && str_starts_with($p->header('Content-Type')[0], 'multipart/form-data')
                && $partes['tipo']['contents'] === 'PRODUCTOS'
                && $partes['archivo']['filename'] === 'productos.csv'
                && $partes['archivo']['contents'] === "codigo;nombre\nP1;Café\n"
                && $p->hasHeader('Authorization');
        }));
    }

    public function test_una_importacion_con_errores_avisa_y_lleva_al_detalle(): void
    {
        $this->fingirGateway(['POST importaciones' => Http::response($this->importacion(9, 'CON_ERRORES'), 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => $this->csv()])
            ->assertRedirect('/importaciones/9')->assertSessionHas('aviso');
    }

    public function test_una_importacion_fallida_lo_dice_como_error(): void
    {
        $this->fingirGateway(['POST importaciones' => Http::response($this->importacion(9, 'FALLIDA'), 201)]);

        $this->conSesion('ADMINISTRADOR')->post('/importaciones', ['tipo' => 'STOCK_INICIAL', 'archivo' => $this->csv()])
            ->assertRedirect('/importaciones/9')->assertSessionHas('error');
    }

    public function test_se_valida_el_tipo_y_el_archivo_antes_de_llamar_al_servicio(): void
    {
        $this->fingirGateway([]);

        $this->conSesion('ADMINISTRADOR')->from('/importaciones')->post('/importaciones', ['tipo' => 'OTRO'])->assertSessionHasErrors(['tipo', 'archivo']);
        $this->conSesion('ADMINISTRADOR')->from('/importaciones')->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => $this->csv('x', 'macro.exe')])
            ->assertSessionHasErrors('archivo');
        $this->conSesion('ADMINISTRADOR')->from('/importaciones')->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => UploadedFile::fake()->create('grande.csv', 3000)])
            ->assertSessionHasErrors(['archivo' => 'El archivo pesa más de 2 MB. Divídelo en partes.']);
        $this->assertFalse($this->seEnvio('POST', 'importaciones'));
    }

    public function test_un_archivo_que_pasa_el_limite_del_servidor_web_se_explica_sin_pantalla_tecnica(): void
    {
        $this->fingirGateway([]);
        config(['app.debug' => false]);

        // PHP descarta el cuerpo cuando la petición pasa de post_max_size: llega solo la cabecera de longitud.
        $this->conSesion('ADMINISTRADOR')->call('POST', '/importaciones', [], [], [], ['CONTENT_LENGTH' => '999999999'])
            ->assertStatus(413)->assertSee('El archivo es demasiado grande')->assertSee('2 MB');
        $this->assertFalse($this->seEnvio('POST', 'importaciones'));
    }

    public function test_un_archivo_inutilizable_se_explica_en_el_campo(): void
    {
        $this->fingirGateway(['POST importaciones' => self::error(422, 'DATOS_NO_VALIDOS', 'Faltan columnas: precio')]);

        $this->conSesion('ADMINISTRADOR')->from('/importaciones')->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => $this->csv()])
            ->assertSessionHasErrors(['archivo' => 'Faltan columnas: precio']);
    }

    public function test_si_el_gateway_no_responde_se_manda_al_historial_sin_decir_que_fallo(): void
    {
        $this->fingirGateway(['POST importaciones' => self::error(503, 'SERVICIO_NO_DISPONIBLE')]);

        $this->conSesion('ADMINISTRADOR')->post('/importaciones', ['tipo' => 'PRODUCTOS', 'archivo' => $this->csv()])
            ->assertRedirect('/importaciones')->assertSessionHas('aviso', fn (string $m) => str_contains($m, 'revisa el historial'));
    }

    public function test_el_detalle_lista_los_errores_por_fila(): void
    {
        $this->fingirGateway(['GET importaciones/9' => Http::response($this->importacion(9, 'CON_ERRORES', [
            ['numero_fila' => 0, 'campo' => null, 'mensaje' => 'El archivo no trae la columna precio'],
            ['numero_fila' => 4, 'campo' => 'codigo', 'mensaje' => 'El código ya existe'],
        ]))]);

        $this->conSesion('ADMINISTRADOR')->get('/importaciones/9')->assertOk()
            ->assertSee('Todo el archivo')->assertSee('Fila 4')->assertSee('El código ya existe')->assertSee('Qué corregir')->assertSee('Productos');
    }

    public function test_el_detalle_recorta_los_errores_de_un_archivo_muy_malo(): void
    {
        $errores = array_map(static fn (int $i) => ['numero_fila' => $i + 2, 'campo' => 'precio', 'mensaje' => 'No es un número'], range(0, 249));
        $this->fingirGateway(['GET importaciones/9' => Http::response($this->importacion(9, 'CON_ERRORES', $errores))]);

        $this->conSesion('ADMINISTRADOR')->get('/importaciones/9')->assertOk()->assertSee('Fila 201')->assertDontSee('Fila 202')->assertSee('Y 50 errores más');
    }

    public function test_una_importacion_que_no_existe_es_un_404(): void
    {
        $this->fingirGateway(['GET importaciones/99' => self::error(404, 'NO_EXISTE')]);

        $this->conSesion('ADMINISTRADOR')->get('/importaciones/99')->assertNotFound();
    }
}
