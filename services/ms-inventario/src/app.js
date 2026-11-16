const express = require('express');
const { SERVICIO, validarEntorno } = require('./config/env');
const { cuerpoError } = require('./http/cuerpoError');
const { logger: loggerPorDefecto } = require('./logger');
const { crearErrorHandler, rutaNoEncontrada } = require('./middleware/errorHandler');
const { identity } = require('./middleware/identity');
const { crearRequestLog } = require('./middleware/requestLog');
const { montarDocs } = require('./routes/docs');
const { registrarRutas } = require('./routes');
const { LIMITE_CUERPO_CARGA_INICIAL, RUTA_CARGA_INICIAL } = require('./routes/internas');

/**
 * Arma la aplicación Express.
 * - db: instancia de Knex; clients: clientes de ms-catalogo y ms-notificaciones; los usan las rutas del servicio.
 * - logger: { info(obj), error(obj) }.
 * - env: entorno que valida /health (por defecto process.env); las pruebas pasan uno explícito.
 * - now: reloj `() => Date` de las reglas que dependen del día (la fecha de un conteo no puede ser pasada, D32(g)); si falta,
 *   cada servicio usa la hora real. Las pruebas lo fijan para no depender del día en que corren.
 */
function createApp({ db, clients, logger = loggerPorDefecto, env = process.env, now } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Orden fijo. requestLog va primero: abre el contexto del request_id y registra hasta las peticiones que fallan después.
  // identity va antes que el analizador de JSON: una identidad inválida se rechaza sin leer el cuerpo.
  app.use(crearRequestLog({ logger }));
  app.use(identity);
  // La carga inicial admite hasta 1 MB (D34(c)): su analizador se monta con método y ruta, ANTES del global, y es el único que se
  // salta los 100 kB. El global no vuelve a leer un cuerpo que ya se leyó (body-parser lo detecta con `isFinished`), y un
  // error del propio analizador (JSON mal formado 400, más de 1 MB 413, charset 415) sigue el mismo manejo de D18.
  app.post(RUTA_CARGA_INICIAL, express.json({ limit: LIMITE_CUERPO_CARGA_INICIAL }));
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

  // Documentación OpenAPI (RNF08): GET /docs y GET /docs/openapi.yaml. Ruta del servicio, como /health: sin Gateway, sin base de
  // datos y sin exigir identidad (una cabecera X-User-* inválida es 401, como en toda ruta, porque `identity` corre antes); lee sus
  // dos archivos al construir (si faltan, la aplicación no se construye).
  montarDocs(app);

  // Rutas de negocio (routes/index.js): las lecturas aceptan llamadas internas sin X-User-Id y las escrituras lo exigen.
  registrarRutas(app, { db, clients, logger, now });

  // ---- Fin de las rutas: no añadir rutas debajo de esta línea (nunca se alcanzarían). ----

  app.use(rutaNoEncontrada);
  app.use(crearErrorHandler({ logger }));

  return app;
}

module.exports = { createApp };
