// Acceso a datos de la tabla `traslados` (RNF13, RF04): aquí vive todo su SQL y nada de lógica de negocio (las reglas son de
// trasladoService y el stock lo mueve el motor, stockService). Todas las funciones reciben primero `dbOrTrx`, la instancia de
// Knex o una transacción.
//
// Un Traslado (lo que ve la API) es { id_traslado, id_producto, id_bodega_origen, id_bodega_destino, id_lote, cantidad, estado,
// fecha_envio, fecha_recepcion, id_usuario_envia, id_usuario_recibe }: números como números, `fecha_envio` y `fecha_recepcion`
// como Date (timestamptz; JSON los escribe en ISO 8601 UTC) y `id_lote`, `fecha_recepcion` e `id_usuario_recibe` null cuando no
// hay. `id_lote` es el lote de ORIGEN que se trasladó (el del destino lo lleva el movimiento TRASLADO_ENTRADA).
//
// Toda función es `async` (Ruling 21); trasladosCapas.test.js lo comprueba con la lista de las exportadas.

const TABLA = 'traslados';
const COLUMNAS = [
  'id_traslado', 'id_producto', 'id_bodega_origen', 'id_bodega_destino', 'id_lote', 'cantidad', 'estado', 'fecha_envio',
  'fecha_recepcion', 'id_usuario_envia', 'id_usuario_recibe',
];

/**
 * Inserta un traslado EN_TRANSITO. `fecha_envio` es `clock_timestamp()`, el instante de la escritura, y no el `DEFAULT now()` de
 * la columna (el inicio de la transacción, D24): trasladoService inserta con el saldo de origen ya bloqueado.
 * No valida nada (lo hace el servicio). Las claves foráneas exigen que existan las dos bodegas y, si viene, el lote; la de
 * `id_lote` toma un bloqueo FOR KEY SHARE sobre la fila del lote, por eso quien llama debe tener YA bloqueado el saldo de origen
 * (ver trasladoService.crear).
 * @param {{idProducto: number, idBodegaOrigen: number, idBodegaDestino: number, idLote: number|null, cantidad: number,
 *   idUsuarioEnvia: number}} datos
 * @returns {Promise<Traslado>}
 */
async function insert(dbOrTrx, { idProducto, idBodegaOrigen, idBodegaDestino, idLote = null, cantidad, idUsuarioEnvia }) {
  const [traslado] = await dbOrTrx(TABLA)
    .insert({
      id_producto: idProducto,
      id_bodega_origen: idBodegaOrigen,
      id_bodega_destino: idBodegaDestino,
      id_lote: idLote,
      cantidad,
      estado: 'EN_TRANSITO',
      fecha_envio: dbOrTrx.raw('clock_timestamp()'),
      id_usuario_envia: idUsuarioEnvia,
    })
    .returning(COLUMNAS);
  return traslado;
}

/**
 * Un traslado por su id, sin bloquear. El id ya llega validado (un entero positivo dentro del INTEGER).
 * @returns {Promise<Traslado|undefined>}
 */
async function findById(dbOrTrx, id) {
  return dbOrTrx(TABLA).select(COLUMNAS).where({ id_traslado: id }).first();
}

/**
 * Toma un traslado por su id con `SELECT … FOR UPDATE` (bloqueado hasta el fin de la transacción). Debe llamarse con una
 * transacción. Es el PRIMER bloqueo de la recepción (D31(d)): dos recepciones del mismo traslado se ponen en fila aquí y la
 * segunda, al obtener el bloqueo, lee el estado que dejó la primera (READ COMMITTED relee la versión confirmada de la fila).
 * @returns {Promise<Traslado|undefined>}
 */
async function bloquearPorId(trx, id) {
  return trx(TABLA).select(COLUMNAS).where({ id_traslado: id }).forUpdate().first();
}

/**
 * Marca un traslado EN_TRANSITO como RECIBIDO, con `fecha_recepcion = clock_timestamp()` (el instante de la escritura, D24) y
 * el usuario que lo recibe. Solo cambia un traslado que siga EN_TRANSITO (la condición va en el WHERE): sobre uno ya recibido no
 * hace nada y devuelve undefined. Quien llama debe tener la fila bloqueada (bloquearPorId) y haber comprobado el estado.
 * @param {{idUsuarioRecibe: number}} datos
 * @returns {Promise<Traslado|undefined>} el traslado actualizado
 */
async function marcarRecibido(trx, id, { idUsuarioRecibe }) {
  const [traslado] = await trx(TABLA)
    .where({ id_traslado: id, estado: 'EN_TRANSITO' })
    .update({ estado: 'RECIBIDO', fecha_recepcion: trx.raw('clock_timestamp()'), id_usuario_recibe: idUsuarioRecibe })
    .returning(COLUMNAS);
  return traslado;
}

// Una consulta sobre `traslados` restringida por los filtros presentes; un filtro undefined no restringe. El COUNT y la página
// de `listar` la comparten (mismo WHERE), así que `total` es siempre el del filtro. `idBodega` es la bodega de ORIGEN O la de
// DESTINO (entre paréntesis: el OR no se mezcla con el resto de condiciones).
function filtrar(consulta, { estado, idBodega }) {
  if (estado !== undefined) consulta.where({ estado });
  if (idBodega !== undefined) consulta.where((o) => o.where({ id_bodega_origen: idBodega }).orWhere({ id_bodega_destino: idBodega }));
  return consulta;
}

/**
 * Una página de traslados, del más reciente al más antiguo: `fecha_envio DESC, id_traslado DESC`. El id desempata los envíos con
 * la misma fecha (orden total y estable: dos páginas seguidas nunca repiten ni saltan filas). Devuelve además el total de filas
 * del filtro, no de la página: el conteo y la página son dos consultas con el mismo WHERE (`count(*) over()` daría total 0 en una
 * página fuera de rango). Es una LECTURA: sin FOR UPDATE, nunca espera a una creación o recepción en curso.
 * @param {{estado?: string, idBodega?: number, limit: number, offset: number}} opciones un filtro undefined no filtra
 * @returns {Promise<{filas: Traslado[], total: number}>}
 */
async function listar(dbOrTrx, { estado, idBodega, limit, offset }) {
  const filtro = { estado, idBodega };
  const [resumen] = await filtrar(dbOrTrx(TABLA), filtro).count({ total: '*' });
  const filas = await filtrar(dbOrTrx(TABLA).select(COLUMNAS), filtro)
    .orderBy([{ column: 'fecha_envio', order: 'desc' }, { column: 'id_traslado', order: 'desc' }])
    .limit(limit)
    .offset(offset);
  return { filas, total: Number(resumen.total) };
}

module.exports = { insert, findById, bloquearPorId, marcarRecibido, listar };
