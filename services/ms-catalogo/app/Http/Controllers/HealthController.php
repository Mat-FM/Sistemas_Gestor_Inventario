<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * GET /health (RNF10): responde 200 solo si el servicio puede atender peticiones, es decir, si MySQL responde.
 * Si no, 503 con la forma común de error; el motivo va al registro, nunca en la respuesta.
 *
 * No consulta a ms-proveedores: si ese servicio cae, este sigue atendiendo todo menos el filtro ?id_proveedor.
 */
class HealthController extends Controller
{
    public function __invoke(): JsonResponse
    {
        try {
            DB::select('select 1');
        } catch (Throwable $e) {
            Log::error('base_de_datos_no_disponible', ['excepcion' => $e::class]);
            $error = ApiException::servicioNoDisponible();

            return response()->json($error->cuerpo(), $error->status);
        }

        return response()->json(['estado' => 'ok', 'servicio' => 'ms-catalogo']);
    }
}
