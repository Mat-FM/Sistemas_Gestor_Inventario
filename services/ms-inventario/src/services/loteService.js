const { e } = require('../errors');
const { scopeBodega } = require('../middleware/identity');
const loteRepository = require('../repositories/loteRepository');
const { planificarFefo } = require('./stockService');

// Lógica de negocio de las consultas de lotes (RF17; RNF13): la lista de lotes (GET /lotes) y la sugerencia de salida FEFO (GET
// /lotes/sugerencia-salida). No sabe nada de HTTP: recibe el filtro y la identidad como datos. El SQL vive en el repositorio. Son
// lecturas: no llaman al catálogo ni a notificaciones, y no toman ni esperan bloqueos (los lotes los cambia el motor de
// movimientos, stockService).
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

/**
 * Sugerencia de salida FEFO (RF17): de qué lotes sacar `cantidad` unidades de un producto en una bodega, del que vence primero
 * al último, con la MISMA regla pura que aplica el motor al sacar sin id_lote (stockService.planificarFefo) sobre los mismos
 * lotes en el mismo orden (loteRepository.listarConExistencia es listarParaFefo sin el bloqueo). Es una CONSULTA: no reserva
 * nada, no toma FOR UPDATE y no cambia ningún dato, así que el stock puede cambiar entre la sugerencia y la salida.
 * - D16: asigna SOLO desde lotes. Si no alcanzan, 409 STOCK_INSUFICIENTE (disponible = la suma de las existencias de los lotes),
 *   aunque el saldo sí alcance con stock sin lote: la salida real sí lo sacaría, pero no hay un lote que sugerir para ese resto.
 * - Un operador de bodega solo consulta la suya (scopeBodega: otra bodega, o sin bodega asignada, es 403). `idBodega` es
 *   obligatorio y lo exige el controlador; al operador no se le rellena con la suya.
 * - La suma de `cantidad_sugerida` es exactamente `cantidad`; ningún lote aparece con 0.
 * @param {{db: object}} deps
 * @param {{identity: object, idProducto: number, idBodega: number, cantidad: number}} peticion ya validados (enteros positivos
 *   dentro del INTEGER)
 * @returns {Promise<Array<{id_lote: number, codigo_lote: string, fecha_vencimiento: string|null, cantidad_sugerida: number}>>}
 * @throws 403 SIN_PERMISO, 409 STOCK_INSUFICIENTE
 */
async function sugerirSalida({ db }, { identity, idProducto, idBodega, cantidad }) {
  const bodegaEfectiva = scopeBodega(identity, idBodega);
  const lotes = await loteRepository.listarConExistencia(db, { idBodega: bodegaEfectiva, idProducto });
  const { asignaciones, restante } = planificarFefo(lotes, cantidad);
  if (restante > 0) {
    // planificarFefo toma TODO lo que hay cuando no alcanza: lo disponible en lotes es lo pedido menos lo que faltó.
    const disponible = cantidad - restante;
    throw e.conflicto('STOCK_INSUFICIENTE', 'Los lotes de la bodega no alcanzan para la cantidad pedida: la sugerencia se calcula solo con lotes', [
      { campo: 'cantidad', mensaje: `Disponible en lotes: ${disponible}; solicitado: ${cantidad}`, disponible, solicitado: cantidad },
    ]);
  }
  const porId = new Map(lotes.map((lote) => [lote.id_lote, lote]));
  return asignaciones.map(({ id_lote: idLote, cantidad: cantidadSugerida }) => ({
    id_lote: idLote,
    codigo_lote: porId.get(idLote).codigo_lote,
    fecha_vencimiento: porId.get(idLote).fecha_vencimiento,
    cantidad_sugerida: cantidadSugerida,
  }));
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearLoteService(deps = {}) {
  return {
    listar: (consulta) => listarLotes(deps, consulta),
    sugerirSalida: (peticion) => sugerirSalida(deps, peticion),
  };
}

module.exports = { listarLotes, sugerirSalida, crearLoteService };
