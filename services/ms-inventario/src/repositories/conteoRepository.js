// Acceso a datos de las tablas `conteos` y `detalles_conteo` (RNF13, RF18): aquí vive todo su SQL y nada de lógica de negocio (las
// reglas son de conteoService y el stock lo mueve el motor, stockService). Todas las funciones reciben primero `dbOrTrx`, la
// instancia de Knex o una transacción.
//
// Un Conteo (lo que ve la API) es { id_conteo, id_bodega, estado, fecha_programada, fecha_aprobacion, id_usuario_aprueba, detalles }
// y cada línea { id_detalle_conteo, id_producto, cantidad_sistema, cantidad_contada, diferencia }: números como números,
// `fecha_programada` como texto YYYY-MM-DD (columna `date`, Ruling 15), `fecha_aprobacion` como Date (timestamptz; JSON la escribe
// en ISO 8601 UTC) y null lo que todavía no hay. Las líneas van SIEMPRE ordenadas por id_producto. La columna `clave_aprobacion`
// (D5) nunca sale de aquí salvo en findByClaveAprobacion, que la usa para decidir una repetición.
//
// Toda función es `async` (Ruling 21); conteosCapas.test.js lo comprueba con la lista de las exportadas.

const TABLA = 'conteos';
const TABLA_DETALLES = 'detalles_conteo';
const COLUMNAS = ['id_conteo', 'id_bodega', 'estado', 'fecha_programada', 'fecha_aprobacion', 'id_usuario_aprueba'];
const COLUMNAS_DETALLE = ['id_detalle_conteo', 'id_producto', 'cantidad_sistema', 'cantidad_contada', 'diferencia'];

// Una lista de ids ya validados (enteros positivos dentro del INTEGER) como literal de arreglo de PostgreSQL ('{5,3}'), que viaja
// como UN parámetro enlazado y se convierte con ?::int[]. Knex expandiría un arreglo JS en `?, ?, ?`, que no sirve para unnest.
const arregloEnteros = (valores) => `{${valores.map((valor) => String(valor)).join(',')}}`;

/**
 * Inserta la cabecera de un conteo PROGRAMADO. No valida nada (lo hace el servicio); la clave foránea exige que la bodega exista.
 * @param {{idBodega: number, fechaProgramada: string}} datos fecha YYYY-MM-DD ya validada
 * @returns {Promise<object>} la cabecera (sin detalles)
 */
async function insertarConteo(dbOrTrx, { idBodega, fechaProgramada }) {
  const [conteo] = await dbOrTrx(TABLA)
    .insert({ id_bodega: idBodega, estado: 'PROGRAMADO', fecha_programada: fechaProgramada })
    .returning(COLUMNAS);
  return conteo;
}

/**
 * Crea las líneas de un conteo con `cantidad_sistema` = el saldo de ese instante en la bodega del conteo (D11, D32(f)), en UNA
 * sentencia (INSERT … SELECT): todas las líneas ven la misma instantánea de los saldos. Lectura SIN bloqueo: es una foto, la
 * aprobación ajusta por la diferencia que se guarde al contar (D32(a)).
 * - `idsProducto` null: los productos con `cantidad_disponible > 0` en esa bodega, por id_producto.
 * - `idsProducto` arreglo (sin repetidos, ya validado): una línea por id, en el ORDEN recibido; 0 si no hay saldo.
 * @param {{idConteo: number, idBodega: number, idsProducto: number[]|null}} datos
 * @returns {Promise<number>} cuántas líneas creó (0 si la bodega no tiene existencias y no se pidió ninguna)
 */
async function insertarDetalles(dbOrTrx, { idConteo, idBodega, idsProducto }) {
  const resultado = idsProducto === null
    ? await dbOrTrx.raw(`
        INSERT INTO detalles_conteo (id_conteo, id_producto, cantidad_sistema)
        SELECT ?, s.id_producto, s.cantidad_disponible
        FROM saldos s
        WHERE s.id_bodega = ? AND s.cantidad_disponible > 0
        ORDER BY s.id_producto`, [idConteo, idBodega])
    : await dbOrTrx.raw(`
        INSERT INTO detalles_conteo (id_conteo, id_producto, cantidad_sistema)
        SELECT ?, p.id_producto, COALESCE(s.cantidad_disponible, 0)
        FROM unnest(?::int[]) WITH ORDINALITY AS p(id_producto, orden)
        LEFT JOIN saldos s ON s.id_producto = p.id_producto AND s.id_bodega = ?
        ORDER BY p.orden`, [idConteo, arregloEnteros(idsProducto), idBodega]);
  return resultado.rowCount;
}

/**
 * Las líneas de un conteo, ordenadas por id_producto (el orden de la API y el de bloqueo de la aprobación, D32(e)).
 * @returns {Promise<object[]>} vacío si el conteo no existe o no tiene líneas
 */
async function listarDetalles(dbOrTrx, idConteo) {
  return dbOrTrx(TABLA_DETALLES).select(COLUMNAS_DETALLE).where({ id_conteo: idConteo }).orderBy('id_producto');
}

/**
 * Un Conteo por su id, con sus líneas, sin bloquear. El id ya llega validado (un entero positivo dentro del INTEGER).
 * @returns {Promise<object|undefined>}
 */
