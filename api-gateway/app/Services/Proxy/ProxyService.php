<?php

namespace App\Services\Proxy;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use App\Services\Routing\RouteRule;
use GuzzleHttp\Exception\TransferException;
use Illuminate\Http\Client\HttpClientException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response as RespuestaDelServicio;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use LogicException;
use Psr\Http\Message\RequestInterface;

/**
 * Reenvía una petición ya autorizada al microservicio que indica la regla del mapa de rutas (RNF09, RNF18). Solo
 * transporta: no decide rutas ni permisos (eso es del controlador y de RouteMap) y no accede a la base de datos
 * (RNF13); el usuario llega ya leído, con su rol cargado.
 *
 * **Cabeceras hacia el servicio.** Lista permitida: del cliente solo pasan `Accept` (por defecto
 * `application/json`), `Idempotency-Key` y, con el cuerpo, `Content-Type`. Todo lo demás se descarta
 * (`Authorization`, `Cookie`, `Host`, `X-Forwarded-*`, `Forwarded`, `Via`, `Transfer-Encoding`, `Connection`...).
 * Las de identidad las pone siempre el Gateway con sus propios valores, sin contar con que un middleware ya haya
 * borrado las del cliente: `X-User-Id`, `X-User-Rol`, `X-User-Bodega` (solo para el operador de bodega) y
 * `X-Request-Id` (el UUID del atributo `request_id`).
 *
 * **Cuerpo (D11).** Para todo lo que no es multipart se reenvía el cuerpo en bruto con su `Content-Type`
 * original. Para `multipart/form-data` PHP no conserva el cuerpo en bruto, así que se reconstruyen las partes
 * (campos y archivos, estos como flujo y byte a byte) con una frontera nueva.
 *
 * **Consulta.** La cruda de `QUERY_STRING`, sin que Symfony la reordene ni la normalice.
 *
 * **Respuesta.** Estado y cuerpo del servicio tal cual (también 3xx, 4xx y 5xx), con su `Content-Type` y su
 * `Content-Disposition` y ninguna otra cabecera. No sigue redirecciones ni reintenta. Si el servicio no responde
 * a tiempo o no se puede conectar, 503 `SERVICIO_NO_DISPONIBLE`.
 */
class ProxyService
{
    /** Cabeceras del cliente que se reenvían, además de `Content-Type` (que viaja con el cuerpo). */
    private const CABECERAS_DEL_CLIENTE = ['Accept', 'Idempotency-Key'];

    /** Cabeceras de la respuesta del servicio que se devuelven al cliente. */
    private const CABECERAS_DE_LA_RESPUESTA = ['Content-Type', 'Content-Disposition'];

    private const ACCEPT_POR_DEFECTO = 'application/json';

    /**
     * @param  array<string, string>  $baseUrls  URL base de cada servicio, por nombre (`config('gateway.services')`)
     * @param  int  $timeoutSeconds  tiempo máximo de cada llamada, conexión incluida
     */
    public function __construct(
        private readonly array $baseUrls,
        private readonly int $timeoutSeconds = 3,
    ) {}

    /**
     * @throws ApiException 503 si el servicio no responde; 422 si un archivo de la carga no llegó completo
     */
    public function reenviar(Request $request, Usuario $usuario, RouteRule $regla): Response
    {
        $idPeticion = $request->attributes->get('request_id');
        if (! is_string($idPeticion) || $idPeticion === '') {
            throw new LogicException('La petición no tiene request_id: AssignRequestId debe ejecutarse antes del proxy.');
        }

        $metodo = $request->getMethod();
        $url = $this->urlDestino($regla, $request);

        $pendiente = Http::timeout($this->timeoutSeconds)
            ->connectTimeout($this->timeoutSeconds)
            ->withoutRedirecting()
            ->replaceHeaders($this->cabeceras($request, $usuario, $idPeticion));

        $opciones = $this->prepararCuerpo($pendiente, $request);

        try {
            $respuesta = $pendiente->send($metodo, $url, $opciones);
        } catch (HttpClientException|TransferException) {
            // ConnectionException: caído, DNS o tiempo agotado. Una RequestException solo llega aquí si la
            // transferencia se cortó a medias (sin `throw()`, los 4xx y 5xx no lanzan). Nunca cuerpos ni cabeceras.
            Log::error('servicio_no_disponible', ['servicio' => $regla->servicio, 'request_id' => $idPeticion]);

            throw ApiException::servicioNoDisponible();
        }

        return $this->respuesta($respuesta);
    }

    private function urlDestino(RouteRule $regla, Request $request): string
    {
        $base = $this->baseUrls[$regla->servicio] ?? null;
        if (! is_string($base) || $base === '') {
            throw new LogicException("El servicio «{$regla->servicio}» no tiene URL configurada.");
        }

        // `rutaInterna` ya viene validada y codificada por RouteMap: se concatena tal cual.
        $url = rtrim($base, '/').'/'.$regla->rutaInterna;

        $consulta = $request->server->get('QUERY_STRING');

        return is_string($consulta) && $consulta !== '' ? $url.'?'.$consulta : $url;
    }

