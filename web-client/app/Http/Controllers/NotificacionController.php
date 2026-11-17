<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Services\Nombres;
use App\Services\Notificaciones;
use App\Support\Formato;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\View\View;

/** Alertas del rol (stock bajo, vencimientos, órdenes recibidas) y la preferencia de correo de cada usuario (RF09, RF17). */
class NotificacionController extends Controller
{
    public function __construct(
        private readonly Notificaciones $notificaciones,
        private readonly Nombres $nombres,
        private readonly Sesion $sesion,
    ) {}

    public function index(Request $request): View
    {
        $pestana = $request->query('ver') === 'todas' ? 'todas' : 'sin_leer';
        $tipo = array_key_exists((string) $request->query('tipo'), Formato::TIPOS_DE_ALERTA) ? $request->query('tipo') : null;

        [$respuesta, $fallo] = Intento::de(fn () => $this->notificaciones->listar([
            'leida' => $pestana === 'sin_leer' ? 'false' : null,
            'tipo' => $tipo,
            'pagina' => max(1, $request->integer('pagina', 1)),
        ]));

        $filas = $respuesta['datos'] ?? [];
        [$productos] = Intento::de(fn () => $this->nombres->productos(array_filter(array_column($filas, 'id_producto'))));
        [$bodegas] = Intento::de(fn () => $this->nombres->bodegas());
        $nombresDeBodega = array_map(static fn (array $bodega) => $bodega['nombre'], $bodegas ?? []);

        $alertas = array_map(function (array $fila) use ($productos, $nombresDeBodega) {
            $producto = $fila['id_producto'] !== null ? ($productos[(int) $fila['id_producto']]['nombre'] ?? null) : null;
            $fila['texto'] = Formato::mensajeDeAlerta($fila['mensaje'], $producto, $nombresDeBodega);
            $fila['producto'] = $producto;

            return $fila;
        }, $filas);

        return view('notificaciones.index', [
            'alertas' => $alertas,
            'meta' => $respuesta['meta'] ?? null,
            'fallo' => $fallo !== null,
            'pestana' => $pestana,
            'tipo' => $tipo,
            'sinLeer' => (int) ($pestana === 'sin_leer' ? ($respuesta['meta']['total'] ?? 0) : 0),
        ]);
    }

    public function leer(int $id): RedirectResponse
    {
        try {
            $this->notificaciones->marcarLeida($id);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado !== 404) {
                throw $e;
            }
        }
        Cache::forget('alertas.sin_leer.'.($this->sesion->usuario()['id_usuario'] ?? 0));

        return back();
    }

    public function preferencias(): View
    {
        [$preferencia, $fallo] = Intento::de(fn () => $this->notificaciones->preferencia());

        return view('notificaciones.preferencias', ['preferencia' => $preferencia, 'fallo' => $fallo !== null]);
    }

    public function guardarPreferencias(Request $request): RedirectResponse
    {
        $recibir = $request->boolean('recibir_correo');
        $datos = $request->validate([
            'correo' => [$recibir ? 'required' : 'nullable', 'string', 'email', 'max:255'],
        ], [
            'correo.required' => 'Escribe el correo al que quieres recibir las alertas.',
            'correo.email' => 'Escribe un correo válido, por ejemplo ana@elmontanero.com.',
        ]);

        try {
            $this->notificaciones->guardarPreferencia($recibir, ($datos['correo'] ?? '') !== '' ? mb_strtolower(trim($datos['correo'])) : null);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);
            if ($e->estado === 422 && $e->erroresPorCampo() !== []) {
                return back()->withInput()->withErrors($e->erroresPorCampo());
            }

            return back()->withInput()->with('error', $e->esAmbigua()
                ? 'El sistema no respondió. Revisa tu preferencia antes de intentarlo otra vez.'
                : 'No se pudo guardar tu preferencia. Intenta de nuevo.');
        }

        return redirect()->route('preferencias.edit')->with('exito', $recibir ? 'Listo: te enviaremos las alertas por correo.' : 'Listo: ya no recibirás las alertas por correo.');
    }
}
