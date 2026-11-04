<?php

namespace Tests\Unit;

use App\Rules\ContrasenaValida;
use Illuminate\Support\Facades\Validator;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class ContrasenaValidaTest extends TestCase
{
    /** @return array<string, array{mixed}> */
    public static function validas(): array
    {
        return [
            'el mínimo: 8 caracteres' => ['abcdefg1'],
            'mayúsculas y minúsculas' => ['Clave1234'],
            'con acentos y eñe' => ['ñandú2026'],
            'con espacios y símbolos' => ['mi clave 2 !'],
            'el número al inicio' => ['1abcdefg'],
            'exactamente 72 bytes' => [str_repeat('a', 71).'1'],
        ];
    }

    /** @return array<string, array{mixed}> */
    public static function invalidas(): array
    {
        return [
            'vacía' => [''],
            'corta, con letra y número' => ['corta1'],
            'siete caracteres' => ['abcdef1'],
            'solo letras' => ['sololetras'],
            'solo números' => ['12345678'],
            'solo símbolos' => ['!!!!!!!!'],
            'ocho caracteres sin número' => ['abcdefgh'],
            'más de 72 bytes (bcrypt truncaría el resto)' => [str_repeat('a', 72).'1'],
            'no es texto: número' => [12345678],
            'no es texto: arreglo' => [['abcdefg1']],
            'no es texto: nulo' => [null],
            'no es texto: booleano' => [true],
        ];
    }

    #[DataProvider('validas')]
    public function test_acepta_las_contrasenas_que_cumplen_d4(mixed $valor): void
    {
        $fallos = [];
        (new ContrasenaValida)->validate('contrasena', $valor, function (string $mensaje) use (&$fallos): void {
            $fallos[] = $mensaje;
        });

        $this->assertSame([], $fallos);
    }

    #[DataProvider('invalidas')]
    public function test_rechaza_las_contrasenas_que_no_cumplen_d4(mixed $valor): void
    {
        $fallos = [];
        (new ContrasenaValida)->validate('contrasena', $valor, function (string $mensaje) use (&$fallos): void {
            $fallos[] = $mensaje;
        });

        $this->assertSame([ContrasenaValida::MENSAJE], $fallos);
    }

    public function test_el_mensaje_esta_en_espanol_y_no_depende_del_nombre_del_campo(): void
    {
        $this->assertSame(
            'La contraseña debe tener al menos 8 caracteres, una letra y un número, y no superar los 72 bytes.',
            ContrasenaValida::MENSAJE,
        );
    }

    public function test_el_mensaje_nunca_incluye_el_valor_rechazado(): void
    {
        $validador = Validator::make(['contrasena_nueva' => 'sololetras'], ['contrasena_nueva' => [new ContrasenaValida]]);

        $this->assertTrue($validador->fails());
        $mensaje = $validador->errors()->first('contrasena_nueva');
        $this->assertSame(ContrasenaValida::MENSAJE, $mensaje);
        $this->assertStringNotContainsString('sololetras', $mensaje);
    }

    public function test_funciona_como_regla_de_validacion_de_laravel_con_cualquier_nombre_de_campo(): void
    {
        $ok = Validator::make(['contrasena_temporal' => 'Temporal123'], ['contrasena_temporal' => ['required', new ContrasenaValida]]);
        $mal = Validator::make(['contrasena_temporal' => 'corta1'], ['contrasena_temporal' => ['required', new ContrasenaValida]]);

        $this->assertTrue($ok->passes());
        $this->assertSame(['contrasena_temporal'], array_keys($mal->errors()->toArray()));
    }
}
