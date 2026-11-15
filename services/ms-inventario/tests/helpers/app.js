const supertest = require('supertest');
const { createApp } = require('../../src/app');
const { createTestDb } = require('./db');

// Entorno completo y fijo para /health, para que las pruebas no dependan del .env local.
// Los valores son centinelas reconocibles: así se comprueba que nunca llegan al registro.
function entornoValido() {
  return {
    DB_HOST: 'host-centinela.interno',
    DB_PORT: '54329',
    DB_NAME: 'base_centinela',
    DB_USER: 'usuario_centinela',
    MS_CATALOGO_URL: 'http://catalogo-centinela:8000',
    MS_NOTIFICACIONES_URL: 'http://notificaciones-centinela:5000',
  };
}

const loggerSilencioso = () => ({ info() {}, error() {} });

/**
 * Aplicación Express sobre la base de pruebas real (PostgreSQL) y con clientes inyectables.
 * Quien la use debe cerrar el pool al terminar: `afterAll(() => db.destroy())`.
 */
function buildTestApp({ clients = {}, logger = loggerSilencioso(), env = entornoValido() } = {}) {
  const db = createTestDb();
  const app = createApp({ db, clients, logger, env });
  return { app, db, clients, request: supertest(app) };
}

module.exports = { buildTestApp, entornoValido };
