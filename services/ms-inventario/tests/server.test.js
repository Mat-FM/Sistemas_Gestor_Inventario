const { createServer } = require('../src/server');
const { entornoValido } = require('./helpers/app');

describe('createServer', () => {
  it('arma la aplicación con la configuración del entorno y responde /health por HTTP real', async () => {
    const env = { ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', PORT: '3456', CALL_TIMEOUT_MS: '1500' };
    // Logger silencioso: la línea de requestLog de /health no debe ensuciar la salida de las pruebas.
    const { server, db, config } = createServer(env, { info: jest.fn(), error: jest.fn() });
    try {
      expect(config).toMatchObject({
        puerto: 3456,
        callTimeoutMs: 1500,
        catalogoUrl: env.MS_CATALOGO_URL,
        notificacionesUrl: env.MS_NOTIFICACIONES_URL,
        db: { host: env.DB_HOST, port: 54329, database: 'inventario_test', user: env.DB_USER },
      });

      await new Promise((resolver) => server.listen(0, '127.0.0.1', resolver));
      const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      expect(respuesta.status).toBe(200);
      expect(await respuesta.json()).toEqual({ estado: 'ok', servicio: 'ms-inventario' });
    } finally {
      await new Promise((resolver) => server.close(resolver));
      await db.destroy();
    }
  });

  it('sin variables de entorno usa los valores por defecto y /health avisa que falta la configuración', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const { server, db, config } = createServer({}, logger);
    try {
      expect(config.puerto).toBe(3000);
      expect(config.callTimeoutMs).toBe(3000);

      await new Promise((resolver) => server.listen(0, '127.0.0.1', resolver));
      const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      expect(respuesta.status).toBe(503);
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolver) => server.close(resolver));
      await db.destroy();
    }
  });
});
