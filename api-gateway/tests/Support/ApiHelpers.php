<?php

namespace Tests\Support;

use App\Models\Rol;
use App\Models\Usuario;
use App\Services\Jwt\JwtService;
use App\Support\Roles;
use Database\Seeders\RolSeeder;
use Firebase\JWT\JWT;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Arr;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;
use InvalidArgumentException;

/**
 * Utilidades comunes de las pruebas del Gateway: base de datos limpia con los cuatro roles sembrados,
 * usuarios de prueba y sesiones por token.
 *
 * Incluye RefreshDatabase: Laravel migra antes de llamar a setUpApiHelpers, así que los roles se siembran
 * siempre sobre tablas ya creadas.
 */
trait ApiHelpers
{
    use RefreshDatabase;

    /** Contraseña en texto plano de los usuarios de prueba cuando no se indica otra. */
    protected const CONTRASENA_DE_PRUEBA = 'Contrasena123';

    protected function setUpApiHelpers(): void
    {
        $this->seed(RolSeeder::class);
    }

    /**
     * Crea un usuario guardado, con su rol cargado. `contrasena` (texto plano) se guarda cifrada con bcrypt; el
     * resto de `$attrs` sustituye a los valores por defecto (nombre, correo, id_bodega, activo, ...). El
     * operador de bodega recibe la bodega 1 salvo que se indique otra; los demás roles no tienen bodega.
     *
     * @param  array<string, mixed>  $attrs
     */
    protected function usuario(string $rol = Roles::ADM, array $attrs = []): Usuario
    {
        $idRol = Rol::query()->where('nombre', $rol)->value('id_rol')
            ?? throw new InvalidArgumentException("El rol {$rol} no existe.");

        $contrasena = Arr::pull($attrs, 'contrasena', self::CONTRASENA_DE_PRUEBA);

        $usuario = Usuario::forceCreate([
            'nombre' => 'Usuario de prueba',
            'correo' => 'u'.bin2hex(random_bytes(6)).'@example.test',
            'contrasena_cifrada' => Hash::make($contrasena),
            'id_rol' => $idRol,
            'id_bodega' => $rol === Roles::OPE ? 1 : null,
            'activo' => true,
            'debe_cambiar_contrasena' => false,
            ...$attrs,
        ]);

        return $usuario->load('rol');
    }

    /**
     * Las siguientes peticiones de la prueba llevan el Bearer del usuario, emitido por el JwtService real.
     */
    protected function conSesion(Usuario $usuario): static
    {
        return $this->withToken($this->tokenDe($usuario));
    }

    protected function tokenDe(Usuario $usuario): string
    {
        return app(JwtService::class)->emitir($usuario->loadMissing('rol'))['token'];
    }

    /**
     * Firma un token arbitrario (HS256 con el secreto configurado, salvo que se pase otro) para probar claims
     * que el JwtService nunca emitiría: `sub` raros, roles falsos, usuarios que ya no existen.
     *
     * @param  array<string, mixed>  $claims  sustituyen a las claims por defecto (un usuario VENDEDOR vigente)
     */
    protected function tokenFirmado(array $claims, ?string $secreto = null): string
    {
        $ahora = Carbon::now()->getTimestamp();

        return JWT::encode([
            'sub' => '1',
            'rol' => Roles::VEN,
            'id_bodega' => null,
            'iat' => $ahora,
            'exp' => $ahora + 3600,
            'jti' => bin2hex(random_bytes(16)),
            ...$claims,
        ], $secreto ?? (string) config('gateway.jwt.secret'), 'HS256');
    }
}
