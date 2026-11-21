// Pool de conexiones a la base de datos propia de ms-compras (RNF02).
const { Pool, types } = require('pg');
const config = require('./index');
const logger = require('../logger');

// NUMERIC llega como texto por defecto; los montos de compras caben sin perder precisión en un número.
types.setTypeParser(1700, (valor) => (valor === null ? null : Number(valor)));
// DATE se devuelve tal cual (AAAA-MM-DD), sin convertirlo a fecha con zona horaria.
types.setTypeParser(1082, (valor) => valor);

const pool = new Pool(config.db);

// Si PostgreSQL se apaga o se reinicia, cada conexión inactiva del pool emite 'error'. Sin un oyente, Node lo lanza como excepción y el
// servicio ENTERO se cae («terminating connection due to administrator command»): Docker lo reinicia en bucle mientras la base no vuelve
// y el Gateway ve 503 de más aun después de que la base regrese (RNF18). Con el oyente solo se descarta esa conexión y se registra; la
// siguiente petición pide otra, y si la base no está, responde 503 (middleware/errores.js).
pool.on('error', (error) => {
  logger.warn('conexión inactiva con la base de datos perdida', { error: error.message });
});

// Ejecuta una función dentro de una transacción y devuelve su resultado. Con `conexion`, usa esa conexión
// (por ejemplo, la que sostiene el candado de una orden) en lugar de pedir otra al pool.
async function enTransaccion(fn, conexion = null) {
  const cliente = conexion ?? (await pool.connect());
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    if (!conexion) cliente.release();
  }
}

module.exports = { pool, enTransaccion };
