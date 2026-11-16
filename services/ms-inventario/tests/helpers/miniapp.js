const express = require('express');
const supertest = require('supertest');
const { identity } = require('../../src/middleware/identity');
const { crearErrorHandler, rutaNoEncontrada } = require('../../src/middleware/errorHandler');
const { crearRequestLog } = require('../../src/middleware/requestLog');
const { logger: loggerReal } = require('../../src/logger');

/**
 * Mini app con las piezas de la Tarea 2 en el mismo orden que createApp, para probarlas con rutas propias
 * (createApp todavía no tiene rutas que fallen, y las rutas añadidas después del 404 nunca se alcanzan).
 * - rutas(app): registra las rutas de la prueba.
 * - conRequestLog / conIdentidad: permiten montar `identity` o `requestLog` solos.
 * Devuelve { app, request } con `request` de supertest.
 */
function miniApp(rutas, { logger = loggerReal, conRequestLog = true, conIdentidad = true } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (conRequestLog) app.use(crearRequestLog({ logger }));
  if (conIdentidad) app.use(identity);
  app.use(express.json());
  rutas(app);
  app.use(rutaNoEncontrada);
  app.use(crearErrorHandler({ logger }));
  return { app, request: supertest(app) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

module.exports = { miniApp, UUID };
