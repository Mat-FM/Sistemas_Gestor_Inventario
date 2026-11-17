<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayClient;
use App\Gateway\GatewayException;
use App\Support\Sesion;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Inicio y cierre de sesión y cambio de contraseña, todo a través del Gateway (RF08). */
class AuthController extends Controller
{
    public function formulario(Sesion $sesion): View|RedirectResponse
    {
        return $sesion->activa() ? redirect()->route('inicio') : view('auth.login');
    }

    public function entrar(Request $request, GatewayClient $gateway, Sesion $sesion): RedirectResponse
    {
        $datos = $request->validate([
            'correo' => ['required', 'string', 'max:255'],
            'contrasena' => ['required', 'string', 'max:255'],
        ], [
            'correo.required' => 'Escribe tu correo.',
            'contrasena.required' => 'Escribe tu contraseña.',
        ]);

        try {
            $respuesta = $gateway->enviar('POST', 'auth/login', $datos, conToken: false);
        } catch (GatewayException $e) {
            return back()->withInput($request->only('correo'))->withErrors(['correo' => match (true) {
                $e->codigo === 'CREDENCIALES_INVALIDAS' => 'Correo o contraseña incorrectos.',
                $e->codigo === 'USUARIO_INACTIVO' => 'Tu usuario está inactivo. Habla con el administrador.',
                $e->estado === 429 => 'Demasiados intentos. '.($e->reintentarEn > 0 ? "Espera {$e->reintentarEn} segundos." : 'Espera un momento.'),
                $e->esAmbigua() => 'El sistema no está disponible por ahora. Intenta de nuevo en unos minutos.',
                default => $e->getMessage() ?: 'No se pudo iniciar sesión.',
            }]);
        }

        $sesion->iniciar($respuesta->cuerpo);

        return $sesion->debeCambiarContrasena()
            ? redirect()->route('contrasena.editar')
            : redirect()->route('inicio');
    }

    public function editarContrasena(Sesion $sesion): View
    {
        return view('auth.contrasena', ['forzado' => $sesion->debeCambiarContrasena()]);
    }

    public function actualizarContrasena(Request $request, GatewayClient $gateway, Sesion $sesion): RedirectResponse
    {
        $datos = $request->validate([
            'contrasena_actual' => ['required', 'string', 'max:255'],
            'contrasena_nueva' => ['required', 'string', 'min:8', 'max:72', 'regex:/[A-Za-z]/', 'regex:/\d/', 'different:contrasena_actual', 'confirmed'],
        ], [
            'contrasena_actual.required' => 'Escribe tu contraseña actual.',
            'contrasena_nueva.required' => 'Escribe la contraseña nueva.',
            'contrasena_nueva.min' => 'La contraseña nueva debe tener al menos 8 caracteres.',
            'contrasena_nueva.max' => 'La contraseña nueva no puede pasar de 72 caracteres.',
            'contrasena_nueva.regex' => 'La contraseña nueva debe tener al menos una letra y un número.',
            'contrasena_nueva.different' => 'La contraseña nueva debe ser distinta de la actual.',
            'contrasena_nueva.confirmed' => 'Las dos contraseñas nuevas no coinciden.',
        ]);

        try {
            $gateway->enviar('PUT', 'auth/contrasena', [
                'contrasena_actual' => $datos['contrasena_actual'],
                'contrasena_nueva' => $datos['contrasena_nueva'],
            ]);
        } catch (GatewayException $e) {
            if ($e->sesionVencida() || $e->exigeCambioDeContrasena()) {
                throw $e;
            }

            return back()->withErrors([match (true) {
                $e->codigo === 'CONTRASENA_ACTUAL_INCORRECTA' => 'contrasena_actual',
                default => 'contrasena_nueva',
            } => match (true) {
                $e->codigo === 'CONTRASENA_ACTUAL_INCORRECTA' => 'La contraseña actual no es correcta.',
                $e->esAmbigua() => 'El sistema no está disponible por ahora. Intenta de nuevo en unos minutos.',
                default => $e->getMessage() ?: 'La contraseña nueva no es válida.',
            }]);
        }

        $sesion->marcarCambioPendiente(false);

        return redirect()->route('inicio')->with('exito', 'Listo, cambiaste tu contraseña.');
    }

    public function salir(GatewayClient $gateway, Sesion $sesion): RedirectResponse
    {
        try {
            $gateway->enviar('POST', 'auth/logout');
        } catch (GatewayException) {
            // Cerrar la sesión local es lo que importa: el token se descarta de todas formas.
        }
        $sesion->cerrar();

        return redirect()->route('login')->with('aviso', 'Saliste del sistema.');
    }
}
