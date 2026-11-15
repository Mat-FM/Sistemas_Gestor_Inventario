const express = require('express');
const { SERVICIO, validarEntorno } = require('./config/env');
const { cuerpoError } = require('./http/cuerpoError');
const { logger: loggerPorDefecto } = require('./logger');

/**
 * Arma la aplicación Express.
 * - db: instancia de Knex; clients: clientes de ms-catalogo y ms-notificaciones; los usan las rutas del servicio.
 * - logger: { info(obj), error(obj) }.
 * - env: entorno que valida /health (por defecto process.env); las pruebas pasan uno explícito.
 */
function createApp({ db, clients, logger = loggerPorDefecto, env = process.env } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

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

  return app;
}

module.exports = { createApp };
