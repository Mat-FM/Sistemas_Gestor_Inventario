// Aplica en orden los archivos .sql de migrations/ que aún no se han aplicado.
// Cada archivo corre en su propia transacción y queda anotado en la tabla migracion.
// Uso: npm run migrate
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/config/db');

const CARPETA = path.join(__dirname, '..', 'migrations');

async function migrar({ silencioso = false } = {}) {
  const cliente = await pool.connect();
  try {
    // El candado evita que dos copias del servicio migren a la vez al arrancar.
    await cliente.query('SELECT pg_advisory_lock(424242)');
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS migracion (
        nombre     VARCHAR(255) PRIMARY KEY,
        aplicada   TIMESTAMPTZ  NOT NULL DEFAULT now()
      )`);
    const { rows } = await cliente.query('SELECT nombre FROM migracion');
    const aplicadas = new Set(rows.map((r) => r.nombre));
    const pendientes = fs
      .readdirSync(CARPETA)
      .filter((f) => f.endsWith('.sql') && !aplicadas.has(f))
      .sort();

    for (const archivo of pendientes) {
      const sql = fs.readFileSync(path.join(CARPETA, archivo), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migracion (nombre) VALUES ($1)', [archivo]);
        await cliente.query('COMMIT');
        if (!silencioso) console.log(`Migración aplicada: ${archivo}`);
      } catch (error) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falló la migración ${archivo}: ${error.message}`, { cause: error });
      }
    }
    if (!silencioso && pendientes.length === 0) console.log('No hay migraciones pendientes.');
  } finally {
    await cliente.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    cliente.release();
  }
}

module.exports = { migrar };

if (require.main === module) {
  migrar()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
