const express = require('express');
const { SERVICIO, validarEntorno } = require('./config/env');
const { cuerpoError } = require('./http/cuerpoError');
const { logger: loggerPorDefecto } = require('./logger');
const { crearErrorHandler, rutaNoEncontrada } = require('./middleware/errorHandler');
const { identity } = require('./middleware/identity');
const { crearRequestLog } = require('./middleware/requestLog');
const { registrarRutas } = require('./routes');

/**
 * Arma la aplicación Express.
 * - db: instancia de Knex; clients: clientes de ms-catalogo y ms-notificaciones; los usan las rutas del servicio.
 * - logger: { info(obj), error(obj) }.
 * - env: entorno que valida /health (por defecto process.env); las pruebas pasan uno explícito.
 */
function createApp({ db, clients, logger = loggerPorDefecto, env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Orden fijo. requestLog va primero: abre el contexto del request_id y registra hasta las peticiones que fallan después.
  // identity va antes que el analizador de JSON: una identidad inválida se rechaza sin leer el cuerpo.
  app.use(crearRequestLog({ logger }));
  app.use(identity);
  app.use(express.json({ limit: '100kb' })); // un cuerpo mayor es 413 PETICION_MAL_FORMADA (D18)

  // ---- Rutas del servicio: se montan aquí, antes del 404. ----

  // Liveness (RNF10): comprueba la configuración, no la base de datos; una caída de PostgreSQL no debe reiniciar el pod (D17).
  app.get('/health', (req, res) => {
    const { faltantes, invalidas } = validarEntorno(env);
    if (faltantes.length > 0 || invalidas.length > 0) {
      // Qué falla solo se dice en el registro (con nombres, nunca valores); la respuesta no lo revela.
      logger.error({ mensaje: 'Configuración incompleta o inválida', faltantes, invalidas });
      return res.status(503).json(cuerpoError('SERVICIO_NO_DISPONIBLE', 'El servicio no está disponible'));
    }
    return res.json({ estado: 'ok', servicio: SERVICIO });
  });

  // Rutas de negocio (routes/index.js): las lecturas aceptan llamadas internas sin X-User-Id y las escrituras lo exigen.
  registrarRutas(app, { db, clients, logger });

  // ---- Fin de las rutas: no añadir rutas debajo de esta línea (nunca se alcanzarían). ----

  app.use(rutaNoEncontrada);
  app.use(crearErrorHandler({ logger }));

  return app;
}

module.exports = { createApp };
