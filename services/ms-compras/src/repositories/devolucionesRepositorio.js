// Acceso a datos de las devoluciones a proveedor (RF13).
const { pool } = require('../config/db');

const COLUMNAS = `id_devolucion, id_orden, id_proveedor, id_producto, id_bodega, id_lote, cantidad, motivo,
                  fecha, id_usuario, id_movimiento`;

async function porClave(clave, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNAS} FROM devolucion_proveedor WHERE clave_idempotencia = $1`, [clave]);
  return rows[0] || null;
}

async function crear(d, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO devolucion_proveedor
       (id_orden, id_proveedor, id_producto, id_bodega, id_lote, cantidad, motivo, id_usuario, id_movimiento, clave_idempotencia)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (clave_idempotencia) DO NOTHING
     RETURNING ${COLUMNAS}`,
    [d.idOrden ?? null, d.idProveedor, d.idProducto, d.idBodega, d.idLote ?? null, d.cantidad, d.motivo, d.idUsuario, d.idMovimiento, d.clave],
  );
  // Si otra petición con la misma clave ganó la carrera, se devuelve la que quedó guardada.
  return rows[0] || porClave(d.clave, db);
}

async function listar({ idProveedor, fechaDesde, fechaHasta }, { pagina, porPagina }) {
  const condiciones = [];
  const valores = [];
  if (idProveedor) {
    valores.push(idProveedor);
    condiciones.push(`id_proveedor = $${valores.length}`);
  }
  if (fechaDesde) {
    valores.push(fechaDesde);
    condiciones.push(`fecha >= $${valores.length}::date`);
  }
  if (fechaHasta) {
    valores.push(fechaHasta);
    condiciones.push(`fecha < ($${valores.length}::date + INTERVAL '1 day')`);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const total = await pool.query(`SELECT count(*)::int AS total FROM devolucion_proveedor ${where}`, valores);
  const filas = await pool.query(
    `SELECT ${COLUMNAS} FROM devolucion_proveedor ${where}
     ORDER BY fecha DESC, id_devolucion DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, porPagina, (pagina - 1) * porPagina],
  );
  return { filas: filas.rows, total: total.rows[0].total };
}

module.exports = { porClave, crear, listar };
