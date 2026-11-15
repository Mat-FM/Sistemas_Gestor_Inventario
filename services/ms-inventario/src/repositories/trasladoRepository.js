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

module.exports = { insert, findById };
