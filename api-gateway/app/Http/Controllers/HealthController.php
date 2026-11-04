<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\Jwt\JwtService;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * GET /health (RNF10): la sonda de readiness. Responde 200 solo si el Gateway puede atender peticiones, es decir,
 * si `JwtService` se construye (JWT_SECRET y JWT_TTL_MINUTES válidos) y las URLs de los seis servicios son http(s)
 * válidas. Si no, 503 con la forma común de error y sin decir qué falla; el motivo (el nombre de la variable,
 * nunca su valor) va al registro. Así un pod mal configurado no recibe tráfico, en vez de responder 500 a cada
 * inicio de sesión o ruta autenticada.
 *
 * Se comprueba aquí y no al arrancar para no romper los comandos de consola (`key:generate`, `migrate`...). No usa
 * la base de datos, no exige autenticación y no tiene límite de peticiones (routes/internal.php).
 */
class HealthController extends Controller
{
    /** Los seis servicios de config('gateway.services'): deben estar todos, aunque falte la clave. */
    private const SERVICIOS = ['ms-catalogo', 'ms-proveedores', 'ms-inventario', 'ms-compras', 'ms-notificaciones', 'ms-reportes'];

    public function __invoke(): JsonResponse
    {
        $motivos = [...$this->motivosDelJwt(), ...$this->motivosDeLosServicios()];

        if ($motivos !== []) {
            Log::error('configuracion_no_valida', ['motivos' => $motivos]);
            $error = ApiException::servicioNoDisponible();

            return response()->json($error->cuerpo(), $error->status);
        }

        return response()->json(['estado' => 'ok', 'servicio' => 'api-gateway']);
    }

    /** @return list<string> */
    private function motivosDelJwt(): array
    {
        try {
            app(JwtService::class);

            return [];
        } catch (Throwable) {
            // El mensaje de la excepción no se registra: solo el nombre de la variable que hay que revisar.
            return [strlen((string) config('gateway.jwt.secret')) < JwtService::LONGITUD_MINIMA_SECRETO ? 'JWT_SECRET' : 'JWT_TTL_MINUTES'];
        }
    }

    /** @return list<string> las variables de entorno (MS_*_URL) de los servicios con una URL no válida */
    private function motivosDeLosServicios(): array
    {
        $urls = (array) config('gateway.services');
        $motivos = [];

        foreach (self::SERVICIOS as $servicio) {
            if (! $this->esUrlHttp($urls[$servicio] ?? null)) {
                $motivos[] = strtoupper(str_replace('-', '_', $servicio)).'_URL';
            }
        }

        return $motivos;
    }

    private function esUrlHttp(mixed $url): bool
    {
        return is_string($url)
            && filter_var($url, FILTER_VALIDATE_URL) !== false
            && in_array(strtolower((string) parse_url($url, PHP_URL_SCHEME)), ['http', 'https'], true)
            && (string) parse_url($url, PHP_URL_HOST) !== '';
    }
}
