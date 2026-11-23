<?php

namespace App\Gateway;

use App\Support\Sesion;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * El único código que sabe de HTTP: habla con el API Gateway (RNF21) con el token de la sesión del servidor y convierte
 * cualquier respuesta fallida en una GatewayException con la forma común de error. Lo demás pide datos con get() y
 * enviar() y no sabe de direcciones, cabeceras ni plazos.
 */
class GatewayClient
{
    private const CONCURRENCIA = 5;

    public function __construct(private readonly Sesion $sesion) {}

    /** @param  array<string, scalar|null>  $consulta */
    public function get(string $ruta, array $consulta = []): mixed
    {
        return $this->enviar('GET', $ruta, consulta: $consulta)->cuerpo;
    }

    /**
     * @param  array<string, scalar|null>  $consulta
     * @param  array<string, mixed>|null  $cuerpo
     */
    public function enviar(
        string $metodo,
        string $ruta,
        ?array $cuerpo = null,
        array $consulta = [],
        ?string $claveIdempotencia = null,
        bool $conToken = true,
    ): RespuestaGateway {
        $peticion = $this->base($conToken);
        if ($claveIdempotencia !== null) {
            $peticion = $peticion->withHeaders(['Idempotency-Key' => $claveIdempotencia]);
        }

        try {
            $respuesta = $peticion->send($metodo, ltrim($ruta, '/'), array_filter([
                'query' => $this->sinNulos($consulta) ?: null,
                // Un cuerpo vacío va como objeto JSON ({}), no como arreglo ([]): los servicios lo exigen así.
                'json' => $cuerpo === [] ? (object) [] : $cuerpo,
            ], static fn ($valor) => $valor !== null));
        } catch (ConnectionException) {
            throw $this->sinConexion();
        }

        return $this->resolver($respuesta);
    }

    /**
     * Sube un archivo como multipart/form-data junto con sus campos de texto (las importaciones masivas). Un fallo se
     * convierte en GatewayException igual que en las demás llamadas.
     *
     * @param  array<string, scalar>  $campos
     */
    public function subir(string $ruta, array $campos, string $campoArchivo, string $contenido, string $nombre): RespuestaGateway
    {
        try {
            $respuesta = $this->base(true, false)->attach($campoArchivo, $contenido, $nombre)->post(ltrim($ruta, '/'), $campos);
        } catch (ConnectionException) {
            throw $this->sinConexion();
        }

        return $this->resolver($respuesta);
    }

    /**
     * Un archivo (CSV o PDF de los reportes): el cuerpo crudo y las dos cabeceras que el Gateway deja pasar. Un fallo se
     * convierte en GatewayException igual que en las demás llamadas.
     *
     * @param  array<string, scalar|null>  $consulta
     * @return array{cuerpo: string, tipo: string, disposicion: string|null}
     */
    public function descargar(string $ruta, array $consulta = []): array
    {
        try {
            $respuesta = $this->base(true)->replaceHeaders(['Accept' => '*/*'])
                ->send('GET', ltrim($ruta, '/'), ['query' => $this->sinNulos($consulta)]);
        } catch (ConnectionException) {
            throw $this->sinConexion();
        }
        $this->resolver($respuesta, false);

        return [
            'cuerpo' => $respuesta->body(),
            'tipo' => $respuesta->header('Content-Type') ?: 'application/octet-stream',
            'disposicion' => $respuesta->header('Content-Disposition') ?: null,
        ];
    }

    /**
     * Varias consultas GET a la vez. Cada una falla por separado: devuelve, por clave, el cuerpo o la excepción, para
     * que un servicio lento no deje en blanco toda la pantalla.
     *
     * @param  array<string, array{0: string, 1?: array<string, scalar|null>}>  $consultas  clave => [ruta, consulta]
     * @return array<string, mixed|GatewayException>
     */
    public function varias(array $consultas): array
    {
        if ($consultas === []) {
            return [];
        }
        $token = $this->sesion->token();

        // A lo sumo CONCURRENCIA peticiones a la vez: el Gateway limita a 100 por minuto y por usuario.
        $respuestas = Http::pool(function (Pool $pool) use ($consultas, $token) {
            foreach ($consultas as $clave => [$ruta, $consulta]) {
                $peticion = $this->conOrigen($pool->as((string) $clave)->baseUrl(config('gateway.url').'/api')
                    ->timeout(config('gateway.timeout'))->acceptJson()->withoutRedirecting());
                if ($token !== null) {
                    $peticion = $peticion->withToken($token);
                }
                $peticion->get(ltrim($ruta, '/'), $this->sinNulos($consulta ?? []));
            }
        }, self::CONCURRENCIA);

        $resultado = [];
        foreach ($consultas as $clave => $_) {
            $respuesta = $respuestas[(string) $clave] ?? null;
            try {
                $resultado[$clave] = $respuesta instanceof Response
                    ? $this->resolver($respuesta)->cuerpo
                    : $this->sinConexion();
            } catch (GatewayException $e) {
                $resultado[$clave] = $e;
            }
        }

        return $resultado;
    }

