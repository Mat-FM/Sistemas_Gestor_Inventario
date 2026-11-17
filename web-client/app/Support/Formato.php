<?php

namespace App\Support;

use Carbon\CarbonImmutable;
use Throwable;

/** Cómo se muestran números y fechas: es-CO y hora de Bogotá (la API envía los instantes en UTC). */
final class Formato
{
    public const TIPOS = [
        'ENTRADA' => ['Entrada', 1],
        'SALIDA' => ['Salida', -1],
        'AJUSTE' => ['Ajuste', 0],
        'DEVOLUCION_CLIENTE' => ['Devolución de cliente', 1],
        'ENTRADA_COMPRA' => ['Entrada por compra', 1],
        'DEVOLUCION_PROVEEDOR' => ['Devolución a proveedor', -1],
        'TRASLADO_SALIDA' => ['Traslado enviado', -1],
        'TRASLADO_ENTRADA' => ['Traslado recibido', 1],
        'CARGA_INICIAL' => ['Carga inicial', 1],
    ];

    public static function numero(int|float|string|null $valor): string
    {
        if ($valor === null || $valor === '') {
            return '—';
        }

        return number_format((float) $valor, 0, ',', '.');
    }

    public static function moneda(int|float|string|null $valor): string
    {
        if ($valor === null || $valor === '') {
            return '—';
        }
        $numero = (float) $valor;

        return '$ '.number_format($numero, fmod($numero, 1.0) === 0.0 ? 0 : 2, ',', '.');
    }

    /** Pesos redondeados, para cifras resumen donde los centavos estorban ($ 6.561.843). */
    public static function monedaEntera(int|float|string|null $valor): string
    {
        return $valor === null || $valor === '' ? '—' : '$ '.number_format((float) $valor, 0, ',', '.');
    }

    /**
     * Un número escrito a la colombiana («18.500», «18.500,50», «18500,5») como lo entiende la API («18500», «18500.50»).
     * Con coma, los puntos son separadores de miles; sin coma, un punto seguido de grupos de tres cifras también lo es
     * y cualquier otro punto es decimal.
     */
    public static function normalizarDecimal(mixed $texto): mixed
    {
        if (! is_string($texto)) {
            return $texto;
        }
        $texto = preg_replace('/[\s$]/', '', $texto);
        if (str_contains($texto, ',')) {
            return str_replace(',', '.', str_replace('.', '', $texto));
        }
        if (preg_match('/^\d{1,3}(\.\d{3})+$/', $texto) === 1) {
            return str_replace('.', '', $texto);
        }

        return $texto;
    }

    public static function fecha(?string $instante): string
    {
        if ($instante === null || $instante === '') {
            return '—';
        }
        try {
            return CarbonImmutable::parse($instante)->setTimezone(config('interfaz.zona_horaria'))->format('d/m/Y g:i a');
        } catch (Throwable) {
            return $instante;
        }
    }

    /** Fecha de un día (AAAA-MM-DD), sin cambio de huso. */
    public static function dia(?string $dia): string
    {
        if ($dia === null || $dia === '') {
            return '—';
        }
        try {
            return CarbonImmutable::parse($dia)->format('d/m/Y');
        } catch (Throwable) {
            return $dia;
        }
    }

    public static function vencido(?string $dia): bool
    {
        if ($dia === null || $dia === '') {
            return false;
        }
        try {
            return CarbonImmutable::parse($dia)->endOfDay()->isBefore(CarbonImmutable::now(config('interfaz.zona_horaria')));
        } catch (Throwable) {
            return false;
        }
    }

    public static function tipo(string $tipo): string
    {
        return self::TIPOS[$tipo][0] ?? $tipo;
    }

    /** +1 suma al saldo, −1 resta, 0 el tipo depende del ajuste. */
    public static function signo(string $tipo): int
    {
        return self::TIPOS[$tipo][1] ?? 0;
    }

    public const ESTADOS_DE_ORDEN = [
        'CREADA' => ['Creada', 'info'],
        'ENVIADA' => ['Enviada', 'info'],
        'RECIBIDA_PARCIAL' => ['Recibida parcial', 'alerta'],
        'RECIBIDA' => ['Recibida', 'ok'],
        'ANULADA' => ['Anulada', 'mal'],
    ];

    public const TIPOS_DE_ALERTA = [
        'STOCK_BAJO' => ['Poco stock', 'exclamation-triangle-fill', 'alerta'],
        'VENCIMIENTO' => ['Por vencer', 'hourglass-split', 'mal'],
        'ORDEN_RECIBIDA' => ['Orden recibida', 'box-seam', 'ok'],
    ];

    /**
     * Los avisos de los servicios hablan de «producto 2» y «bodega 1»: se cambian por sus nombres cuando se conocen.
     *
     * @param  array<string, string>  $nombresDeBodega  id → nombre
     */
    public static function mensajeDeAlerta(string $mensaje, ?string $producto, array $nombresDeBodega = []): string
    {
        if ($producto !== null) {
            $mensaje = preg_replace('/\bproducto \d+\b/u', 'producto «'.addcslashes($producto, '\\$').'»', $mensaje);
        }
        foreach ($nombresDeBodega as $id => $nombre) {
            $mensaje = preg_replace('/\bbodega '.preg_quote((string) $id, '/').'\b/u', 'bodega «'.addcslashes($nombre, '\\$').'»', $mensaje);
        }

        return $mensaje;
    }
}
