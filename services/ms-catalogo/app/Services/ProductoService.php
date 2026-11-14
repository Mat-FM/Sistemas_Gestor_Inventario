<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Models\Categoria;
use App\Models\Producto;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Validator;

/**
 * Reglas de negocio de los productos (RF01) y su búsqueda (RF12). No sabe nada de HTTP.
 */
class ProductoService
{
    public function __construct(private ProveedoresCliente $proveedores) {}

    /**
     * Reglas de validación de un producto. Las usan POST /productos, PUT /productos/{id} y la carga masiva.
     *
     * @param  bool  $conCodigo  falso en la actualización, porque el código no se puede editar
     */
    public static function reglas(bool $conCodigo = true): array
    {
        $reglas = [
            'nombre' => ['required', 'string', 'max:150'],
            'descripcion' => ['nullable', 'string', 'max:500'],
            'id_categoria' => ['required', 'integer', 'min:1'],
            'unidad_medida' => ['required', 'string', 'max:20'],
            // decimal(12,2): hasta 9.999.999.999,99 pesos.
            'precio' => ['required', 'numeric', 'min:0', 'max:9999999999.99'],
        ];

        if ($conCodigo) {
            $reglas = ['codigo' => ['required', 'string', 'max:30']] + $reglas;
        }

        return $reglas;
    }

    /**
     * Listado paginado (RF12). ?nombre y ?codigo buscan por parte del texto; ?id_categoria incluye los productos
     * de sus subcategorías; ?id_proveedor pide a ms-proveedores los productos de ese proveedor (llamada 8).
     */
    public function listar(array $filtros, int $pagina, int $porPagina): LengthAwarePaginator
    {
        $consulta = Producto::query()->orderBy('id_producto');

        if (isset($filtros['nombre'])) {
            $consulta->where('nombre', 'like', '%'.$filtros['nombre'].'%');
        }
        if (isset($filtros['codigo'])) {
            $consulta->where('codigo', 'like', '%'.$filtros['codigo'].'%');
        }
        if (isset($filtros['estado'])) {
            $consulta->where('estado', $filtros['estado']);
        }
        if (isset($filtros['id_categoria'])) {
            $id = (int) $filtros['id_categoria'];
            $ids = Categoria::where('id_categoria_padre', $id)->pluck('id_categoria')->push($id);
            $consulta->whereIn('id_categoria', $ids);
        }
        if (isset($filtros['id_proveedor'])) {
            // Puede lanzar 503 si ms-proveedores no responde.
            $consulta->whereIn('id_producto', $this->proveedores->idsDeProductos((int) $filtros['id_proveedor']));
        }

        // El parámetro de la página se llama `pagina` (contrato), no el `page` de Laravel.
        return $consulta->paginate($porPagina, ['*'], 'pagina', $pagina);
    }

    public function buscar(int $id): Producto
    {
        return Producto::find($id) ?? throw ApiException::noExiste('El producto no existe.');
    }

    /** Crea el producto en estado ACTIVO. 404 si la categoría no existe; 409 CODIGO_DUPLICADO. */
    public function crear(array $datos): Producto
    {
        $this->validarCategoria($datos['id_categoria']);

        if (Producto::where('codigo', $datos['codigo'])->exists()) {
            throw ApiException::conflicto('CODIGO_DUPLICADO', 'Ya existe un producto con ese código.');
        }

        $producto = Producto::create($this->completar($datos) + ['estado' => 'ACTIVO']);

        // Se recarga para devolverlo con todos sus campos, igual que al consultarlo.
        return $producto->refresh();
    }

    /**
     * Carga masiva (RF16): crea cada fila válida y rechaza las demás con su número de fila (desde 1) y el motivo.
     * Cada fila cumple las mismas reglas que POST /productos.
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
                $rechazados[] = ['fila' => $numeroFila, 'motivo' => 'La fila debe ser un objeto con los datos del producto.'];

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
                // Categoría inexistente, o CODIGO_DUPLICADO: ya existe en la base o apareció antes en este lote.
                $rechazados[] = ['fila' => $numeroFila, 'motivo' => $e->getMessage()];
            }
        }

        return ['creados' => $creados, 'rechazados' => $rechazados];
    }

    /** Reemplaza los datos del producto. El código no está en $datos: no es editable. */
    public function actualizar(int $id, array $datos): Producto
    {
        $producto = $this->buscar($id);
        $this->validarCategoria($datos['id_categoria']);
        $producto->update($this->completar($datos));

        return $producto;
    }

    /** Da de baja (INACTIVO) o reactiva el producto. Nunca se borra (RF01). Sin cambio, se devuelve igual. */
    public function cambiarEstado(int $id, string $estado): Producto
    {
        $producto = $this->buscar($id);
        $producto->update(['estado' => $estado]);

        return $producto;
    }

    private function validarCategoria(int|string $idCategoria): void
    {
        if (! Categoria::whereKey((int) $idCategoria)->exists()) {
            throw ApiException::noExiste('La categoría no existe.');
        }
    }

    /** La descripción es opcional: si no llega, queda vacía (también al actualizar). */
    private function completar(array $datos): array
    {
        return ['descripcion' => $datos['descripcion'] ?? null] + $datos;
    }
}
