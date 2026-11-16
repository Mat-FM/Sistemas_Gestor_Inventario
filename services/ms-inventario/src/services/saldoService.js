const { scopeBodega } = require('../middleware/identity');
const saldoRepository = require('../repositories/saldoRepository');

/**
 * Lógica de negocio de las consultas de saldos (RF05, RF09; RNF13): aplica el alcance del operador de bodega y decide qué
 * totales se informan. No sabe nada de HTTP (recibe la identidad como dato) ni de SQL.
 *
 * Es una fábrica con sus dependencias inyectadas, como createApp:
 * - db: Knex (o una transacción) sobre la que se ejecuta cada operación.
 * - repo: el repositorio; las pruebas pasan uno falso.
 */
function crearSaldoService({ db, repo = saldoRepository } = {}) {
  return {
    /**
     * Saldos paginados. Un operador de bodega solo ve la suya (scopeBodega): sin `idBodega` se usa la suya y con otra es 403;
     * los demás roles y las llamadas internas (sin X-User-Id) ven cualquier bodega.
     * `cantidadTotal` es la suma de todas las filas del filtro EFECTIVO (el de un operador, su bodega) y solo se informa cuando
     * se pidió un `idProducto` (D10); si no, es undefined.
     * @param {{identity: object, idProducto?: number, idBodega?: number, limit: number, offset: number}} consulta
     * @returns {Promise<{filas: Saldo[], total: number, cantidadTotal: number|undefined}>}
     * @throws 403 SIN_PERMISO
     */
    async listar({ identity, idProducto, idBodega, limit, offset }) {
      const bodegaEfectiva = scopeBodega(identity, idBodega);
      const { filas, total, cantidadTotal } = await repo.list(db, { idProducto, idBodega: bodegaEfectiva, limit, offset });
      return { filas, total, cantidadTotal: idProducto === undefined ? undefined : cantidadTotal };
    },

    /** Productos con total < mínimo (RF09), tal como los entrega el repositorio. @returns {Promise<Array<{id_producto: number, cantidad_total: number, cantidad_minima: number}>>} */
    async bajoUmbral() {
      return repo.bajoUmbral(db);
    },
  };
}

module.exports = { crearSaldoService };
