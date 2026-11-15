// Respuestas ya enviadas por clave de idempotencia (RNF17).
const { pool } = require('../config/db');

async function buscar(clave, operacion) {
  const { rows } = await pool.query(
    'SELECT codigo_http, respuesta FROM clave_idempotencia WHERE clave = $1 AND operacion = $2',
    [clave, operacion],
  );
  return rows[0] || null;
}

async function guardar(clave, operacion, codigoHttp, respuesta) {
  await pool.query(
    `INSERT INTO clave_idempotencia (clave, operacion, codigo_http, respuesta)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [clave, operacion, codigoHttp, JSON.stringify(respuesta)],
  );
}

module.exports = { buscar, guardar };
