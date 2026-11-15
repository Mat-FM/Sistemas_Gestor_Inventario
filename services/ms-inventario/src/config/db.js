const path = require('node:path');
const knex = require('knex');
const pg = require('pg');

// COUNT y SUM devuelven bigint (OID 20), que pg entrega como texto: se convierten a número para no devolver "3" en vez de 3.
pg.types.setTypeParser(20, Number);

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
