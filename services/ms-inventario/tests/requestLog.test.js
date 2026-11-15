const { e } = require('../src/errors');
const { miniApp, UUID } = require('./helpers/miniapp');
const { capturarStdout } = require('./helpers/stdout');

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Logger falso que entrega (como promesa) el primer registro de nivel info: la línea sale al terminar la respuesta,
// y eso puede pasar después de que el cliente la recibió.
function loggerEspia() {
  const log = { info: jest.fn(), error: jest.fn() };
  log.primerRegistro = new Promise((resolver) => {
    log.info.mockImplementationOnce(resolver);
  });
  return log;
}

describe('requestLog', () => {
  it('escribe un registro por petición con request_id, metodo, ruta, estado, id_usuario y duracion_ms', async () => {
    const log = loggerEspia();
    const { request } = miniApp((app) => app.get('/x', (_req, res) => res.json({})), { logger: log });
    const res = await request.get('/x');
    const registro = await log.primerRegistro;
    expect(registro).toEqual({
      request_id: res.headers['x-request-id'],
      metodo: 'GET',
      ruta: '/x',
      estado: 200,
      id_usuario: null,
      duracion_ms: expect.any(Number),
    });
    expect(registro.request_id).toMatch(UUID);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('con el logger real escribe una línea JSON con servicio, nivel, request_id, metodo, ruta y estado', async () => {
    const stdout = capturarStdout();
    try {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.status(201).json({})));
      const res = await request.post('/x').send({}).set('X-User-Id', '7').set('X-User-Rol', 'ADMINISTRADOR');
      const linea = await stdout.esperar((registro) => registro.request_id === res.headers['x-request-id']);
      expect(linea).toEqual({
        servicio: 'ms-inventario',
        nivel: 'info',
        request_id: res.headers['x-request-id'],
        metodo: 'POST',
        ruta: '/x',
        estado: 201,
        id_usuario: 7,
        duracion_ms: expect.any(Number),
      });
    } finally {
      stdout.restaurar();
    }
  });

  it('la ruta no incluye la cadena de consulta', async () => {
    const log = loggerEspia();
    const { request } = miniApp((app) => app.get('/saldos', (_req, res) => res.json({})), { logger: log });
    await request.get('/saldos?id_producto=5&por_pagina=100');
    expect((await log.primerRegistro).ruta).toBe('/saldos');
  });

  it('el id_usuario sale de la identidad', async () => {
    const log = loggerEspia();
    const { request } = miniApp((app) => app.get('/x', (_req, res) => res.json({})), { logger: log });
    await request.get('/x').set({ 'X-User-Id': '42', 'X-User-Rol': 'CONTADOR' });
    expect((await log.primerRegistro).id_usuario).toBe(42);
  });

  it('un X-User-Id inválido (401 antes de fijar la identidad) se registra con id_usuario null y su request_id', async () => {
    const log = loggerEspia();
    const { request } = miniApp((app) => app.get('/x', (_req, res) => res.json({})), { logger: log });
    const res = await request.get('/x').set('X-User-Id', 'abc').set('X-Request-Id', 'del-gateway-9');
    expect(res.status).toBe(401);
    expect(await log.primerRegistro).toMatchObject({ request_id: 'del-gateway-9', estado: 401, id_usuario: null });
  });

  it('se escribe al terminar la respuesta, con el estado final (también el que fija errorHandler), no al llegar', async () => {
    const log = loggerEspia();
    let alLlegar;
    const { request } = miniApp(
      (app) =>
        app.get('/x', () => {
          alLlegar = log.info.mock.calls.length;
          throw e.noExiste('no está');
        }),
      { logger: log },
    );
    await request.get('/x');
    const registro = await log.primerRegistro;
    expect(alLlegar).toBe(0);
    expect(registro.estado).toBe(404);
  });

  it('duracion_ms mide el tiempo hasta terminar la respuesta', async () => {
    const log = loggerEspia();
    const { request } = miniApp((app) => app.get('/lenta', async (_req, res) => { await dormir(60); res.json({}); }), { logger: log });
    await request.get('/lenta');
    const { duracion_ms: duracion } = await log.primerRegistro;
    expect(duracion).toBeGreaterThanOrEqual(50);
    expect(duracion).toBeLessThan(5000);
  });

  it('una petición abortada por el cliente también deja su línea, marcada como abortada', async () => {
    const log = loggerEspia();
    const { app } = miniApp((a) => a.get('/lenta', async (_req, res) => { await dormir(200); res.json({}); }), { logger: log });
    const servidor = app.listen(0, '127.0.0.1');
    await new Promise((resolver) => servidor.once('listening', resolver));
    try {
      const control = new AbortController();
      const pendiente = fetch(`http://127.0.0.1:${servidor.address().port}/lenta`, { signal: control.signal }).catch(() => 'abortada');
      await dormir(30);
      control.abort();
      expect(await pendiente).toBe('abortada');
      expect(await log.primerRegistro).toMatchObject({ metodo: 'GET', ruta: '/lenta', abortada: true });
    } finally {
      servidor.closeAllConnections();
      await new Promise((resolver) => servidor.close(resolver));
    }
  });

  it('una petición normal no lleva el campo abortada', async () => {
    const log = loggerEspia();
    const { request } = miniApp((app) => app.get('/x', (_req, res) => res.json({})), { logger: log });
    await request.get('/x');
    expect(await log.primerRegistro).not.toHaveProperty('abortada');
  });

  it('pone X-Request-Id en la respuesta: el del cliente si viene, y si no un UUID', async () => {
    const { request } = miniApp((app) => app.get('/x', (_req, res) => res.json({})), { logger: { info() {}, error() {} } });
    expect((await request.get('/x').set('X-Request-Id', 'abc-123')).headers['x-request-id']).toBe('abc-123');
    expect((await request.get('/x')).headers['x-request-id']).toMatch(UUID);
  });
});
