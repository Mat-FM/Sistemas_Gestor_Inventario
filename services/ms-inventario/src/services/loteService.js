const { scopeBodega } = require('../middleware/identity');
const loteRepository = require('../repositories/loteRepository');

// Lógica de negocio de las consultas de lotes (RF17; RNF13): la lista de lotes (GET /lotes). No sabe nada de HTTP: recibe el
// filtro y la identidad como datos. El SQL vive en el repositorio. Son lecturas: no llaman al catálogo ni a notificaciones, y no
// toman ni esperan bloqueos (los lotes los cambia el motor de movimientos, stockService).
//
// Las dependencias llegan en `deps` = { db } y se leen en cada llamada (no al construir), como en el resto de servicios:
// rutasDeclaradas() se puede llamar sin dependencias.

/**
 * Una página de lotes en orden FEFO (RF17). Un operador de bodega solo ve la suya (scopeBodega): sin `idBodega` se usa la suya y
 * con otra es 403; los demás roles y las llamadas internas (sin X-User-Id, D8: ms-notificaciones y ms-reportes) ven cualquier
 * bodega. `total` es el de las filas del filtro EFECTIVO (el de un operador, su bodega): no revela cuántos lotes hay en otras
 * bodegas.
 * @param {{db: object}} deps
 * @param {{identity: object, idProducto?: number, idBodega?: number, venceAntesDe?: string, conExistencia?: boolean, limit: number,
 *   offset: number}} consulta venceAntesDe es una fecha `YYYY-MM-DD` ya validada; la comparación es estricta
 * @returns {Promise<{filas: Lote[], total: number}>}
 * @throws 403 SIN_PERMISO
 */
async function listarLotes({ db }, { identity, idProducto, idBodega, venceAntesDe, conExistencia, limit, offset }) {
  const bodegaEfectiva = scopeBodega(identity, idBodega);
  return loteRepository.listar(db, { idProducto, idBodega: bodegaEfectiva, venceAntesDe, conExistencia, limit, offset });
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearLoteService(deps = {}) {
  return {
    listar: (consulta) => listarLotes(deps, consulta),
  };
}

module.exports = { listarLotes, crearLoteService };
