// Lo lee la CLI de Knex (`npx knex migrate:latest`). Lanzarla con `node --env-file=.env` para que vea las variables DB_*.
const { construirConfigKnex } = require('./src/config/db');
const { cargarConfig } = require('./src/config/env');

module.exports = construirConfigKnex(cargarConfig().db);
