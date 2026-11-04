<?php

namespace App\Services\Usuarios;

use App\Exceptions\ApiException;
use App\Models\Rol;
use App\Models\Usuario;
use App\Support\Roles;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Hash;

/**
 * Gestión de usuarios y roles (RF07): la capa de usuarios del Gateway, separada del enrutamiento y de la
 * seguridad (RNF13). Los controladores validan la forma de la petición y llaman aquí; las reglas de negocio
 * (rol existente, bodega solo para el operador, correo único, el administrador no se quita el acceso a sí mismo)
 * viven en este servicio.
 *
 * Trabaja con datos ya validados en cuanto a su forma. Nunca devuelve ni registra contraseñas.
 */
class UsuarioService
{
    /**
     * Página de usuarios (con su rol cargado), ordenados por id_usuario.
     *
     * @return LengthAwarePaginator<int, Usuario>
     */
    public function listar(?int $idRol, ?bool $activo, int $pagina, int $porPagina): LengthAwarePaginator
    {
        return Usuario::query()
            ->with('rol')
            ->when($idRol !== null, fn ($consulta) => $consulta->where('id_rol', $idRol))
            ->when($activo !== null, fn ($consulta) => $consulta->where('activo', $activo))
            ->orderBy('id_usuario')
            // El nombre de la página es `pagina` (contrato), no el `page` de Laravel.
            ->paginate($porPagina, ['*'], 'pagina', $pagina);
    }

    /**
     * El usuario con ese id, con su rol cargado; 404 si no existe.
     *
     * El id llega como texto de la ruta y solo vale si son dígitos y caben en un entero: así `1abc` no se
     * convierte en 1 (MySQL lo haría) y un número enorme no llega a la consulta.
     */
    public function obtener(string $id): Usuario
    {
        if (preg_match('/\A[0-9]{1,18}\z/', $id) === 1) {
            $usuario = Usuario::query()->with('rol')->find((int) $id);

            if ($usuario !== null) {
                return $usuario;
            }
        }

        throw ApiException::noExiste('El usuario no existe.');
    }

    /**
     * Crea un usuario activo con una contraseña temporal: debe cambiarla en su primer inicio de sesión.
     *
     * Orden de los rechazos: rol inexistente (404), bodega faltante (422), correo repetido (409).
     *
     * @param  array{nombre: string, correo: string, id_rol: int, id_bodega?: int|null, contrasena_temporal: string}  $datos
     */
    public function crear(array $datos): Usuario
    {
        $rol = $this->rolDelContrato($datos['id_rol']);
        $idBodega = $this->bodegaSegunRol($rol, $datos['id_bodega'] ?? null);
        $correo = Usuario::normalizarCorreo($datos['correo']);
        $this->comprobarCorreoLibre($correo);

        $usuario = new Usuario;
        $usuario->nombre = $datos['nombre'];
        $usuario->correo = $correo;
        $usuario->contrasena_cifrada = Hash::make($datos['contrasena_temporal']);
        $usuario->id_rol = $rol->id_rol;
        $usuario->id_bodega = $idBodega;
        $usuario->activo = true;
        $usuario->debe_cambiar_contrasena = true;
        $this->guardar($usuario);

        // Se relee para traer lo que pone la base (`fecha_creacion`) y el rol.
        return $usuario->refresh()->load('rol');
    }

    /**
     * Reemplaza nombre, correo, rol y bodega. No toca la contraseña, el estado ni el cambio pendiente.
     *
     * Orden de los rechazos: rol inexistente (404), bodega faltante (422), un administrador que se quita el
     * rol a sí mismo (409 CONFLICTO), correo repetido (409 CORREO_DUPLICADO). Otro administrador sí puede
     * cambiarle el rol.
     *
     * @param  array{nombre: string, correo: string, id_rol: int, id_bodega?: int|null}  $datos
     */
    public function actualizar(Usuario $usuario, array $datos, Usuario $actor): Usuario
    {
        $rol = $this->rolDelContrato($datos['id_rol']);
        $idBodega = $this->bodegaSegunRol($rol, $datos['id_bodega'] ?? null);

        if ($usuario->is($actor) && $rol->nombre !== Roles::ADM) {
            throw ApiException::conflicto('CONFLICTO', 'Un administrador no puede cambiarse a sí mismo a otro rol.');
        }

        $correo = Usuario::normalizarCorreo($datos['correo']);
        $this->comprobarCorreoLibre($correo, $usuario);

        $usuario->nombre = $datos['nombre'];
        $usuario->correo = $correo;
        $usuario->id_rol = $rol->id_rol;
        $usuario->id_bodega = $idBodega;
        $this->guardar($usuario);

        // `load` vuelve a consultar el rol: sin él la respuesta traería el id nuevo con el nombre del rol viejo.
        return $usuario->load('rol');
    }

