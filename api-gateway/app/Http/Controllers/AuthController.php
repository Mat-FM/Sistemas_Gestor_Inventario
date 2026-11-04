<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Http\Resources\UsuarioResource;
use App\Models\Usuario;
use App\Rules\ContrasenaValida;
use App\Services\Jwt\JwtService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Inicio y cierre de sesión, usuario autenticado y cambio de contraseña (RF08). Solo coordina: el JWT lo emite
 * JwtService, la política de contraseñas es ContrasenaValida y la forma de la respuesta es UsuarioResource.
 */
class AuthController extends Controller
{
    private const MENSAJES = [
        'correo.required' => 'El correo es obligatorio.',
        'correo.string' => 'El correo debe ser texto.',
        'correo.max' => 'El correo no puede superar los 255 caracteres.',
        'contrasena.required' => 'La contraseña es obligatoria.',
        'contrasena.string' => 'La contraseña debe ser texto.',
        'contrasena.max' => 'La contraseña no puede superar los 255 caracteres.',
        'contrasena_actual.required' => 'La contraseña actual es obligatoria.',
        'contrasena_actual.string' => 'La contraseña actual debe ser texto.',
        'contrasena_actual.max' => 'La contraseña actual no puede superar los 255 caracteres.',
        'contrasena_nueva.required' => 'La contraseña nueva es obligatoria.',
        'contrasena_nueva.string' => 'La contraseña nueva debe ser texto.',
        'contrasena_nueva.different' => 'La contraseña nueva debe ser distinta de la actual.',
    ];

    /** Hash bcrypt de una cadena aleatoria, con el costo configurado; se calcula una vez por proceso. */
    private static ?string $hashFalso = null;

    /**
     * POST /api/auth/login (público).
     *
     * Un correo inexistente y una contraseña errónea dan exactamente la misma respuesta, y cuestan lo mismo: si
     * el correo no existe se compara igualmente contra un hash falso para que el tiempo de respuesta no delate
     * si la cuenta existe. Solo después de comprobar la contraseña se revisa `activo`.
     */
    public function login(Request $request, JwtService $jwt): JsonResponse
    {
        $datos = $request->validate([
            'correo' => ['required', 'string', 'max:255'],
            'contrasena' => ['required', 'string', 'max:255'],
        ], self::MENSAJES);

        // Con la relación `rol` cargada: JwtService::emitir() la exige.
        $usuario = Usuario::query()->with('rol')
            ->where('correo', Usuario::normalizarCorreo($datos['correo']))
            ->first();

        $contrasenaCorrecta = Hash::check($datos['contrasena'], $usuario?->contrasena_cifrada ?? self::hashFalso());

        if ($usuario === null || ! $contrasenaCorrecta) {
            throw self::credencialesInvalidas();
        }

        if (! $usuario->activo) {
            throw new ApiException(403, 'USUARIO_INACTIVO', 'El usuario está inactivo.');
        }

        return response()->json([
            ...$jwt->emitir($usuario),
            'usuario' => UsuarioResource::deSesion($usuario),
        ]);
    }

    /**
     * POST /api/auth/logout. Sin revocación (no hay sesión en el servidor): el token sigue vigente hasta
     * vencer y es el cliente quien lo borra.
     */
    public function logout(): Response
    {
        return response()->noContent();
    }

    /** GET /api/auth/me. */
    public function me(Request $request): UsuarioResource
    {
        return new UsuarioResource($this->usuarioActual($request));
    }

    /**
     * PUT /api/auth/contrasena. Con el cambio pendiente es una de las dos rutas que dejan pasar.
     */
    public function cambiarContrasena(Request $request): Response
    {
        $usuario = $this->usuarioActual($request);

        $datos = $request->validate([
            'contrasena_actual' => ['required', 'string', 'max:255'],
            // `bail`: un solo mensaje por campo (la política o "distinta de la actual", no ambos).
            'contrasena_nueva' => ['bail', 'required', 'string', new ContrasenaValida, 'different:contrasena_actual'],
        ], self::MENSAJES);

        if (! Hash::check($datos['contrasena_actual'], $usuario->contrasena_cifrada)) {
            throw new ApiException(401, 'CONTRASENA_ACTUAL_INCORRECTA', 'La contraseña actual es incorrecta.');
        }

        $usuario->contrasena_cifrada = Hash::make($datos['contrasena_nueva']);
        $usuario->debe_cambiar_contrasena = false;
        $usuario->save();

        return response()->noContent();
    }

    /** Único punto que construye el rechazo de credenciales, para que todas las causas sean idénticas. */
    private static function credencialesInvalidas(): ApiException
    {
        return new ApiException(401, 'CREDENCIALES_INVALIDAS', 'Correo o contraseña incorrectos.');
    }

    private static function hashFalso(): string
    {
        return self::$hashFalso ??= Hash::make(Str::random(40));
    }

    /** El usuario que dejó AuthenticateJwt; sin él (cadena de middleware mal armada) es 401 y no un error interno. */
    private function usuarioActual(Request $request): Usuario
    {
        $usuario = $request->attributes->get('usuario');

        if (! $usuario instanceof Usuario) {
            throw ApiException::noAutenticado();
        }

        return $usuario;
    }
}