async function findById(dbOrTrx, id) {
  const conteo = await dbOrTrx(TABLA).select(COLUMNAS).where({ id_conteo: id }).first();
  if (!conteo) return undefined;
  return { ...conteo, detalles: await listarDetalles(dbOrTrx, id) };
}

// Una consulta sobre `conteos` restringida por los filtros presentes; un filtro undefined no restringe. El COUNT y la página de
// `listar` la comparten (mismo WHERE), así que `total` es siempre el del filtro.
function filtrar(consulta, { estado, idBodega }) {
  if (estado !== undefined) consulta.where({ estado });
  if (idBodega !== undefined) consulta.where({ id_bodega: idBodega });
  return consulta;
}

/**
 * Una página de conteos (solo las cabeceras: el listado es un resumen, D32(i)), de la fecha programada más lejana a la más
 * cercana: `fecha_programada DESC, id_conteo DESC`. El id desempata los conteos del mismo día (orden total y estable: dos páginas
 * seguidas nunca repiten ni saltan filas). Devuelve además el total del filtro, no de la página (dos consultas con el mismo
 * WHERE; `count(*) over()` daría total 0 en una página fuera de rango). Es una LECTURA: sin FOR UPDATE.
 * @param {{estado?: string, idBodega?: number, limit: number, offset: number}} opciones un filtro undefined no filtra
 * @returns {Promise<{filas: object[], total: number}>}
 */
async function listar(dbOrTrx, { estado, idBodega, limit, offset }) {
  const filtro = { estado, idBodega };
  const [resumen] = await filtrar(dbOrTrx(TABLA), filtro).count({ total: '*' });
  const filas = await filtrar(dbOrTrx(TABLA).select(COLUMNAS), filtro)
    .orderBy([{ column: 'fecha_programada', order: 'desc' }, { column: 'id_conteo', order: 'desc' }])
    .limit(limit)
    .offset(offset);
  return { filas, total: Number(resumen.total) };
}

/**
 * Toma la cabecera de un conteo con `SELECT … FOR UPDATE` (bloqueada hasta el fin de la transacción). Debe llamarse con una
 * transacción. Es el PRIMER bloqueo del registro de lo contado y de la aprobación (D32(d)(e)): dos operaciones sobre el mismo
 * conteo se ponen en fila aquí y la segunda, al obtener el bloqueo, lee el estado que dejó la primera (READ COMMITTED relee la
 * versión confirmada de la fila).
 * @returns {Promise<object|undefined>} la cabecera (sin detalles)
 */
async function bloquearPorId(trx, id) {
  return trx(TABLA).select(COLUMNAS).where({ id_conteo: id }).forUpdate().first();
}

/**
 * Registra lo contado en las líneas enviadas (D11, D32(a)), en UNA sentencia: fija `cantidad_contada`, refresca
 * `cantidad_sistema` con el saldo de ESE instante en la bodega del conteo (0 si no hay saldo) y guarda
 * `diferencia = cantidad_contada − cantidad_sistema` (con signo; cabe en INTEGER: ambos están entre 0 y el máximo). Lectura de
 * saldos SIN bloqueo: es la foto del momento del conteo. Las líneas no enviadas no cambian; un producto que no está en el conteo
 * no cambia nada (el servicio lo rechaza antes con 422). Quien llama debe tener bloqueada la cabecera (bloquearPorId).
 * @param {{idConteo: number, idBodega: number, lineas: Array<{idProducto: number, cantidadContada: number}>}} datos ya validados
 * @returns {Promise<number>} cuántas líneas cambió
 */
async function registrarContados(dbOrTrx, { idConteo, idBodega, lineas }) {
  const resultado = await dbOrTrx.raw(`
    UPDATE detalles_conteo AS d
    SET cantidad_contada = v.contada,
        cantidad_sistema = x.sistema,
        diferencia = v.contada - x.sistema
    FROM unnest(?::int[], ?::int[]) AS v(id_producto, contada)
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT s.cantidad_disponible FROM saldos s WHERE s.id_bodega = ? AND s.id_producto = v.id_producto), 0) AS sistema
    ) AS x
    WHERE d.id_conteo = ? AND d.id_producto = v.id_producto`, [
    arregloEnteros(lineas.map((linea) => linea.idProducto)), arregloEnteros(lineas.map((linea) => linea.cantidadContada)), idBodega, idConteo,
  ]);
  return resultado.rowCount;
}

/**
 * Pasa un conteo a EN_REVISION (desde PROGRAMADO, o lo deja en EN_REVISION). Nunca cambia uno APROBADO: la condición va en el
 * WHERE y entonces devuelve undefined. Quien llama debe tener la fila bloqueada y haber comprobado el estado.
 * @returns {Promise<object|undefined>} la cabecera actualizada
 */
async function marcarEnRevision(trx, id) {
  const [conteo] = await trx(TABLA)
    .where({ id_conteo: id })
    .whereNot({ estado: 'APROBADO' })
    .update({ estado: 'EN_REVISION' })
    .returning(COLUMNAS);
  return conteo;
}

module.exports = {
  insertarConteo, insertarDetalles, listarDetalles, findById, listar, bloquearPorId, registrarContados, marcarEnRevision,
};
