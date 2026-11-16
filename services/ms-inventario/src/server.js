const http = require('node:http');
const { types } = require('node:util');
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

// Nombre y mensaje de lo que se lanzó, para el registro: nunca la pila (Node la vuelca sola, en varias líneas, y no es JSON).
// Lo lanzado puede no ser un Error (un throw de texto) y su mensaje puede no ser legible: describirlo nunca lanza. Los errores de
// red (EADDRINUSE) los crea Node, no este módulo: `instanceof Error` falla con ellos si el código corre en otro contexto de V8
// (el de Jest); isNativeError los reconoce en cualquiera.
const esError = (err) => types.isNativeError(err) || err instanceof Error;

function describirError(err) {
  const nombre = esError(err) ? err.name : typeof err;
  let mensaje;
  try {
    mensaje = esError(err) ? err.message : String(err);
  } catch {
    mensaje = 'no se pudo describir el error';
  }
  return { nombre, mensaje };
}

/**
 * Arranque del servicio: arma el servidor y lo pone a escuchar. Una configuración inválida (p. ej. CALL_TIMEOUT_MS=abc o PORT=abc)
 * o cualquier otro fallo al armarlo se registra con el logger estructurado, solo con nombre y mensaje (es un error de configuración,
 * no un defecto: sin pila ni TypeError volcado por Node), y el proceso sale con código 1 para que Kubernetes lo reinicie y lo muestre.
 * Con variables obligatorias ausentes o URL inválidas NO es un error de arranque: el servicio escucha y /health responde 503 (D17).
 * Un fallo del servidor de red (puerto ocupado, EADDRINUSE; sin permiso, EACCES) llega después, como evento `error`, y recibe el
 * mismo trato: se registra, se suelta el pool y se sale con 1, una sola vez aunque lleguen varios errores seguidos. Sin manejador
 * Node lo volcaría como excepción no capturada.
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
    log.error({ mensaje: 'No se pudo iniciar el servicio', error: describirError(err) });
    salir(1);
    return null;
  }

  const { server, db, config } = creado;

  // Al escalar hacia abajo Kubernetes envía SIGTERM: se atienden las peticiones en curso y se cierra el pool.
  const senales = ['SIGTERM', 'SIGINT'].map((senal) => {
    const alRecibirla = () => server.close(() => db.destroy().finally(() => salir(0)));
    process.once(senal, alRecibirla);
    return [senal, alRecibirla];
  });

  // Registrado antes de escuchar: el fallo de listen (EADDRINUSE…) se emite de forma asíncrona. Con el servidor roto ya no hay nada
  // que cerrar con SIGTERM: se quitan esos manejadores. El pool no abrió conexiones, pero se destruye igual antes de salir.
  // El manejador es PERMANENTE (`on`, no `once`) y solo el primer error cuenta: un servidor sin conexiones libres emite un EMFILE
  // por cada intento de aceptar, y un segundo `error` sin manejador volvería a lanzar «Unhandled 'error' event» con su pila, justo
  // lo que este manejador evita. Los siguientes se ignoran: el primero es la causa y ya se registró.
  let fallido = false;
  server.on('error', (err) => {
    if (fallido) return;
    fallido = true;
    for (const [senal, alRecibirla] of senales) process.removeListener(senal, alRecibirla);
    log.error({ mensaje: server.listening ? 'Error del servidor' : 'No se pudo escuchar', puerto: config.puerto, error: describirError(err) });
    Promise.resolve()
      .then(() => db.destroy())
      .catch(() => {})
      .finally(() => salir(1));
  });
  server.listen(config.puerto, () => log.info({ mensaje: 'Servidor iniciado', puerto: config.puerto }));
  return creado;
}

if (require.main === module) iniciar();

module.exports = { createServer, iniciar };
