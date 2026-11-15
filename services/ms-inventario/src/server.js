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
  // cargarConfig ya validó el plazo (CALL_TIMEOUT_MS=abc falla ahí, sin construir clientes ni abrir el pool); los clientes se arman antes que la base.
  const clients = crearClientes(config, log);
  const db = createDb(config.db);
  const app = createApp({ db, clients, logger: log, env });
  return { app, server: http.createServer(app), db, config, clients };
}

/**
 * Arranque del servicio: arma el servidor y lo pone a escuchar. Una configuración inválida (p. ej. CALL_TIMEOUT_MS=abc) o cualquier
 * otro fallo al armarlo se registra con el logger estructurado, solo con nombre y mensaje (es un error de configuración, no un
 * defecto: sin pila ni TypeError volcado por Node), y el proceso sale con código 1 para que Kubernetes lo reinicie y lo muestre.
 * Con variables obligatorias ausentes o URL inválidas NO es un error de arranque: el servicio escucha y /health responde 503 (D17).
 * @param {NodeJS.ProcessEnv} env
 * @param {{info: Function, error: Function}} log
 * @param {(codigo: number) => void} salir termina el proceso (inyectable en las pruebas)
 * @returns {object|null} lo que devuelve createServer, o null si el arranque falló
 */
function iniciar(env = process.env, log = logger, salir = (codigo) => process.exit(codigo)) {
  let creado;
  try {
    creado = createServer(env, log);
  } catch (err) {
    const nombre = err instanceof Error ? err.name : typeof err;
    let mensaje;
    try {
      mensaje = err instanceof Error ? err.message : String(err);
    } catch {
      mensaje = 'no se pudo describir el error';
    }
    log.error({ mensaje: 'No se pudo iniciar el servicio', error: { nombre, mensaje } });
    salir(1);
    return null;
  }

  const { server, db, config } = creado;
  server.listen(config.puerto, () => log.info({ mensaje: 'Servidor iniciado', puerto: config.puerto }));

  // Al escalar hacia abajo Kubernetes envía SIGTERM: se atienden las peticiones en curso y se cierra el pool.
  for (const senal of ['SIGTERM', 'SIGINT']) {
    process.once(senal, () => {
      server.close(() => db.destroy().finally(() => salir(0)));
    });
  }
  return creado;
}

if (require.main === module) iniciar();

module.exports = { createServer, iniciar };
