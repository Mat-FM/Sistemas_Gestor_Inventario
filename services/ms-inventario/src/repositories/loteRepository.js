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
 * Toma un lote por su id con `SELECT … FOR UPDATE` (bloqueado hasta el fin de la transacción). Debe llamarse con una transacción.
 * Con `idBodega` e `idProducto` solo encuentra (y solo BLOQUEA) el lote si es de ese par: el motor siempre los pasa. Así nunca
 * toma un lote de otro (producto, bodega) cuyo saldo no tiene bloqueado; si lo hiciera, un traslado que ya tuviera ese par y
 * esperara el saldo de este movimiento cerraría un ciclo de esperas (interbloqueo, 40P01). La pertenencia de un lote a su par
 * nunca cambia (ninguna sentencia actualiza id_bodega ni id_producto), así que filtrar en el mismo SELECT es seguro.
 * @param {{idBodega?: number, idProducto?: number}} [par] si se omite, no filtra
 * @returns {Promise<Lote|undefined>} undefined si no existe o no es de ese par
 */
async function bloquearPorId(trx, idLote, { idBodega, idProducto } = {}) {
  const consulta = trx(TABLA).select(COLUMNAS).where({ id_lote: idLote });
  if (idBodega !== undefined) consulta.where({ id_bodega: idBodega });
  if (idProducto !== undefined) consulta.where({ id_producto: idProducto });
  return consulta.forUpdate().first();
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

/**
 * Suma de `cantidad_disponible` de TODOS los lotes de un par (también los que están en 0) y el aislamiento de la transacción, en
 * UNA consulta. Es una agregación: PostgreSQL no admite FOR UPDATE con SUM. El motor la usa para el stock sin lote de un traslado
 * (D28(a)) y solo es correcta bajo las condiciones que documenta stockService (sentencia nueva tras bloquear el saldo, READ
 * COMMITTED); por eso devuelve también `aislamiento` (current_setting('transaction_isolation'): 'read committed', 'repeatable
 * read' o 'serializable') para que el motor lo compruebe sin otra ida y vuelta.
 * @returns {Promise<{enLotes: number, aislamiento: string}>}
 */
async function sumarDelPar(trx, { idBodega, idProducto }) {
  const [fila] = await trx(TABLA)
    .where({ id_bodega: idBodega, id_producto: idProducto })
    .select(trx.raw('COALESCE(SUM(cantidad_disponible), 0) AS en_lotes'), trx.raw("current_setting('transaction_isolation') AS aislamiento"));
  return { enLotes: Number(fila.en_lotes), aislamiento: fila.aislamiento };
}

module.exports = { upsertEntrada, buscarPorCodigo, bloquearPorId, listarParaFefo, ajustar, sumarDelPar };
