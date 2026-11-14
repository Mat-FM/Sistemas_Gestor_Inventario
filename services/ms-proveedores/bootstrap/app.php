<?php

use App\Exceptions\ApiException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        // Sin prefijo: el Gateway ya quitó /api antes de reenviar la petición.
        apiPrefix: '',
        commands: __DIR__.'/../routes/console.php',
        then: function (): void {
            // /health y /docs: propias del servicio, sin grupos de middleware.
            Route::group([], base_path('routes/internal.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Todas las respuestas de error son JSON con la forma común, pida lo que pida el cliente.
        $exceptions->shouldRenderJsonWhen(fn () => true);

        // Los errores esperados (404, 409, 422) no son fallos del servidor: no se escriben en el log.
        $exceptions->dontReport(ApiException::class);

        $responder = fn (ApiException $e) => response()->json($e->cuerpo(), $e->status);

        $exceptions->render(fn (ApiException $e) => $responder($e));

        // Cada mensaje de validación se entrega como {campo, mensaje}.
        $exceptions->render(function (ValidationException $e) use ($responder) {
            $detalles = [];
            foreach ($e->errors() as $campo => $mensajes) {
                foreach ($mensajes as $mensaje) {
                    $detalles[] = ['campo' => (string) $campo, 'mensaje' => $mensaje];
                }
            }

            return $responder(ApiException::datosNoValidos($detalles));
        });

        // Ruta o registro inexistente (404), método no permitido (405) y demás errores HTTP.
        $exceptions->render(function (HttpExceptionInterface $e) use ($responder) {
            $status = $e->getStatusCode();

            return $responder(match (true) {
                $status === 404 => ApiException::noExiste(),
                $status === 405 => ApiException::peticionMalFormada(405, 'Método no permitido.'),
                $status >= 400 && $status < 500 => ApiException::peticionMalFormada($status),
                default => ApiException::errorInterno(),
            });
        });

        // Último recurso: cualquier otro fallo es un 500 genérico, sin traza (Laravel ya lo registra en el log).
        $exceptions->render(fn (Throwable $e) => $responder(ApiException::errorInterno()));
    })->create();
