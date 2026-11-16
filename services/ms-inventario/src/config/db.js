const path = require('node:path');
const knex = require('knex');
const pg = require('pg');

// COUNT y SUM devuelven bigint (OID 20), que pg entrega como texto: se convierten a número para no devolver "3" en vez de 3.
pg.types.setTypeParser(20, Number);
// Las columnas `date` (OID 1082: lotes.fecha_vencimiento, conteos.fecha_programada) se leen como el texto YYYY-MM-DD de la base
// (Ruling 15). El parser por defecto de `pg` crea un Date a medianoche LOCAL, y JSON.stringify lo pasa a UTC: en un huso
// adelantado a UTC (p. ej. Pacific/Auckland) la fecha retrocede un día, y comparar fechas de vencimiento con == entre Date
// compararía objetos, no días. Una fecha sin hora no tiene huso: se queda como texto. timestamptz (1184) sigue siendo Date.
// Registrado aquí, el parser es global al módulo `pg`: vale para createDb (servidor, knexfile.js y el arnés de pruebas).
pg.types.setTypeParser(1082, (valor) => valor);

// Configuración de Knex a partir de la sección `db` de cargarConfig(). La usan createDb y knexfile.js.
function construirConfigKnex(db) {
  return {
    client: 'pg',
    connection: { host: db.host, port: db.port, database: db.database, user: db.user, password: db.password },
    // Sin conexiones ociosas permanentes: el servicio escala hasta 4 copias (RNF05) y cada una abre las suyas.
    pool: { min: 0, max: 10 },
    // Ruta absoluta: las migraciones se encuentran sin importar desde dónde se ejecute el comando.
    migrations: { directory: path.join(__dirname, '..', '..', 'migrations') },
  };
}

function createDb(config) {
  return knex(construirConfigKnex(config));
}

module.exports = { createDb, construirConfigKnex };
