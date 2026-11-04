<?php

use App\Exceptions\ApiException;
use App\Http\Middleware\AssignRequestId;
use App\Http\Middleware\AuthenticateJwt;
use App\Http\Middleware\EnforcePasswordChange;
use App\Http\Middleware\LogRequest;
use App\Http\Middleware\RequireRole;
use App\Services\Proxy\ProxyService;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        then: function (): void {
            // /health y /docs: propias del Gateway, sin grupos de middleware.
            Route::group([], base_path('routes/internal.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias([
            'jwt' => AuthenticateJwt::class,
            'cambio.contrasena' => EnforcePasswordChange::class,
            'rol' => RequireRole::class,
        ]);

        // Primero el identificador de petición y luego el registro, antes que cualquier otro middleware de /api
        // (JWT, cambio de contraseña pendiente y límite de peticiones los añaden las rutas).
        $middleware->api(prepend: [AssignRequestId::class, LogRequest::class]);

        // Una carga multipart se reenvía reconstruida a partir de los campos que PHP ya interpretó (no hay cuerpo en
        // bruto): estos dos middleware globales no deben recortarlos ni convertir '' en null antes del proxy (D11).
        $esMultipart = fn (Request $request): bool => ProxyService::esMultipart((string) $request->headers->get('Content-Type'));
        $middleware->trimStrings(except: [$esMultipart]);
        $middleware->convertEmptyStringsToNull(except: [$esMultipart]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Todas las respuestas son JSON con la forma común de error, pida lo que pida el cliente.
        $exceptions->shouldRenderJsonWhen(fn () => true);

        // Qué se registra en el log: los errores del cliente (4xx, ya sean ApiException o HttpException) no son
        // fallos del servidor y no se registran; los 5xx sí, incluido el 503 por la caída de un microservicio.
        // Laravel ignora todas las HttpException por defecto; se retira esa regla y se sustituye por esta.
        $exceptions->stopIgnoring(HttpException::class);
        $exceptions->dontReportWhen(fn (Throwable $e) => match (true) {
            $e instanceof ApiException => $e->status < 500,
            $e instanceof HttpExceptionInterface => $e->getStatusCode() < 500,
            default => false,
        });

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

            return $responder(ApiException::datosNoValidos($detalles));
        });

        $exceptions->render(fn (AuthenticationException $e) => $responder(ApiException::noAutenticado()));

        // abort(), 404 (NotFoundHttpException), 405, 429 del limitador (ThrottleRequestsException), 403 de
        // AuthorizationException, etc. Conserva el estado y las cabeceras (Allow, Retry-After, X-RateLimit-*);
        // si se responde como error interno genérico, las cabeceras de la excepción se descartan.
        $exceptions->render(function (HttpExceptionInterface $e) use ($responder) {
            $error = ApiException::deHttp($e);

            return $responder($error, $error->status === $e->getStatusCode() ? $e->getHeaders() : []);
        });

        // Último recurso: nunca expone la traza ni el mensaje de la excepción, con o sin APP_DEBUG.
        // La excepción ya se registra en el log por la vía normal de Laravel (report).
        $exceptions->render(function (Throwable $e) use ($responder) {
            // Respuestas ya construidas (p. ej. abort(response(...))): se dejan pasar tal cual.
            if ($e instanceof HttpResponseException) {
                return null;
            }

            return $responder(ApiException::errorInterno());
        });
    })->create();
