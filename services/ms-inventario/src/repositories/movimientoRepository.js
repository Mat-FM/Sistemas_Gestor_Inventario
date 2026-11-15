// Acceso a datos de la tabla `movimientos`, el kardex (RNF13): aquí vive todo su SQL y nada de lógica de negocio. Todas las
// funciones que tocan la base reciben primero `dbOrTrx`, la instancia de Knex o una transacción: el motor de movimientos inserta
// dentro de la transacción que bloquea el saldo.
//
// Un Movimiento (lo que ve la API) es { id_movimiento, tipo, id_producto, id_bodega, id_lote, id_traslado, id_conteo, cantidad,
// saldo_resultante, fecha, id_usuario, documento_referencia, observacion }: la columna `clave_idempotencia` nunca sale de aquí.
//
// Toda función que toca la base es `async` (Ruling 21); movimientosCapas.test.js lo comprueba con la lista de las exportadas.

const TABLA = 'movimientos';
const COLUMNAS = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];

// Nombre de la unicidad de la clave en la migración. Una repetición de la clave no se decide por el error: tras cualquier
// fallo se relee por la clave (idempotencia.resolverFallo).
const RESTRICCION_CLAVE = 'movimientos_clave_idempotencia_key';

/**
 * Inserta un movimiento. La `fecha` es `clock_timestamp()`, el instante de la escritura, y no el `DEFAULT now()` de la columna
 * (el inicio de la transacción): el motor inserta con el saldo ya bloqueado, así que por (producto, bodega) el orden
 * `fecha, id_movimiento` del kardex coincide con el orden en que se aplicaron los saldos (D24).
 * No valida nada: lo hace el motor. Con una clave ya usada lanza el 23505 de `movimientos_clave_idempotencia_key`
 * (quien llama lo resuelve releyendo por la clave: idempotencia.resolverFallo).
 * @param {{tipo: string, idProducto: number, idBodega: number, cantidad: number, saldoResultante: number, idUsuario: number,
 *   claveIdempotencia: string, idLote?: number|null, idTraslado?: number|null, idConteo?: number|null,
 *   documentoReferencia?: string|null, observacion?: string|null}} datos
 * @returns {Promise<Movimiento>}
 */
async function insert(dbOrTrx, {
  tipo, idProducto, idBodega, cantidad, saldoResultante, idUsuario, claveIdempotencia,
  idLote = null, idTraslado = null, idConteo = null, documentoReferencia = null, observacion = null,
}) {
  const [movimiento] = await dbOrTrx(TABLA)
    .insert({
      tipo,
      id_producto: idProducto,
      id_bodega: idBodega,
      id_lote: idLote,
      id_traslado: idTraslado,
      id_conteo: idConteo,
      cantidad,
      saldo_resultante: saldoResultante,
      fecha: dbOrTrx.raw('clock_timestamp()'),
      id_usuario: idUsuario,
      clave_idempotencia: claveIdempotencia,
      documento_referencia: documentoReferencia,
      observacion,
    })
    .returning(COLUMNAS);
  return movimiento;
}

/**
 * El movimiento guardado con esa clave, tal como se ALMACENA (ya con el prefijo del usuario: ver
 * idempotencia.claveAlmacenada y, en las derivadas, idempotencia.derivada). Comparación exacta.
 * @returns {Promise<Movimiento|undefined>}
 */
async function findByClave(dbOrTrx, claveAlmacenada) {
  return dbOrTrx(TABLA).select(COLUMNAS).where({ clave_idempotencia: claveAlmacenada }).first();
}

module.exports = { RESTRICCION_CLAVE, insert, findByClave };
