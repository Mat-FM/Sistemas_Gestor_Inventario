<?php

namespace Tests\Unit;

use App\Exceptions\ApiException;
use Closure;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;

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

    public function test_datos_no_validos_es_422_y_lleva_los_detalles(): void
    {
        $detalles = [['campo' => 'nombre', 'mensaje' => 'Obligatorio.']];

        $e = ApiException::datosNoValidos($detalles);

        $this->assertSame(422, $e->status);
        $this->assertSame('DATOS_NO_VALIDOS', $e->codigo);
        $this->assertSame('Los datos enviados no son válidos.', $e->getMessage());
        $this->assertSame($detalles, $e->detalles);
    }

    public function test_demasiadas_peticiones_es_429(): void
    {
        $e = ApiException::demasiadasPeticiones();

        $this->assertSame(429, $e->status);
        $this->assertSame('DEMASIADAS_PETICIONES', $e->codigo);
        $this->assertSame('Demasiadas peticiones. Intente de nuevo más tarde.', $e->getMessage());
    }

    public function test_error_interno_es_500_con_mensaje_generico(): void
    {
        $e = ApiException::errorInterno();

        $this->assertSame(500, $e->status);
        $this->assertSame('ERROR_INTERNO', $e->codigo);
        $this->assertSame('Error interno del servidor.', $e->getMessage());
        $this->assertSame([], $e->detalles);
    }

    public function test_peticion_mal_formada_conserva_el_estado_indicado(): void
    {
        $e = ApiException::peticionMalFormada(413);

        $this->assertSame(413, $e->status);
        $this->assertSame('PETICION_MAL_FORMADA', $e->codigo);
        $this->assertSame('La petición está mal formada.', $e->getMessage());
    }

    /** @return array<string, array{HttpException, int, string, string}> */
    public static function excepcionesHttp(): array
    {
        $malFormada = 'La petición está mal formada.';
        $interno = 'Error interno del servidor.';

        return [
            '400' => [new HttpException(400, 'texto interno'), 400, 'PETICION_MAL_FORMADA', $malFormada],
            '401' => [new HttpException(401, 'texto interno'), 401, 'NO_AUTENTICADO', 'No autenticado.'],
            '403' => [new HttpException(403, 'texto interno'), 403, 'SIN_PERMISO', 'No tiene permiso para realizar esta acción.'],
            '404' => [new HttpException(404, 'texto interno'), 404, 'NO_EXISTE', 'El recurso no existe.'],
            'NotFoundHttpException' => [new NotFoundHttpException('texto interno'), 404, 'NO_EXISTE', 'El recurso no existe.'],
            '405' => [new HttpException(405, 'texto interno'), 405, 'PETICION_MAL_FORMADA', 'Método no permitido.'],
            'MethodNotAllowedHttpException' => [new MethodNotAllowedHttpException(['GET'], 'texto interno'), 405, 'PETICION_MAL_FORMADA', 'Método no permitido.'],
            '409' => [new HttpException(409, 'texto interno'), 409, 'CONFLICTO', 'Conflicto con el estado actual del recurso.'],
            '413' => [new HttpException(413, 'texto interno'), 413, 'PETICION_MAL_FORMADA', $malFormada],
            '418' => [new HttpException(418, 'texto interno'), 418, 'PETICION_MAL_FORMADA', $malFormada],
            '422' => [new HttpException(422, 'texto interno'), 422, 'DATOS_NO_VALIDOS', 'Los datos enviados no son válidos.'],
            '429' => [new HttpException(429, 'texto interno'), 429, 'DEMASIADAS_PETICIONES', 'Demasiadas peticiones. Intente de nuevo más tarde.'],
            'TooManyRequestsHttpException' => [new TooManyRequestsHttpException(30, 'texto interno'), 429, 'DEMASIADAS_PETICIONES', 'Demasiadas peticiones. Intente de nuevo más tarde.'],
            '503' => [new HttpException(503, 'texto interno'), 503, 'SERVICIO_NO_DISPONIBLE', 'El servicio no está disponible.'],
            '500' => [new HttpException(500, 'texto interno'), 500, 'ERROR_INTERNO', $interno],
            '501' => [new HttpException(501, 'texto interno'), 500, 'ERROR_INTERNO', $interno],
            '502' => [new HttpException(502, 'texto interno'), 500, 'ERROR_INTERNO', $interno],
            '504' => [new HttpException(504, 'texto interno'), 500, 'ERROR_INTERNO', $interno],
            '302' => [new HttpException(302, 'texto interno'), 500, 'ERROR_INTERNO', $interno],
        ];
    }

    #[DataProvider('excepcionesHttp')]
    public function test_de_http_traduce_el_estado_al_codigo_comun_sin_filtrar_el_mensaje(HttpException $origen, int $estado, string $codigo, string $mensaje): void
    {
        $e = ApiException::deHttp($origen);

        $this->assertSame($estado, $e->status);
        $this->assertSame($codigo, $e->codigo);
        $this->assertSame($mensaje, $e->getMessage());
        $this->assertSame([], $e->detalles);
        $this->assertStringNotContainsString('texto interno', $e->getMessage());
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
