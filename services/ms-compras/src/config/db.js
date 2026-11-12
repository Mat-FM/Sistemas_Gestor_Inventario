// Pool de conexiones a la base de datos propia de ms-compras (RNF02).
const { Pool, types } = require('pg');
const config = require('./index');

// NUMERIC llega como texto por defecto; los montos de compras caben sin perder precisión en un número.
types.setTypeParser(1700, (valor) => (valor === null ? null : Number(valor)));
// DATE se devuelve tal cual (AAAA-MM-DD), sin convertirlo a fecha con zona horaria.
types.setTypeParser(1082, (valor) => valor);

const pool = new Pool(config.db);

// Ejecuta una función dentro de una transacción y devuelve su resultado.
async function enTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

module.exports = { pool, enTransaccion };
