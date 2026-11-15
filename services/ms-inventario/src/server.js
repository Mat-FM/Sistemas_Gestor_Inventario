const http = require('node:http');
const { createApp } = require('./app');
const { createDb } = require('./config/db');
const { cargarConfig } = require('./config/env');
const { logger } = require('./logger');

// Arma el servidor sin ponerlo a escuchar, para poder probarlo.
function createServer(env = process.env, log = logger) {
  const config = cargarConfig(env);
  const db = createDb(config.db);
  const clients = {};
  const app = createApp({ db, clients, logger: log, env });
  return { app, server: http.createServer(app), db, config };
}

if (require.main === module) {
  const { server, db, config } = createServer();
  server.listen(config.puerto, () => logger.info({ mensaje: 'Servidor iniciado', puerto: config.puerto }));

  // Al escalar hacia abajo Kubernetes envía SIGTERM: se atienden las peticiones en curso y se cierra el pool.
  for (const senal of ['SIGTERM', 'SIGINT']) {
    process.once(senal, () => {
      server.close(() => db.destroy().finally(() => process.exit(0)));
    });
  }
}

module.exports = { createServer };
