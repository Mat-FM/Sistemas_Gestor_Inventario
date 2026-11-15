// Acceso a datos de la tabla `lotes` (RNF13, RF17): aquí vive todo su SQL y nada de lógica de negocio (las reglas de D27 son del
// motor, stockService). Todas las funciones reciben primero `dbOrTrx`, la instancia de Knex o una transacción: el motor las usa
// dentro de la transacción que ya bloqueó el saldo del mismo (producto, bodega).
//
// Un Lote es { id_lote, id_producto, id_bodega, codigo_lote, fecha_vencimiento, cantidad_disponible }: `fecha_vencimiento` es el
// texto YYYY-MM-DD de la base o null (config/db.js registra el parser de `date`, Ruling 15) y `cantidad_disponible` un número.
//
// Toda función es `async` (Ruling 21); lotesCapas.test.js lo comprueba con la lista de las exportadas.

const TABLA = 'lotes';
const COLUMNAS = ['id_lote', 'id_producto', 'id_bodega', 'codigo_lote', 'fecha_vencimiento', 'cantidad_disponible'];

// Orden FEFO (D6): el primero en vencer primero, los lotes sin fecha al final y, a igual fecha, el id más bajo. Es un orden total
// (id_lote es único), el mismo que aplica stockService.planificarFefo.
const ORDEN_FEFO = 'fecha_vencimiento ASC NULLS LAST, id_lote ASC';

/**
 * Entrada a un lote por su código, en UNA sentencia atómica:
 * `INSERT … ON CONFLICT (id_bodega, id_producto, codigo_lote) DO UPDATE SET cantidad_disponible = lotes.cantidad_disponible +
 * EXCLUDED.cantidad_disponible WHERE <la fecha no contradice la guardada>`.
 * - Si el lote no existe, lo crea con `cantidad` y `fechaVencimiento` (null si no se da).
 * - Si existe y `fechaVencimiento` es null, suma sin tocar la fecha guardada.
 * - Si existe y `fechaVencimiento` es IGUAL a la guardada, suma.
 * - Si existe y `fechaVencimiento` es DISTINTA de la guardada (también si la guardada es null), NO suma y devuelve undefined
 *   (el motor responde 409 CONFLICTO, D27(d)).
 * Por qué una sola sentencia y no «leer FOR UPDATE y después decidir»: la condición de la fecha se evalúa en el DO UPDATE sobre la
 * versión ya confirmada de la fila, que PostgreSQL deja bloqueada aunque no la actualice. Dos entradas simultáneas con el mismo
 * código nuevo no chocan (la segunda espera en el índice único y suma) y no hay ventana entre leer y escribir, aunque quien llame
 * no haya bloqueado antes el saldo. La comparación es de `date` contra `date` en SQL, nunca de objetos Date en JS.
 * No valida: `cantidad` > 0 y el código recortado los garantiza quien llama; el techo del INTEGER lo garantiza el invariante de
 * D27(c) (la suma de los lotes no supera el saldo, que el motor ya comprobó).
 * @param {{idBodega: number, idProducto: number, codigoLote: string, fechaVencimiento: string|null, cantidad: number}} datos
 * @returns {Promise<Lote|undefined>} el lote creado o sumado; undefined si existe con otra fecha de vencimiento
 */
async function upsertEntrada(trx, { idBodega, idProducto, codigoLote, fechaVencimiento, cantidad }) {
  const filas = await trx(TABLA)
    .insert({
      id_bodega: idBodega, id_producto: idProducto, codigo_lote: codigoLote, fecha_vencimiento: fechaVencimiento, cantidad_disponible: cantidad,
    })
    .onConflict(['id_bodega', 'id_producto', 'codigo_lote'])
    .merge({ cantidad_disponible: trx.raw('?? + ??', ['lotes.cantidad_disponible', 'excluded.cantidad_disponible']) })
    .where(trx.raw('?::date IS NULL OR ?? IS NOT DISTINCT FROM ??', [fechaVencimiento, 'lotes.fecha_vencimiento', 'excluded.fecha_vencimiento']))
    .returning(COLUMNAS);
  return filas[0];
}

/**
 * El lote de esa bodega, producto y código (exacto, distingue mayúsculas), sin bloquear. El motor lo lee tras un upsertEntrada
 * rechazado para informar la fecha guardada (la fila ya quedó bloqueada por el ON CONFLICT).
 * @returns {Promise<Lote|undefined>}
 */
async function buscarPorCodigo(dbOrTrx, { idBodega, idProducto, codigoLote }) {
  return dbOrTrx(TABLA).select(COLUMNAS).where({ id_bodega: idBodega, id_producto: idProducto, codigo_lote: codigoLote }).first();
}

/**
 * Toma un lote por su id con `SELECT … FOR UPDATE` (bloqueado hasta el fin de la transacción). No filtra por bodega ni producto:
 * el motor comprueba que sean los del movimiento (404 si no). Debe llamarse con una transacción.
 * @returns {Promise<Lote|undefined>}
 */
async function bloquearPorId(trx, idLote) {
  return trx(TABLA).select(COLUMNAS).where({ id_lote: idLote }).forUpdate().first();
}

/**
 * Lotes CON existencia (> 0) de un producto en una bodega, en orden FEFO (fecha ascendente, sin fecha al final, desempate por
 * id_lote), tomados con `FOR UPDATE`. PostgreSQL bloquea las filas a medida que salen del ORDER BY, así que el orden de bloqueo
 * es el orden FEFO (D27(c)). Debe llamarse con una transacción y DESPUÉS de bloquear el saldo del mismo par.
 * @returns {Promise<Lote[]>}
 */
async function listarParaFefo(trx, { idBodega, idProducto }) {
  return trx(TABLA)
    .select(COLUMNAS)
    .where({ id_bodega: idBodega, id_producto: idProducto })
    .andWhere('cantidad_disponible', '>', 0)
    .orderByRaw(ORDEN_FEFO)
    .forUpdate();
}

/**
 * Suma `delta` (con signo) a la existencia de un lote, solo si no queda negativa: la condición va en el WHERE, así que nunca se
 * llega al 23514 del CHECK `lotes_cantidad_no_negativa`.
 * @returns {Promise<Lote|undefined>} el lote actualizado; undefined si no existe o si quedaría negativo (nada cambia)
 */
async function ajustar(trx, idLote, delta) {
  const filas = await trx(TABLA)
    .where({ id_lote: idLote })
    .andWhereRaw('cantidad_disponible + ? >= 0', [delta])
    .update({ cantidad_disponible: trx.raw('cantidad_disponible + ?', [delta]) })
    .returning(COLUMNAS);
  return filas[0];
}

module.exports = { upsertEntrada, buscarPorCodigo, bloquearPorId, listarParaFefo, ajustar };
