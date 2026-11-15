<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Http\Middleware\RegistrarPeticion;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Única clase que habla con ms-proveedores (llamada 8 de la Entrega 2): obtiene los productos de un proveedor
 * para el filtro de RF12. Aplica RNF18:
 *
 * - Cada intento espera como máximo 3 s.
 * - Como es una consulta (no duplica nada al repetirse), ante un fallo de conexión o un error 5xx se reintenta
 *   hasta 3 veces, con esperas de 0,2, 0,4 y 0,8 s.
 * - Cortacircuitos: tras 5 llamadas fallidas seguidas, durante 30 s no se llama y se responde 503 de inmediato.
 *   Después se vuelve a probar: si esa llamada también falla, se abre otra vez; si responde, el contador vuelve a 0.
 *
 * El contador vive en la caché de Laravel, así que cada copia del servicio lleva el suyo.
 */
class ProveedoresCliente
{
    private const ESPERA_SEGUNDOS = 3;

    private const REINTENTOS_MS = [200, 400, 800];

    private const FALLOS_PARA_ABRIR = 5;

    private const SEGUNDOS_ABIERTO = 30;

    private const CLAVE_FALLOS = 'cortacircuitos:ms-proveedores:fallos';

    private const CLAVE_ABIERTO = 'cortacircuitos:ms-proveedores:abierto';

    /**
     * Identificadores de los productos asociados al proveedor. Si el proveedor no existe (404),
     * no tiene productos: lista vacía.
     *
     * @return list<int>
     *
     * @throws ApiException 503 si ms-proveedores no responde o el cortacircuitos está abierto
     */
    public function idsDeProductos(int $idProveedor): array
    {
        if (Cache::has(self::CLAVE_ABIERTO)) {
            throw $this->noDisponible();
        }

        try {
            $respuesta = Http::baseUrl((string) config('services.ms_proveedores.url'))
                ->timeout(self::ESPERA_SEGUNDOS)
                ->connectTimeout(self::ESPERA_SEGUNDOS)
                ->acceptJson()
                // El mismo identificador de la petición, para seguirla en los registros de los dos servicios (RNF10).
                ->withHeaders([RegistrarPeticion::CABECERA => (string) request()->header(RegistrarPeticion::CABECERA)])
                ->retry(self::REINTENTOS_MS, when: fn (Throwable $e) => $e instanceof ConnectionException
                    || ($e instanceof RequestException && $e->response->serverError()), throw: false)
                ->get("/proveedores/{$idProveedor}/productos");
        } catch (ConnectionException) {
            $respuesta = null;
        }

        if ($respuesta !== null && $respuesta->notFound()) {
            $this->registrarExito();

            return [];
        }

        if ($respuesta === null || ! $respuesta->successful() || ! is_array($respuesta->json())) {
            $this->registrarFallo($respuesta?->status());

            throw $this->noDisponible();
        }

        $this->registrarExito();

        return array_map('intval', array_column($respuesta->json(), 'id_producto'));
    }

    private function registrarExito(): void
    {
        Cache::forget(self::CLAVE_FALLOS);
    }

    private function registrarFallo(?int $estado): void
    {
        $fallos = (int) Cache::increment(self::CLAVE_FALLOS);
        Log::error('servicio_no_disponible', ['destino' => 'ms-proveedores', 'estado' => $estado, 'fallos_seguidos' => $fallos]);

        if ($fallos >= self::FALLOS_PARA_ABRIR) {
            Cache::put(self::CLAVE_ABIERTO, true, self::SEGUNDOS_ABIERTO);
            Log::warning('cortacircuitos_abierto', ['destino' => 'ms-proveedores', 'segundos' => self::SEGUNDOS_ABIERTO]);
        }
    }

    private function noDisponible(): ApiException
    {
        return ApiException::servicioNoDisponible('ms-proveedores no responde. Intente de nuevo más tarde.');
    }
}
