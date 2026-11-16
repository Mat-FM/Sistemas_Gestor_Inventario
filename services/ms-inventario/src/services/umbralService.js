const { e } = require('../errors');
const { headersDe } = require('../clients/propagacion');
const umbralRepository = require('../repositories/umbralRepository');

/**
 * Lógica de negocio de los umbrales de stock mínimo (RF09, RNF13): confirma el producto en ms-catalogo antes de escribir y no
 * sabe nada de HTTP (recibe la identidad como dato) ni de SQL.
 *
 * Es una fábrica con sus dependencias inyectadas, como createApp:
 * - db: Knex (o una transacción) sobre la que se ejecuta cada operación.
 * - clients: { catalogo }. Se lee `clients.catalogo` en cada llamada y no al construir el servicio, así que se puede
 *   construir sin clientes (rutasDeclaradas() no abre nada).
 * - repo: el repositorio; las pruebas pasan uno falso.
 */
function crearUmbralService({ db, clients, repo = umbralRepository } = {}) {
  return {
    /** @returns {Promise<{filas: Umbral[], total: number}>} */
    async listar({ idProducto, limit, offset }) {
      return repo.list(db, { idProducto, limit, offset });
    },

    /**
     * Crea el umbral del producto o actualiza el que tenía (RF09). Antes de escribir confirma que el producto existe con
     * GET /productos/{id} de ms-catalogo (llamada 1 de la Tabla 2). La llamada remota va SIN ninguna conexión de la base
     * tomada ni transacción abierta: el UPSERT es una sola sentencia que se ejecuta después, sobre el pool.
     * @param {{identity: object, idProducto: number, cantidadMinima: number}} datos ya validados por el controlador
     * @returns {Promise<Umbral>}
     * @throws 404 NO_EXISTE si el catálogo no conoce el producto (no se escribe nada);
     *         503 SERVICIO_NO_DISPONIBLE si ms-catalogo no responde: se propaga tal cual y tampoco se escribe nada
     */
    async guardar({ identity, idProducto, cantidadMinima }) {
      const producto = await clients.catalogo.obtenerProducto(idProducto, headersDe(identity));
      // El cliente devuelve el producto o null; cualquier resultado vacío se trata como inexistente (falla cerrado).
      if (!producto) throw e.noExiste('El producto no existe');
      return repo.upsert(db, idProducto, cantidadMinima);
    },
  };
}

module.exports = { crearUmbralService };