    /**
     * Inactiva al usuario (los usuarios no se borran): ya no puede iniciar sesión y su token deja de servir en la
     * petición siguiente. Un administrador no puede inactivarse a sí mismo: quedaría sin acceso, y la recuperación
     * de contraseña es solo por administrador (D10). Es idempotente.
     */
    public function inactivar(Usuario $usuario, Usuario $actor): Usuario
    {
        if ($usuario->is($actor)) {
            throw ApiException::conflicto('CONFLICTO', 'Un administrador no puede inactivarse a sí mismo.');
        }

        $usuario->activo = false;
        $usuario->save();

        return $usuario;
    }

    /** Vuelve a activar al usuario. Es idempotente. */
    public function activar(Usuario $usuario): Usuario
    {
        $usuario->activo = true;
        $usuario->save();

        return $usuario;
    }

    /**
     * Fija una contraseña temporal (cifrada con bcrypt) y deja el cambio pendiente: la anterior deja de servir y,
     * mientras no la cambie, el usuario solo puede cambiar su contraseña o cerrar sesión (RF08).
     */
    public function restablecerContrasena(Usuario $usuario, string $contrasenaTemporal): void
    {
        $usuario->contrasena_cifrada = Hash::make($contrasenaTemporal);
        $usuario->debe_cambiar_contrasena = true;
        $usuario->save();
    }

    /**
     * Los roles del sistema, ordenados por id_rol, en una sola página (son un conjunto fijo y pequeño: los cuatro
     * de la Tabla 6 de la Entrega 1), para darles la forma común de los listados.
     *
     * @return LengthAwarePaginator<int, Rol>
     */
    public function listarRoles(): LengthAwarePaginator
    {
        $roles = Rol::query()->orderBy('id_rol')->get();

        return new LengthAwarePaginator($roles, $roles->count(), max($roles->count(), 1), 1);
    }

    /** D8: un `id_rol` que no existe es 404 (no 422), como dice el contrato. */
    private function rolDelContrato(int $idRol): Rol
    {
        return Rol::query()->find($idRol) ?? throw ApiException::noExiste('El rol indicado no existe.');
    }

    /**
     * D9: solo el operador de bodega tiene `id_bodega` y es obligatorio; los demás roles la guardan en null aunque
     * venga una. No se valida contra ms-inventario: la Tabla 2 no define esa llamada.
     */
    private function bodegaSegunRol(Rol $rol, ?int $idBodega): ?int
    {
        if ($rol->nombre !== Roles::OPE) {
            return null;
        }

        return $idBodega ?? throw ApiException::datosNoValidos([
            ['campo' => 'id_bodega', 'mensaje' => 'El campo id_bodega es obligatorio para el rol OPERADOR_BODEGA.'],
        ]);
    }

    /**
     * 409 CORREO_DUPLICADO si otro usuario ya tiene ese correo (ya normalizado). Al editar se excluye al propio
     * usuario, para que conservar su correo, o solo cambiar el uso de mayúsculas, no sea un conflicto.
     */
    private function comprobarCorreoLibre(string $correo, ?Usuario $excepto = null): void
    {
        $ocupado = Usuario::query()
            ->where('correo', $correo)
            ->when($excepto !== null, fn ($consulta) => $consulta->whereKeyNot($excepto->getKey()))
            ->exists();

        if ($ocupado) {
            throw self::correoDuplicado();
        }
    }

    /**
     * Guarda el usuario. Si otra petición tomó el correo entre la comprobación y el guardado, la restricción
     * única de la base lo detecta y también es 409 (y no un 500).
     */
    private function guardar(Usuario $usuario): void
    {
        try {
            $usuario->save();
        } catch (UniqueConstraintViolationException) {
            throw self::correoDuplicado();
        }
    }

    private static function correoDuplicado(): ApiException
    {
        return ApiException::conflicto('CORREO_DUPLICADO', 'Ya existe un usuario con ese correo.');
    }
}