    /**
     * @return array<string, string>
     */
    private function cabeceras(Request $request, Usuario $usuario, string $idPeticion): array
    {
        $cabeceras = [];
        foreach (self::CABECERAS_DEL_CLIENTE as $nombre) {
            $valor = $request->headers->get($nombre);
            if (is_string($valor) && $valor !== '') {
                $cabeceras[$nombre] = $valor;
            }
        }
        $cabeceras['Accept'] ??= self::ACCEPT_POR_DEFECTO;

        $rol = $usuario->rol?->nombre;
        if (! is_string($rol) || $rol === '') {
            throw new LogicException('El usuario no tiene su rol cargado.');
        }

        $cabeceras['X-User-Id'] = (string) $usuario->getKey();
        $cabeceras['X-User-Rol'] = $rol;
        $cabeceras['X-Request-Id'] = $idPeticion;

        if ($usuario->esOperador()) {
            // Un operador sin bodega no debe existir (D9); si existiera, el servicio podría tomar la ausencia de la
            // cabecera como «sin restricción de bodega». Se falla cerrado.
            if ($usuario->id_bodega === null) {
                throw new LogicException('El operador de bodega no tiene bodega asignada.');
            }
            $cabeceras['X-User-Bodega'] = (string) $usuario->id_bodega;
        }

        return $cabeceras;
    }

    /**
     * Deja el cuerpo listo en la petición pendiente y devuelve las opciones de envío.
     *
     * @return array<string, mixed>
     */
    private function prepararCuerpo(PendingRequest $pendiente, Request $request): array
    {
        $tipo = $request->headers->get('Content-Type');

        if (is_string($tipo) && self::esMultipart($tipo)) {
            // El Content-Type (con su frontera) lo pone el cliente HTTP al armar el cuerpo nuevo.
            $pendiente->asMultipart();

            return ['multipart' => $this->partes($request)];
        }

        $contenido = $request->getContent();

        if (! is_string($tipo) || $tipo === '') {
            // Sin Content-Type del cliente no se inventa uno (el cliente HTTP pondría application/json).
            $pendiente->withRequestMiddleware(fn (RequestInterface $r): RequestInterface => $r->withoutHeader('Content-Type'));

            if ($contenido !== '') {
                $pendiente->withBody($contenido, 'application/octet-stream');
            }

            return [];
        }

        $pendiente->withBody($contenido, $tipo);

        return [];
    }

    public static function esMultipart(string $tipo): bool
    {
        return str_starts_with(strtolower(ltrim($tipo)), 'multipart/form-data');
    }

    /**
     * Las partes de una carga multipart: primero los campos y después los archivos, con los arreglos anidados
     * aplanados en notación de corchetes (`meta[origen]`, `filas[0]`).
     *
     * @return list<array{name: string, contents: string|resource, filename?: string, headers?: array<string, string>}>
     */
    private function partes(Request $request): array
    {
        $partes = [];

        foreach (self::aplanar($request->post()) as $nombre => $valor) {
            $partes[] = ['name' => (string) $nombre, 'contents' => is_scalar($valor) ? (string) $valor : ''];
        }

        // Symfony deja en null un campo de archivo enviado vacío (UPLOAD_ERR_NO_FILE): no hay nada que reenviar.
        $archivos = array_filter(self::aplanar($request->allFiles()), fn (mixed $archivo): bool => $archivo !== null);

        // Primero se validan todos: si uno falla no se deja ningún archivo abierto.
        foreach ($archivos as $nombre => $archivo) {
            if (! $archivo instanceof UploadedFile || ! $archivo->isValid()) {
                throw ApiException::datosNoValidos([['campo' => (string) $nombre, 'mensaje' => 'El archivo no se recibió completo.']]);
            }
        }

        foreach ($archivos as $nombre => $archivo) {
            /** @var UploadedFile $archivo */
            // Como flujo: el archivo no se carga entero en memoria. El cliente HTTP lo envuelve en un Stream que lo
            // cierra al terminar.
            $flujo = fopen($archivo->getRealPath(), 'rb');
            if ($flujo === false) {
                throw new LogicException("No se pudo abrir el archivo recibido en «{$nombre}».");
            }

            $parte = ['name' => (string) $nombre, 'contents' => $flujo, 'filename' => $archivo->getClientOriginalName()];

            $mime = $archivo->getClientMimeType();
            if ($mime !== '' && preg_match('/[\x00-\x1F\x7F]/', $mime) !== 1) {
                $parte['headers'] = ['Content-Type' => $mime];
            }

            $partes[] = $parte;
        }

        return $partes;
    }

    /**
     * @param  array<array-key, mixed>  $valores
     * @return array<string, mixed> hojas del arreglo, con su nombre en notación de corchetes
     */
    private static function aplanar(array $valores, string $prefijo = ''): array
    {
        $planos = [];

        foreach ($valores as $clave => $valor) {
            $nombre = $prefijo === '' ? (string) $clave : "{$prefijo}[{$clave}]";

            if (is_array($valor)) {
                $planos += self::aplanar($valor, $nombre);
            } else {
                $planos[$nombre] = $valor;
            }
        }

        return $planos;
    }

    private function respuesta(RespuestaDelServicio $respuesta): Response
    {
        $cabeceras = [];
        foreach (self::CABECERAS_DE_LA_RESPUESTA as $nombre) {
            $valor = $respuesta->header($nombre);
            if ($valor !== '') {
                $cabeceras[$nombre] = $valor;
            }
        }

        // body() es el cuerpo crudo: los archivos binarios pasan sin tocarse.
        return new Response($respuesta->body(), $respuesta->status(), $cabeceras);
    }
}
