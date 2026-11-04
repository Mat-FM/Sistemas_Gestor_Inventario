<?php

use App\Exceptions\ApiException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Route;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        then: function (): void {
            // /health y, más adelante, /docs: propias del Gateway, sin grupos de middleware.
            Route::group([], base_path('routes/internal.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Todas las respuestas son JSON con la forma común de error, pida lo que pida el cliente.
        $exceptions->shouldRenderJsonWhen(fn () => true);

        // Los errores del cliente (401, 403, 404, 409, 503...) no son fallos del servidor: no se registran como error.
        $exceptions->dontReport(ApiException::class);

        // Fuente única del cuerpo: todos los renderizadores pasan por un ApiException.
        $responder = fn (ApiException $e, array $cabeceras = []): JsonResponse => response()->json($e->cuerpo(), $e->status, $cabeceras);

        $exceptions->render(fn (ApiException $e) => $responder($e));

        $exceptions->render(function (ValidationException $e) use ($responder) {
            $detalles = [];
            foreach ($e->errors() as $campo => $mensajes) {
                foreach ($mensajes as $mensaje) {
                    $detalles[] = ['campo' => (string) $campo, 'mensaje' => $mensaje];
                }
            }

            return $responder(new ApiException(422, 'DATOS_NO_VALIDOS', 'Los datos enviados no son válidos.', $detalles));
        });

        $exceptions->render(fn (AuthenticationException $e) => $responder(ApiException::noAutenticado()));

        $exceptions->render(fn (NotFoundHttpException $e) => $responder(ApiException::noExiste()));

        // Conserva Retry-After (y las cabeceras X-RateLimit-*) que añade el limitador.
        $exceptions->render(fn (ThrottleRequestsException $e) => $responder(
            new ApiException(429, 'DEMASIADAS_PETICIONES', 'Demasiadas peticiones. Intente de nuevo más tarde.'),
            $e->getHeaders(),
        ));

        // Último recurso: nunca expone la traza ni el mensaje de la excepción, con o sin APP_DEBUG.
        // La excepción ya se registra en el log por la vía normal de Laravel (report).
        $exceptions->render(function (Throwable $e) use ($responder) {
            // Respuestas ya construidas (p. ej. abort(response(...))): se dejan pasar tal cual.
            if ($e instanceof HttpResponseException) {
                return null;
            }

            return $responder(new ApiException(500, 'ERROR_INTERNO', 'Error interno del servidor.'));
        });
    })->create();
