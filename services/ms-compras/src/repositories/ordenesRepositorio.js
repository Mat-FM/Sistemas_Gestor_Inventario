// Acceso a datos de órdenes de compra, sus líneas y sus recepciones. Solo SQL, sin reglas de negocio.
const { pool } = require('../config/db');

const COLUMNAS_ORDEN = `
  o.id_orden, o.numero, o.estado, o.id_proveedor, o.id_bodega_destino, o.id_usuario,
  o.fecha_creacion, o.fecha_esperada, o.total`;

async function listar({ estado, idProveedor, idBodegaDestino, fechaDesde, fechaHasta }, { pagina, porPagina }) {
  const condiciones = [];
  const valores = [];
  const agregar = (sql, valor) => {
    valores.push(valor);
    condiciones.push(sql.replace('?', `$${valores.length}`));
  };
  if (estado) agregar('o.estado = ?', estado);
  if (idProveedor) agregar('o.id_proveedor = ?', idProveedor);
  if (idBodegaDestino) agregar('o.id_bodega_destino = ?', idBodegaDestino);
  if (fechaDesde) agregar('o.fecha_creacion >= ?::date', fechaDesde);
  if (fechaHasta) agregar("o.fecha_creacion < (?::date + INTERVAL '1 day')", fechaHasta);
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const total = await pool.query(`SELECT count(*)::int AS total FROM orden_compra o ${where}`, valores);
  const filas = await pool.query(
    `SELECT ${COLUMNAS_ORDEN} FROM orden_compra o ${where}
     ORDER BY o.fecha_creacion DESC, o.id_orden DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, porPagina, (pagina - 1) * porPagina],
  );
  return { filas: filas.rows, total: total.rows[0].total };
}

async function obtener(idOrden, db = pool, { bloquear = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${COLUMNAS_ORDEN} FROM orden_compra o WHERE o.id_orden = $1 ${bloquear ? 'FOR UPDATE' : ''}`,
    [idOrden],
  );
  return rows[0] || null;
}

async function detalles(idOrden, db = pool) {
  const { rows } = await db.query(
    `SELECT id_detalle, id_producto, cantidad_pedida, cantidad_recibida, precio_unitario,
            (cantidad_pedida * precio_unitario)::numeric(14,2) AS subtotal
     FROM detalle_orden WHERE id_orden = $1 ORDER BY id_detalle`,
    [idOrden],
  );
  return rows;
}

async function recepciones(idOrden, db = pool) {
  const { rows } = await db.query(
    `SELECT r.id_recepcion, r.id_detalle, d.id_producto, r.cantidad, r.codigo_lote, r.fecha_vencimiento,
            r.fecha, r.id_usuario, r.id_movimiento
     FROM recepcion r JOIN detalle_orden d ON d.id_detalle = r.id_detalle
     WHERE d.id_orden = $1 ORDER BY r.fecha, r.id_recepcion`,
    [idOrden],
  );
  return rows;
}

async function recepcionesPorClave(idOrden, clave, db = pool) {
  const { rows } = await db.query(
    `SELECT r.id_recepcion, r.id_detalle, d.id_producto, r.cantidad, r.codigo_lote, r.fecha_vencimiento,
            r.fecha, r.id_usuario, r.id_movimiento
     FROM recepcion r JOIN detalle_orden d ON d.id_detalle = r.id_detalle
     WHERE d.id_orden = $1 AND r.clave_idempotencia = $2 ORDER BY r.id_recepcion`,
    [idOrden, clave],
  );
  return rows;
}

async function crear(db, { idProveedor, idBodegaDestino, idUsuario, fechaEsperada, lineas }) {
  const total = lineas.reduce((suma, l) => suma + l.cantidadPedida * l.precioUnitario, 0);
  const { rows } = await db.query(
    `INSERT INTO orden_compra (numero, id_proveedor, id_bodega_destino, id_usuario, fecha_esperada, total)
     VALUES ('OC-' || lpad(nextval('numero_orden_seq')::text, 4, '0'), $1, $2, $3, $4, $5)
     RETURNING id_orden`,
    [idProveedor, idBodegaDestino, idUsuario, fechaEsperada, total],
  );
  const idOrden = rows[0].id_orden;
  await insertarDetalles(db, idOrden, lineas);
  return idOrden;
}

async function insertarDetalles(db, idOrden, lineas) {
  for (const linea of lineas) {
    await db.query(
      `INSERT INTO detalle_orden (id_orden, id_producto, cantidad_pedida, precio_unitario)
       VALUES ($1, $2, $3, $4)`,
      [idOrden, linea.idProducto, linea.cantidadPedida, linea.precioUnitario],
    );
  }
}

async function reemplazar(db, idOrden, { idProveedor, idBodegaDestino, fechaEsperada, lineas }) {
  const total = lineas.reduce((suma, l) => suma + l.cantidadPedida * l.precioUnitario, 0);
  await db.query('DELETE FROM detalle_orden WHERE id_orden = $1', [idOrden]);
  await insertarDetalles(db, idOrden, lineas);
  await db.query(
    `UPDATE orden_compra SET id_proveedor = $2, id_bodega_destino = $3, fecha_esperada = $4, total = $5
     WHERE id_orden = $1`,
    [idOrden, idProveedor, idBodegaDestino, fechaEsperada, total],
  );
}

async function cambiarEstado(db, idOrden, estado) {
  await db.query('UPDATE orden_compra SET estado = $2 WHERE id_orden = $1', [idOrden, estado]);
}

async function recepcionPorClave(db, clave, idDetalle) {
  const { rows } = await db.query(
    'SELECT id_recepcion, id_movimiento FROM recepcion WHERE clave_idempotencia = $1 AND id_detalle = $2',
    [clave, idDetalle],
  );
  return rows[0] || null;
}

async function registrarRecepcion(db, recepcion) {
  const { rows } = await db.query(
    `INSERT INTO recepcion (id_detalle, cantidad, codigo_lote, fecha_vencimiento, id_usuario, id_movimiento, clave_idempotencia)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id_recepcion`,
    [
      recepcion.idDetalle,
      recepcion.cantidad,
      recepcion.codigoLote ?? null,
      recepcion.fechaVencimiento ?? null,
      recepcion.idUsuario,
      recepcion.idMovimiento,
      recepcion.clave,
    ],
  );
  await db.query('UPDATE detalle_orden SET cantidad_recibida = cantidad_recibida + $2 WHERE id_detalle = $1', [
    recepcion.idDetalle,
    recepcion.cantidad,
  ]);
  return rows[0].id_recepcion;
}

module.exports = {
  listar,
  obtener,
  detalles,
  recepciones,
  recepcionesPorClave,
  crear,
  reemplazar,
  cambiarEstado,
  recepcionPorClave,
  registrarRecepcion,
};
