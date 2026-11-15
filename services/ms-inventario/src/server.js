const http = require('node:http');
const { createApp } = require('./app');
const { createCatalogoClient } = require('./clients/catalogoClient');
const { createNotificacionesClient } = require('./clients/notificacionesClient');
const { createResilientClient } = require('./clients/resilientClient');
const { createDb } = require('./config/db');
const { cargarConfig } = require('./config/env');
const { logger } = require('./logger');

// Clientes de los otros servicios (RNF18). Cada servicio destino tiene su propio cliente HTTP resiliente y, por tanto, su propio
// cortacircuitos: que ms-notificaciones esté caído no debe frenar las llamadas a ms-catalogo, ni al revés. Las direcciones salen
// de la configuración (RNF14); si faltan, los clientes se construyen igual y responden 503 (y /health avisa de la configuración).
function crearClientes(config, log) {
  const opciones = { timeoutMs: config.callTimeoutMs, logger: log };
  const catalogoHttp = createResilientClient({ ...opciones, baseUrl: config.catalogoUrl, nombre: 'ms-catalogo' });
  const notificacionesHttp = createResilientClient({ ...opciones, baseUrl: config.notificacionesUrl, nombre: 'ms-notificaciones' });
  return {
    catalogo: createCatalogoClient(catalogoHttp, log),
    notificaciones: createNotificacionesClient(notificacionesHttp, log),
  };
}

// Arma el servidor sin ponerlo a escuchar, para poder probarlo.
function createServer(env = process.env, log = logger) {
  const config = cargarConfig(env);
  // Antes de abrir el pool de la base: una configuración inválida (p. ej. CALL_TIMEOUT_MS=abc) falla aquí sin dejar nada abierto.
  const clients = crearClientes(config, log);
  const db = createDb(config.db);
  const app = createApp({ db, clients, logger: log, env });
  return { app, server: http.createServer(app), db, config, clients };
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
