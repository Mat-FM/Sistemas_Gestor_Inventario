<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Models\Proveedor;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Validator;

/**
 * Reglas de negocio de los proveedores (RF03). No sabe nada de HTTP: lo usan los controladores.
 */
class ProveedorService
{
    /**
     * Reglas de validación de un proveedor. Todos los campos son obligatorios (el contrato no marca
     * ninguno como opcional). Las usan POST /proveedores, PUT /proveedores/{id} y la carga masiva.
     *
     * @param  bool  $conNit  falso en la actualización, porque el NIT no se puede editar
     */
    public static function reglas(bool $conNit = true): array
    {
        $reglas = [
            'razon_social' => ['required', 'string', 'max:150'],
            'nombre_contacto' => ['required', 'string', 'max:100'],
            'telefono' => ['required', 'string', 'max:20'],
            'correo' => ['required', 'string', 'email', 'max:255'],
            'direccion' => ['required', 'string', 'max:255'],
        ];

        if ($conNit) {
            $reglas = ['nit' => ['required', 'string', 'max:20']] + $reglas;
        }

        return $reglas;
    }

    /**
     * Listado paginado. ?nit busca el NIT exacto; ?razon_social, por parte del nombre;
     * ?id_producto, los proveedores que tienen asociado ese producto.
     */
    public function listar(array $filtros, int $pagina, int $porPagina): LengthAwarePaginator
    {
        $consulta = Proveedor::query()->orderBy('id_proveedor');

        if (isset($filtros['nit'])) {
            $consulta->where('nit', $filtros['nit']);
        }
        if (isset($filtros['razon_social'])) {
            $consulta->where('razon_social', 'like', '%'.$filtros['razon_social'].'%');
        }
        if (isset($filtros['estado'])) {
            $consulta->where('estado', $filtros['estado']);
        }
        if (isset($filtros['id_producto'])) {
            $consulta->whereHas('productos', fn ($q) => $q->where('id_producto', $filtros['id_producto']));
        }

        // El parámetro de la página se llama `pagina` (contrato), no el `page` de Laravel.
        return $consulta->paginate($porPagina, ['*'], 'pagina', $pagina);
    }

    public function buscar(int $id): Proveedor
    {
        return Proveedor::find($id) ?? throw ApiException::noExiste('El proveedor no existe.');
    }

    /** Crea el proveedor en estado ACTIVO. El NIT no se puede repetir (409 NIT_DUPLICADO). */
    public function crear(array $datos): Proveedor
    {
        if (Proveedor::where('nit', $datos['nit'])->exists()) {
            throw ApiException::conflicto('NIT_DUPLICADO', 'Ya existe un proveedor con ese NIT.');
        }

        $proveedor = Proveedor::create($datos + ['estado' => 'ACTIVO']);

        // Se recarga para devolverlo con todos sus campos, igual que al consultarlo.
        return $proveedor->refresh();
    }

    /**
     * Carga masiva con éxito parcial (RF16): cada fila se valida y se crea por separado, con las mismas
     * reglas de POST /proveedores. Las válidas se guardan y las inválidas se reportan en `rechazados`.
     * `fila` es la posición en la lista, empezando en 1. Si un NIT se repite (en la base o dentro del
     * mismo lote), gana la primera aparición: las demás chocan con el NIT ya creado y se rechazan.
     *
     * @return array{creados: int, rechazados: list<array{fila: int, motivo: string}>}
     */
    public function crearLote(array $filas): array
    {
        $creados = 0;
        $rechazados = [];

        foreach ($filas as $indice => $fila) {
            $numeroFila = $indice + 1;

            if (! is_array($fila)) {
                $rechazados[] = ['fila' => $numeroFila, 'motivo' => 'La fila debe ser un objeto con los datos del proveedor.'];

                continue;
            }

            $validador = Validator::make($fila, self::reglas());
            if ($validador->fails()) {
                // Todos los errores de la fila en un solo texto, para corregirlos de una vez.
                $rechazados[] = ['fila' => $numeroFila, 'motivo' => implode(' ', $validador->errors()->all())];

                continue;
            }

            try {
                $this->crear($validador->validated());
                $creados++;
            } catch (ApiException $e) {
                // NIT_DUPLICADO: ya existe en la base o apareció antes en este lote.
                $rechazados[] = ['fila' => $numeroFila, 'motivo' => $e->getMessage()];
            }
        }

        return ['creados' => $creados, 'rechazados' => $rechazados];
    }

    /** Actualiza los datos del proveedor. El NIT no está en $datos: no es editable. */
    public function actualizar(int $id, array $datos): Proveedor
    {
        $proveedor = $this->buscar($id);
        $proveedor->update($datos);

        return $proveedor;
    }

    /**
     * Activa o inactiva el proveedor. Nunca se borra (RF03). Si ya está en ese estado,
     * se devuelve sin cambios.
     */
    public function cambiarEstado(int $id, string $estado): Proveedor
    {
        $proveedor = $this->buscar($id);
        $proveedor->update(['estado' => $estado]);

        return $proveedor;
    }
}
