const http = require('node:http');
const { AppError } = require('../src/errors');
const { ejecutarEnPeticion } = require('../src/logger');
const { headersDe } = require('../src/clients/propagacion');
const { createServer } = require('../src/server');
const { entornoValido } = require('./helpers/app');

describe('createServer', () => {
  it('arma la aplicación con la configuración del entorno y responde /health por HTTP real', async () => {
    const env = { ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', PORT: '3456', CALL_TIMEOUT_MS: '1500' };
    // Logger silencioso: la línea de requestLog de /health no debe ensuciar la salida de las pruebas.
    const { server, db, config, clients } = createServer(env, { info: jest.fn(), error: jest.fn() });
    try {
      // Los clientes reales de ms-catalogo y ms-notificaciones se construyen en el arranque (las rutas los usan desde la Tarea 7).
      expect(clients).toEqual({
        catalogo: { obtenerProducto: expect.any(Function) },
        notificaciones: { notificarStockBajo: expect.any(Function) },
      });
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

// ---- Cableado de los clientes de otros servicios (Tarea 5): servidores HTTP falsos de ms-catalogo y ms-notificaciones ----

async function levantarStub() {
  const peticiones = [];
  const stub = { peticiones, responder: (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}') };
  const servidor = http.createServer((req, res) => {
    const registro = { metodo: req.method, ruta: req.url, headers: req.headers, cuerpo: '' };
    peticiones.push(registro);
    req.on('data', (trozo) => { registro.cuerpo += trozo; });
    req.on('end', () => stub.responder(req, res, registro));
  });
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  stub.url = `http://127.0.0.1:${servidor.address().port}`;
  stub.cerrar = async () => {
    servidor.closeAllConnections(); // un manejador que no responde deja su conexión abierta
    await new Promise((resolver) => servidor.close(resolver));
  };
  return stub;
}

const json = (status, cuerpo) => (_req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(cuerpo));
const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

describe('createServer: clientes de ms-catalogo y ms-notificaciones', () => {
  let catalogo;
  let notificaciones;
  const bases = [];
  const loggerEspia = () => ({ info: jest.fn(), error: jest.fn() });

  beforeEach(async () => {
    catalogo = await levantarStub();
    notificaciones = await levantarStub();
    notificaciones.responder = json(202, { aceptada: true });
  });

  afterEach(async () => {
    await catalogo.cerrar();
    await notificaciones.cerrar();
    await Promise.all(bases.splice(0).map((db) => db.destroy()));
  });

  // Arma el servidor con las URL de los stubs; las pruebas no lo ponen a escuchar (solo usan los clientes).
  function armar(extra = {}, log = loggerEspia()) {
    const env = {
      ...entornoValido(),
      NODE_ENV: 'test',
      TEST_DB_NAME: 'inventario_test',
      MS_CATALOGO_URL: catalogo.url,
      MS_NOTIFICACIONES_URL: notificaciones.url,
      ...extra,
    };
    const creado = createServer(env, log);
    bases.push(creado.db);
    return { ...creado, log };
  }

  const aviso = { idProducto: 12, idBodega: 2, cantidadTotal: 3, cantidadMinima: 10 };

  it('cada cliente llega a la URL de su servicio, con las cabeceras de propagación y sin las ajenas', async () => {
    catalogo.responder = json(200, { id_producto: 5, codigo: 'P5' });
    const { clients } = armar();

    const producto = await clients.catalogo.obtenerProducto(5, { 'X-Request-Id': 'req-5', 'X-User-Id': '7', Authorization: 'Bearer secreto' });
    expect(producto).toEqual({ id_producto: 5, codigo: 'P5' });
    expect(catalogo.peticiones).toHaveLength(1);
    expect(catalogo.peticiones[0]).toMatchObject({ metodo: 'GET', ruta: '/productos/5' });
    expect(catalogo.peticiones[0].headers).toMatchObject({ 'x-request-id': 'req-5', 'x-user-id': '7', accept: 'application/json' });
    expect(catalogo.peticiones[0].headers).not.toHaveProperty('authorization');
    expect(notificaciones.peticiones).toHaveLength(0);

    await expect(clients.notificaciones.notificarStockBajo(aviso, { 'X-Request-Id': 'req-5' })).resolves.toBeUndefined();
    expect(notificaciones.peticiones).toHaveLength(1);
    expect(notificaciones.peticiones[0]).toMatchObject({ metodo: 'POST', ruta: '/internas/notificaciones' });
    expect(JSON.parse(notificaciones.peticiones[0].cuerpo)).toEqual({
      tipo: 'STOCK_BAJO',
      mensaje: 'Stock bajo del producto 12 tras un movimiento en la bodega 2: quedan 3 unidades en total y el mínimo es 10.',
      id_producto: 12,
      id_bodega: 2,
    });
    expect(notificaciones.peticiones[0].headers['content-type']).toBe('application/json');
    expect(catalogo.peticiones).toHaveLength(1);
  });

  it('el request_id de la petición en curso viaja al otro servicio junto con la identidad', async () => {
    catalogo.responder = json(200, { id_producto: 5 });
    const { clients } = armar();
    const identidad = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'req-identidad' };
    await ejecutarEnPeticion('req-en-curso', () => clients.catalogo.obtenerProducto(5, headersDe(identidad)));
    expect(catalogo.peticiones[0].headers).toMatchObject({ 'x-request-id': 'req-en-curso', 'x-user-id': '7', 'x-user-rol': 'ADMINISTRADOR' });
    expect(catalogo.peticiones[0].headers).not.toHaveProperty('x-user-bodega');
  });

  it('un 404 de catálogo es "el producto no existe" (null) y no se reintenta', async () => {
    catalogo.responder = json(404, { error: { codigo: 'NO_EXISTE' } });
    const { clients, log } = armar();
    expect(await clients.catalogo.obtenerProducto(999)).toBeNull();
    expect(catalogo.peticiones).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('cada servicio lleva su propio circuito: abrir el de notificaciones no afecta al de catálogo, y viceversa', async () => {
    catalogo.responder = json(200, { id_producto: 5 });
    notificaciones.responder = json(500, { error: {} });
    const { clients } = armar();

    for (let i = 0; i < 5; i += 1) await expect(clients.notificaciones.notificarStockBajo(aviso)).resolves.toBeUndefined();
    expect(notificaciones.peticiones).toHaveLength(5);
    // sexta: el circuito de notificaciones está abierto y no llega ninguna petición; el aviso sigue sin lanzar
    await expect(clients.notificaciones.notificarStockBajo(aviso)).resolves.toBeUndefined();
    expect(notificaciones.peticiones).toHaveLength(5);
    // catálogo no se entera
    expect(await clients.catalogo.obtenerProducto(5)).toEqual({ id_producto: 5 });
    expect(catalogo.peticiones).toHaveLength(1);

    // ahora al revés: un 200 que no es JSON no se reintenta (cinco llamadas rápidas abren el circuito de catálogo)
    catalogo.responder = (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>proxy</html>');
    for (let i = 0; i < 5; i += 1) {
      await expect(clients.catalogo.obtenerProducto(5)).rejects.toMatchObject({ status: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
    }
    expect(catalogo.peticiones).toHaveLength(6);
    await expect(clients.catalogo.obtenerProducto(5)).rejects.toBeInstanceOf(AppError);
    expect(catalogo.peticiones).toHaveLength(6); // abierto: no llamó
    // el estado vive en cada cliente (no en el módulo): un servidor nuevo parte con los circuitos cerrados aunque estos dos sigan abiertos
    const otro = armar();
    notificaciones.responder = json(202, {});
    await otro.clients.notificaciones.notificarStockBajo(aviso);
    expect(notificaciones.peticiones).toHaveLength(6);
  });

  it('un fallo de notificaciones registra el detalle técnico (cliente HTTP) y el aviso perdido (cliente de notificaciones), una vez cada uno', async () => {
    notificaciones.responder = json(500, { error: {} });
    const { clients, log } = armar();
    await clients.notificaciones.notificarStockBajo(aviso);
    const mensajes = log.error.mock.calls.map(([registro]) => registro);
    expect(mensajes).toEqual([
      expect.objectContaining({ mensaje: 'Llamada a otro servicio fallida', destino: 'ms-notificaciones', motivo: 'error_del_servicio', estado: 500, intentos: 1 }),
      expect.objectContaining({ mensaje: 'No se pudo avisar el stock bajo a ms-notificaciones', id_producto: 12, id_bodega: 2 }),
    ]);
  });

  it('CALL_TIMEOUT_MS gobierna la espera máxima de las llamadas', async () => {
    notificaciones.responder = () => {}; // nunca responde
    const { clients, log } = armar({ CALL_TIMEOUT_MS: '60' });
    const inicio = Date.now();
    await expect(clients.notificaciones.notificarStockBajo(aviso)).resolves.toBeUndefined();
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(notificaciones.peticiones).toHaveLength(1);
    expect(log.error.mock.calls[0][0]).toMatchObject({ destino: 'ms-notificaciones', motivo: 'tiempo_agotado' });
  });

  it('sin URL de los servicios createServer no se cae: /health lo avisa y los clientes responden 503 sin llamar a nadie', async () => {
    const log = loggerEspia();
    const { clients, db } = createServer({ NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test' }, log);
    bases.push(db);
    await expect(clients.catalogo.obtenerProducto(1)).rejects.toMatchObject({ status: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
    await expect(clients.notificaciones.notificarStockBajo(aviso)).resolves.toBeUndefined();
    expect(catalogo.peticiones).toHaveLength(0);
    expect(notificaciones.peticiones).toHaveLength(0);
  });

  it('un CALL_TIMEOUT_MS que no es un número falla al arrancar, antes de abrir el pool de la base (en vez de dejar un plazo de 1 ms)', () => {
    const env = { ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', CALL_TIMEOUT_MS: 'abc' };
    let createDbEspia;
    let crear;
    jest.isolateModules(() => {
      const real = jest.requireActual('../src/config/db');
      createDbEspia = jest.fn(real.createDb);
      jest.doMock('../src/config/db', () => ({ ...real, createDb: createDbEspia }));
      try {
        crear = require('../src/server').createServer;
      } finally {
        jest.dontMock('../src/config/db');
      }
    });

    expect(() => crear(env, loggerEspia())).toThrow(TypeError);
    expect(createDbEspia).not.toHaveBeenCalled();
    // control: con un número válido arranca y sí abre el pool
    const { db } = crear({ ...env, CALL_TIMEOUT_MS: '2500' }, loggerEspia());
    bases.push(db);
    expect(createDbEspia).toHaveBeenCalledTimes(1);
  });

  it('entrega a createApp los mismos clientes que devuelve createServer y el logger recibido', async () => {
    const log = loggerEspia();
    let espia;
    let creado;
    jest.isolateModules(() => {
      espia = jest.fn(jest.requireActual('../src/app').createApp);
      jest.doMock('../src/app', () => ({ createApp: espia }));
      try {
        creado = require('../src/server').createServer(
          { ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', MS_CATALOGO_URL: catalogo.url, MS_NOTIFICACIONES_URL: notificaciones.url },
          log,
        );
      } finally {
        jest.dontMock('../src/app');
      }
    });
    bases.push(creado.db);
    expect(espia).toHaveBeenCalledTimes(1);
    const argumentos = espia.mock.calls[0][0];
    expect(argumentos.clients).toBe(creado.clients);
    expect(argumentos.logger).toBe(log);
    expect(argumentos.db).toBe(creado.db);
    await dormir(0);
  });
});
