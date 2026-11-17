<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Http\Controllers\Concerns\ResponderFormularios;
use App\Services\Notificaciones;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Con cuánta anticipación y a qué hora se revisan los vencimientos y el stock bajo (RF09, RF17). Solo el administrador. */
class AlertaController extends Controller
{
    use ResponderFormularios;

    public function __construct(private readonly Notificaciones $notificaciones) {}

    public function edit(): View
    {
        [$configuracion, $fallo] = Intento::de(fn () => $this->notificaciones->configuracion());

        return view('alertas.editar', ['configuracion' => $configuracion, 'fallo' => $fallo !== null]);
    }

    public function update(Request $request): RedirectResponse
    {
        $datos = $request->validate([
            'dias_anticipacion_vencimiento' => ['required', 'integer', 'min:1', 'max:365'],
            'hora_revision_diaria' => ['required', 'date_format:H:i'],
        ], [
            'dias_anticipacion_vencimiento.required' => 'Escribe cuántos días antes quieres el aviso.',
            'dias_anticipacion_vencimiento.integer' => 'Los días deben ser un número entero.',
            'dias_anticipacion_vencimiento.min' => 'Pon al menos 1 día.',
            'dias_anticipacion_vencimiento.max' => 'El máximo son 365 días.',
            'hora_revision_diaria.required' => 'Escribe la hora de la revisión.',
            'hora_revision_diaria.date_format' => 'La hora debe tener el formato 06:00.',
        ]);

        try {
            $this->notificaciones->guardarConfiguracion((int) $datos['dias_anticipacion_vencimiento'], $datos['hora_revision_diaria']);
        } catch (GatewayException $e) {
            return $this->fallaDeFormulario($request, $e);
        }

        return redirect()->route('alertas.edit')->with('exito', 'Configuración guardada. La próxima revisión usará estos valores.');
    }
}
