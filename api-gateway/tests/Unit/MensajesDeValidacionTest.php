<?php

namespace Tests\Unit;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Validator;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Los mensajes de validación salen en español (lang/es/validation.php, escrito a mano, sin paquetes de traducción):
 * cada regla de Laravel que usa el Gateway tiene su texto, y ninguna deja ver una clave cruda `validation.*`.
 */
class MensajesDeValidacionTest extends TestCase
{
    public function test_el_idioma_de_la_aplicacion_y_el_de_respaldo_son_espanol(): void
    {
        $this->assertSame('es', config('app.locale'));
        $this->assertSame('es', config('app.fallback_locale'));
    }

    /**
     * Valores, reglas y el mensaje exacto de la primera falla del campo `x`.
     *
     * @return array<string, array{array<string, mixed>, string, string}>
     */
    public static function reglasDelGateway(): array
    {
        return [
            'required' => [['x' => null], 'required', 'El campo x es obligatorio.'],
            'string' => [['x' => 5], 'string', 'El campo x debe ser texto.'],
            'email' => [['x' => 'no-es-un-correo'], 'email', 'El campo x debe ser un correo electrónico válido.'],
            'integer' => [['x' => 'abc'], 'integer', 'El campo x debe ser un número entero.'],
            'integer:strict' => [['x' => true], 'integer:strict', 'El campo x debe ser un número entero.'],
            'in' => [['x' => 'quizas'], 'in:true,false', 'El campo x tiene un valor no válido.'],
            'different' => [['x' => 'a', 'y' => 'a'], 'different:y', 'El campo x y y deben ser distintos.'],
            'max de un número' => [['x' => 11], 'integer|max:10', 'El campo x no puede ser mayor que 10.'],
            'max de un texto' => [['x' => str_repeat('a', 11)], 'string|max:10', 'El campo x no puede tener más de 10 caracteres.'],
            'max de un arreglo' => [['x' => [1, 2, 3]], 'array|max:2', 'El campo x no puede tener más de 2 elementos.'],
            'min de un número' => [['x' => 1], 'integer|min:2', 'El campo x debe ser al menos 2.'],
            'min de un texto' => [['x' => 'a'], 'string|min:2', 'El campo x debe tener al menos 2 caracteres.'],
            'min de un arreglo' => [['x' => [1]], 'array|min:2', 'El campo x debe tener al menos 2 elementos.'],
        ];
    }

    /** @param  array<string, mixed>  $datos */
    #[DataProvider('reglasDelGateway')]
    public function test_cada_regla_que_usa_el_gateway_tiene_su_mensaje_en_espanol(array $datos, string $regla, string $esperado): void
    {
        $mensajes = Validator::make($datos, ['x' => $regla])->errors()->get('x');

        $this->assertSame([$esperado], $mensajes);
    }

    public function test_max_y_min_de_un_archivo_tienen_mensaje(): void
    {
        $archivo = UploadedFile::fake()->create('datos.txt', 10);

        $this->assertSame(
            ['El archivo x no puede superar los 5 kilobytes.'],
            Validator::make(['x' => $archivo], ['x' => 'max:5'])->errors()->get('x'),
        );
        $this->assertSame(
            ['El archivo x debe pesar al menos 20 kilobytes.'],
            Validator::make(['x' => $archivo], ['x' => 'min:20'])->errors()->get('x'),
        );
    }

    public function test_los_nombres_de_los_campos_de_contrasena_llevan_tilde_y_eñe(): void
    {
        $mensajes = Validator::make([], [
            'contrasena' => 'required',
            'contrasena_actual' => 'required',
            'contrasena_nueva' => 'required',
            'contrasena_temporal' => 'required',
        ])->errors()->all();

        $this->assertSame([
            'El campo contraseña es obligatorio.',
            'El campo contraseña actual es obligatorio.',
            'El campo contraseña nueva es obligatorio.',
            'El campo contraseña temporal es obligatorio.',
        ], $mensajes);
    }
}
