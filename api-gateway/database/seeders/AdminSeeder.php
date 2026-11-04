<?php

namespace Database\Seeders;

use App\Models\Rol;
use App\Models\Usuario;
use App\Rules\ContrasenaValida;
use App\Support\Roles;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use RuntimeException;

class AdminSeeder extends Seeder
{
    /**
     * Crea el primer administrador con ADMIN_EMAIL y ADMIN_PASSWORD, con el cambio de contraseña pendiente. Si ya
     * existe un usuario con ese correo no lo toca: ni su contraseña, ni su estado, ni su rol.
     *
     * El correo se guarda normalizado (sin espacios y en minúsculas, como lo busca el inicio de sesión) y
     * ADMIN_PASSWORD debe cumplir la política de contraseñas (D4), porque es una contraseña temporal más. El
     * inicio de sesión recorta los espacios de los extremos de lo que recibe, así que aquí se hace lo mismo
     * antes de cifrar: de otro modo la cuenta quedaría inalcanzable. Los errores nunca imprimen la contraseña.
     */
    public function run(): void
    {
        $correo = config('gateway.admin.correo');
        $contrasena = config('gateway.admin.contrasena');

        $faltantes = [];
        if (! is_string($correo) || trim($correo) === '') {
            $faltantes[] = 'ADMIN_EMAIL';
        }
        if (! is_string($contrasena) || trim($contrasena) === '') {
            $faltantes[] = 'ADMIN_PASSWORD';
        }
        if ($faltantes !== []) {
            throw new RuntimeException(sprintf(
                'No se puede crear el primer administrador: defina %s en el entorno.',
                implode(' y ', $faltantes),
            ));
        }

        $contrasena = trim($contrasena);
        if (! ContrasenaValida::cumple($contrasena)) {
            throw new RuntimeException(sprintf(
                'No se puede crear el primer administrador: ADMIN_PASSWORD no es válida. %s',
                ContrasenaValida::MENSAJE,
            ));
        }

        $rol = Rol::where('nombre', Roles::ADM)->first();
        if ($rol === null) {
            throw new RuntimeException(sprintf(
                'No se puede crear el primer administrador: no existe el rol %s. Ejecute RolSeeder antes que AdminSeeder.',
                Roles::ADM,
            ));
        }

        Usuario::unguarded(fn () => Usuario::firstOrCreate(
            ['correo' => Usuario::normalizarCorreo($correo)],
            [
                'nombre' => 'Administrador',
                'contrasena_cifrada' => Hash::make($contrasena),
                'id_rol' => $rol->id_rol,
                'debe_cambiar_contrasena' => true,
            ],
        ));
    }
}