    /**
     * Todos los elementos de un listado paginado, para los desplegables: deben ofrecer todo y no solo la primera página.
     * La primera página dice cuántos hay; las demás se piden juntas con varias(). Si alguna falla, falla todo.
     *
     * @param  array<string, scalar|null>  $consulta
     * @return list<array<string, mixed>>
     */
    public function todas(string $ruta, array $consulta = []): array
    {
        $consulta['por_pagina'] = 100; // el máximo que acepta cada servicio (Entrega 2, sección 4.1)
        $primera = $this->get($ruta, ['pagina' => 1] + $consulta);
        $datos = $primera['datos'] ?? [];

        $resto = [];
        for ($pagina = 2; $pagina <= (int) ceil((int) ($primera['meta']['total'] ?? 0) / 100); $pagina++) {
            $resto["p$pagina"] = [$ruta, ['pagina' => $pagina] + $consulta];
        }
        foreach ($this->varias($resto) as $respuesta) {
            if ($respuesta instanceof GatewayException) {
                throw $respuesta;
            }
            array_push($datos, ...($respuesta['datos'] ?? []));
        }

        return $datos;
    }

    private function base(bool $conToken, bool $json = true): PendingRequest
    {
        $peticion = Http::baseUrl(config('gateway.url').'/api')
            ->timeout(config('gateway.timeout'))
            ->acceptJson()
            ->withoutRedirecting();
        // Un archivo va como multipart/form-data: un Content-Type fijo de JSON le quitaría el límite (boundary).
        $peticion = $json ? $peticion->asJson() : $peticion;

        $token = $conToken ? $this->sesion->token() : null;
        $peticion = $this->conOrigen($peticion);

        return $token !== null ? $peticion->withToken($token) : $peticion;
    }

    /**
     * El Gateway limita los inicios de sesión por IP. Sin esto vería siempre la del servidor web y todos los usuarios
     * compartirían un solo límite; si el Gateway confía en este servidor (TRUSTED_PROXIES), usa la IP real.
     */
    private function conOrigen(PendingRequest $peticion): PendingRequest
    {
        $ip = request()->ip();

        return $ip === null ? $peticion : $peticion->withHeaders(['X-Forwarded-For' => $ip]);
    }

    private function resolver(Response $respuesta, bool $esperaJson = true): RespuestaGateway
    {
        if ($respuesta->successful()) {
            if (! $esperaJson) {
                return new RespuestaGateway($respuesta->status(), null);
            }

            if ($respuesta->status() === 204) {
                return new RespuestaGateway(204, null);
            }

            // Un éxito sin JSON (una página de error, una respuesta cortada) no es una respuesta válida: no se
            // interpreta como «lista vacía».
            $cuerpo = $respuesta->json();
            if ($cuerpo === null) {
                throw $this->sinConexion();
            }

            return new RespuestaGateway($respuesta->status(), $cuerpo);
        }

        try {
            $error = $respuesta->json('error');
        } catch (Throwable) {
            $error = null;
        }
        $error = is_array($error) ? $error : [];

        throw new GatewayException(
            $respuesta->status(),
            (string) ($error['codigo'] ?? 'ERROR_INTERNO'),
            (string) ($error['mensaje'] ?? ''),
            is_array($error['detalles'] ?? null) ? $error['detalles'] : [],
            (int) $respuesta->header('Retry-After'),
            $respuesta->header('X-Request-Id') ?: null,
        );
    }

    private function sinConexion(): GatewayException
    {
        return new GatewayException(503, 'SERVICIO_NO_DISPONIBLE', 'No se pudo conectar con el servidor.');
    }

    /** @param  array<string, scalar|null>  $consulta */
    private function sinNulos(array $consulta): array
    {
        return array_filter($consulta, static fn ($valor) => $valor !== null && $valor !== '');
    }
}
