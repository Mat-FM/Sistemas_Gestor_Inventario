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

// Una consulta sobre `movimientos` restringida por los filtros presentes; un filtro undefined no restringe. El COUNT y la página
// del kardex la comparten (mismo WHERE), así que `total` es siempre el del filtro.
//
// fechaDesde y fechaHasta son DÍAS UTC `YYYY-MM-DD` (D29): fechaDesde incluye desde las 00:00:00 UTC de ese día y fechaHasta, TODO
// ese día, es decir, `fecha` estrictamente menor que las 00:00:00 UTC del día siguiente (no `<= 23:59:59.999`: la base guarda
// microsegundos). La comparación NO debe depender del huso de la sesión de PostgreSQL: `fecha >= ?::date` convertiría la fecha a
// `timestamptz` con el `TimeZone` de la sesión (en Bogotá, la medianoche sería las 05:00 UTC). Por eso se pasa por
// `timestamp` (sin zona) y `AT TIME ZONE 'UTC'` lo fija a UTC. La fecha viaja enlazada y el `::date` la valida en la base.
function filtrar(consulta, { idProducto, idBodega, idUsuario, tipo, fechaDesde, fechaHasta }) {
  if (idProducto !== undefined) consulta.where({ id_producto: idProducto });
  if (idBodega !== undefined) consulta.where({ id_bodega: idBodega });
  if (idUsuario !== undefined) consulta.where({ id_usuario: idUsuario });
  if (tipo !== undefined) consulta.where({ tipo });
  if (fechaDesde !== undefined) consulta.whereRaw("fecha >= ((?::date)::timestamp AT TIME ZONE 'UTC')", [fechaDesde]);
  if (fechaHasta !== undefined) consulta.whereRaw("fecha < ((?::date + 1)::timestamp AT TIME ZONE 'UTC')", [fechaHasta]);
  return consulta;
}

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

/**
 * Una página del kardex (RF10, RF15), del más reciente al más antiguo: `fecha DESC, id_movimiento DESC`. El id desempata las
 * filas con la misma `fecha` (el reloj de la base tiene microsegundos, pero la fecha de una siembra o de un movimiento masivo
 * puede repetirse): sin él, dos páginas seguidas podrían repetir o saltar filas. Devuelve además el total de filas del filtro,
 * no de la página. El conteo y la página son dos consultas con el mismo WHERE (`count(*) over()` daría total 0 en una página
 * fuera de rango), y un movimiento que se confirme entre las dos puede desplazar una fila entre páginas: es la limitación de
 * toda paginación por desplazamiento sobre un kardex que sigue creciendo. Sin filtros, el orden lo sirve el índice
 * `movimientos_fecha_id_idx (fecha DESC, id_movimiento DESC)` (migración 20261115000100); con `id_producto` o `id_bodega`, los suyos.
 * @param {{idProducto?: number, idBodega?: number, idUsuario?: number, tipo?: string, fechaDesde?: string, fechaHasta?: string,
 *   limit: number, offset: number}} opciones un filtro undefined no filtra; fechaDesde y fechaHasta son `YYYY-MM-DD` ya validadas
 *   y se interpretan como días UTC (D29)
 * @returns {Promise<{filas: Movimiento[], total: number}>}
 */
async function listar(dbOrTrx, { idProducto, idBodega, idUsuario, tipo, fechaDesde, fechaHasta, limit, offset }) {
  const filtro = { idProducto, idBodega, idUsuario, tipo, fechaDesde, fechaHasta };
  const [resumen] = await filtrar(dbOrTrx(TABLA), filtro).count({ total: '*' });
  const filas = await filtrar(dbOrTrx(TABLA).select(COLUMNAS), filtro)
    .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'id_movimiento', order: 'desc' }])
    .limit(limit)
    .offset(offset);
  return { filas, total: Number(resumen.total) };
}

/**
 * Un movimiento por su id, sin `clave_idempotencia`. El id ya llega validado (un entero positivo dentro del INTEGER).
 * @returns {Promise<Movimiento|undefined>}
 */
async function findById(dbOrTrx, id) {
  return dbOrTrx(TABLA).select(COLUMNAS).where({ id_movimiento: id }).first();
}

module.exports = { RESTRICCION_CLAVE, insert, findByClave, listar, findById };
