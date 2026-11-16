// Espera DE VERDAD a que otra sesión quede bloqueada esperando un candado (ÚNICA fuente de esta espera, Tarea 8b). Sustituye a
// un setTimeout fijo: con un tiempo fijo, si la otra sesión todavía no esperaba el candado, la prueba pasaría sin haber probado
// la carrera.

/**
 * Sondea pg_stat_activity hasta que en la base actual haya al menos `minimo` sesiones esperando un candado
 * (`wait_event_type = 'Lock'`: una fila tomada con FOR UPDATE, la unicidad de un INSERT … ON CONFLICT, etc.). Las suites corren
 * en serie (`--runInBand`) sobre su propia base de pruebas, así que esas sesiones son las de la prueba en curso.
 * @param {object} db instancia de Knex: consulta con una conexión del pool, nunca con la transacción que tiene el candado
 * @param {{minimo?: number, plazoMs?: number, cadaMs?: number}} [opciones] por defecto: 1 sesión, hasta 5 s, cada 20 ms
 * @returns {Promise<number>} cuántas sesiones esperaban al detectarlo
 * @throws {Error} con un mensaje claro si en el plazo nunca aparecen
 */
async function esperarBloqueo(db, { minimo = 1, plazoMs = 5000, cadaMs = 20 } = {}) {
  const limite = Date.now() + plazoMs;
  for (;;) {
    const { rows: [{ esperando }] } = await db.raw(
      "SELECT count(*)::int AS esperando FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if (esperando >= minimo) return esperando;
    if (Date.now() >= limite) {
      throw new Error(`esperarBloqueo: en ${plazoMs} ms nunca hubo ${minimo} sesión(es) esperando un candado (había ${esperando}); la prueba no habría probado la carrera`);
    }
    await new Promise((resolver) => setTimeout(resolver, cadaMs));
  }
}

module.exports = { esperarBloqueo };
