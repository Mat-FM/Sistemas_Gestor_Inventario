<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Models\Categoria;
use Illuminate\Database\Eloquent\Collection;

/**
 * Reglas de negocio de las categorías y subcategorías (RF02). Solo hay dos niveles:
 * una categoría principal (sin padre) y sus subcategorías.
 */
class CategoriaService
{
    /** Reglas de validación de POST y PUT /categorias. */
    public static function reglas(): array
    {
        return [
            'nombre' => ['required', 'string', 'max:100'],
            'descripcion' => ['nullable', 'string', 'max:255'],
            'id_categoria_padre' => ['nullable', 'integer', 'min:1'],
        ];
    }

    /**
     * Sin filtros, todas las categorías en una lista plana. Con $idPadre, solo las subcategorías de esa
     * categoría. Con $arbol, las categorías principales, cada una con sus subcategorías.
     */
    public function listar(?int $idPadre, bool $arbol): Collection
    {
        if ($arbol) {
            return Categoria::whereNull('id_categoria_padre')
                ->with(['subcategorias' => fn ($q) => $q->orderBy('nombre')])
                ->orderBy('nombre')
                ->get();
        }

        return Categoria::query()
            ->when($idPadre !== null, fn ($q) => $q->where('id_categoria_padre', $idPadre))
            ->orderBy('nombre')
            ->get();
    }

    public function buscar(int $id): Categoria
    {
        return Categoria::find($id) ?? throw ApiException::noExiste('La categoría no existe.');
    }

    public function crear(array $datos): Categoria
    {
        $datos = $this->completar($datos);
        $this->validarPadre(null, $datos['id_categoria_padre']);
        $this->validarNombreUnico($datos['nombre'], $datos['id_categoria_padre'], null);

        // Se recarga para devolverla con todos sus campos, igual que al consultarla.
        return Categoria::create($datos)->refresh();
    }

    /** Reemplaza los datos de la categoría: lo que no se envía queda vacío (igual que POST). */
    public function actualizar(int $id, array $datos): Categoria
    {
        $categoria = $this->buscar($id);
        $datos = $this->completar($datos);
        $this->validarPadre($categoria, $datos['id_categoria_padre']);
        $this->validarNombreUnico($datos['nombre'], $datos['id_categoria_padre'], $categoria->id_categoria);

        $categoria->update($datos);

        return $categoria;
    }

    /** Las categorías sí se borran, pero solo si no tienen productos ni subcategorías (409 CATEGORIA_EN_USO). */
    public function eliminar(int $id): void
    {
        $categoria = $this->buscar($id);

        if ($categoria->productos()->exists() || $categoria->subcategorias()->exists()) {
            throw ApiException::conflicto('CATEGORIA_EN_USO', 'La categoría tiene productos o subcategorías.');
        }

        $categoria->delete();
    }

    /** Los campos opcionales que no llegan quedan en null. */
    private function completar(array $datos): array
    {
        return [
            'nombre' => $datos['nombre'],
            'descripcion' => $datos['descripcion'] ?? null,
            'id_categoria_padre' => isset($datos['id_categoria_padre']) ? (int) $datos['id_categoria_padre'] : null,
        ];
    }

    /**
     * Reglas del padre: debe existir (404), no puede ser la misma categoría y, como solo hay dos niveles,
     * debe ser una categoría principal y la categoría no puede tener subcategorías propias (422).
     */
    private function validarPadre(?Categoria $categoria, ?int $idPadre): void
    {
        if ($idPadre === null) {
            return;
        }

        if ($categoria !== null && $idPadre === $categoria->id_categoria) {
            throw $this->errorDePadre('Una categoría no puede ser su propia padre.');
        }

        $padre = Categoria::find($idPadre) ?? throw ApiException::noExiste('La categoría padre no existe.');

        if ($padre->id_categoria_padre !== null) {
            throw $this->errorDePadre('La categoría padre debe ser una categoría principal: solo hay dos niveles.');
        }

        if ($categoria !== null && $categoria->subcategorias()->exists()) {
            throw $this->errorDePadre('Una categoría con subcategorías no puede ser subcategoría: solo hay dos niveles.');
        }
    }

    private function errorDePadre(string $mensaje): ApiException
    {
        return ApiException::datosNoValidos([['campo' => 'id_categoria_padre', 'mensaje' => $mensaje]]);
    }

    /** No puede haber dos categorías con el mismo nombre en el mismo nivel (409 NOMBRE_DUPLICADO). */
    private function validarNombreUnico(string $nombre, ?int $idPadre, ?int $idExcluir): void
    {
        $existe = Categoria::where('nombre', $nombre)
            ->when($idPadre === null,
                fn ($q) => $q->whereNull('id_categoria_padre'),
                fn ($q) => $q->where('id_categoria_padre', $idPadre))
            ->when($idExcluir !== null, fn ($q) => $q->where('id_categoria', '!=', $idExcluir))
            ->exists();

        if ($existe) {
            throw ApiException::conflicto('NOMBRE_DUPLICADO', 'Ya existe una categoría con ese nombre en el mismo nivel.');
        }
    }
}
