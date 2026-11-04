<?php

namespace Tests\Unit;

use App\Exceptions\ApiException;
use Closure;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class ApiExceptionTest extends TestCase
{
    /** @return array<string, array{Closure, int, string, string}> */
    public static function constructoresConMensajeOpcional(): array
    {
        return [
            'noAutenticado' => [fn (?string $m) => ApiException::noAutenticado($m), 401, 'NO_AUTENTICADO', 'No autenticado.'],
            'sinPermiso' => [fn (?string $m) => ApiException::sinPermiso($m), 403, 'SIN_PERMISO', 'No tiene permiso para realizar esta acción.'],
            'noExiste' => [fn (?string $m) => ApiException::noExiste($m), 404, 'NO_EXISTE', 'El recurso no existe.'],
            'servicioNoDisponible' => [fn (?string $m) => ApiException::servicioNoDisponible($m), 503, 'SERVICIO_NO_DISPONIBLE', 'El servicio no está disponible.'],
        ];
    }

    #[DataProvider('constructoresConMensajeOpcional')]
    public function test_el_constructor_estatico_fija_estado_codigo_y_mensaje_por_defecto(Closure $crear, int $estado, string $codigo, string $mensaje): void
    {
        $e = $crear(null);

        $this->assertSame($estado, $e->status);
        $this->assertSame($codigo, $e->codigo);
        $this->assertSame($mensaje, $e->getMessage());
        $this->assertSame([], $e->detalles);
    }

    #[DataProvider('constructoresConMensajeOpcional')]
    public function test_el_constructor_estatico_acepta_un_mensaje_propio(Closure $crear, int $estado, string $codigo, string $mensajePorDefecto): void
    {
        $e = $crear('Mensaje a medida.');

        $this->assertSame($estado, $e->status);
        $this->assertSame($codigo, $e->codigo);
        $this->assertSame('Mensaje a medida.', $e->getMessage());
        $this->assertNotSame($mensajePorDefecto, $e->getMessage());
    }

    public function test_conflicto_es_409_con_el_codigo_indicado(): void
    {
        $e = ApiException::conflicto('CORREO_DUPLICADO', 'El correo ya existe.');

        $this->assertSame(409, $e->status);
        $this->assertSame('CORREO_DUPLICADO', $e->codigo);
        $this->assertSame('El correo ya existe.', $e->getMessage());
        $this->assertSame([], $e->detalles);
    }

    public function test_el_cuerpo_tiene_la_forma_comun_de_error(): void
    {
        $detalles = [['campo' => 'nombre', 'mensaje' => 'Obligatorio.']];

        $e = new ApiException(422, 'DATOS_NO_VALIDOS', 'Los datos no son válidos.', $detalles);

        $this->assertSame([
            'error' => [
                'codigo' => 'DATOS_NO_VALIDOS',
                'mensaje' => 'Los datos no son válidos.',
                'detalles' => $detalles,
            ],
        ], $e->cuerpo());
    }
}
