const { AppError, e } = require('../src/errors');
const { logger } = require('../src/logger');
const { buildTestApp } = require('./helpers/app');
const { miniApp, UUID } = require('./helpers/miniapp');
const { capturarStdout } = require('./helpers/stdout');

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

const CUERPO_500 = { error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno del servidor', detalles: [] } };

describe('AppError y la fábrica e', () => {
  it.each([
    ['malFormada', () => e.malFormada('m'), 400, 'PETICION_MAL_FORMADA', 'm', []],
    ['noAutenticado', () => e.noAutenticado('m'), 401, 'NO_AUTENTICADO', 'm', []],
    ['sinPermiso', () => e.sinPermiso('m'), 403, 'SIN_PERMISO', 'm', []],
    ['noExiste', () => e.noExiste('m'), 404, 'NO_EXISTE', 'm', []],
    ['conflicto', () => e.conflicto('CODIGO_DUPLICADO', 'm'), 409, 'CODIGO_DUPLICADO', 'm', []],
    ['conflicto con detalles', () => e.conflicto('STOCK_INSUFICIENTE', 'm', [{ campo: 'cantidad', mensaje: 'x', disponible: 1, solicitado: 2 }]), 409, 'STOCK_INSUFICIENTE', 'm', [{ campo: 'cantidad', mensaje: 'x', disponible: 1, solicitado: 2 }]],
    ['datosNoValidos', () => e.datosNoValidos([{ campo: 'cantidad', mensaje: 'x' }]), 422, 'DATOS_NO_VALIDOS', expect.any(String), [{ campo: 'cantidad', mensaje: 'x' }]],
    ['noDisponible', () => e.noDisponible('m'), 503, 'SERVICIO_NO_DISPONIBLE', 'm', []],
  ])('e.%s crea un AppError con su estado, código, mensaje y detalles', (_nombre, crear, status, codigo, mensaje, detalles) => {
    const error = crear();
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status, codigo, message: mensaje, detalles });
  });

  it('los mensajes son opcionales: cada fábrica trae un mensaje por defecto en español', () => {
    for (const crear of [e.malFormada, e.noAutenticado, e.sinPermiso, e.noExiste, e.noDisponible]) {
      const { message } = crear();
      expect(typeof message).toBe('string');
      expect(message.trim()).not.toBe('');
    }
  });

  it('AppError directo: detalles vale [] por defecto', () => {
    const error = new AppError(409, 'TRASLADO_YA_RECIBIDO', 'ya recibido');
    expect(error).toMatchObject({ status: 409, codigo: 'TRASLADO_YA_RECIBIDO', message: 'ya recibido', detalles: [] });
  });
});

describe('errorHandler', () => {
  let stdout;
  beforeEach(() => {
    stdout = capturarStdout();
  });
  afterEach(() => stdout.restaurar());

  it('AppError → envoltorio común', async () => {
    const { request } = miniApp((app) => app.get('/x', () => { throw e.sinPermiso('x'); }));
    const res = await request.get('/x');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { codigo: 'SIN_PERMISO', mensaje: 'x', detalles: [] } });
  });

  it.each([
    ['400', () => e.malFormada('m'), 400, 'PETICION_MAL_FORMADA'],
    ['401', () => e.noAutenticado('m'), 401, 'NO_AUTENTICADO'],
    ['404', () => e.noExiste('m'), 404, 'NO_EXISTE'],
    ['409 con su propio código', () => e.conflicto('STOCK_INSUFICIENTE', 'm'), 409, 'STOCK_INSUFICIENTE'],
    ['422 con detalles', () => e.datosNoValidos([{ campo: 'cantidad', mensaje: 'debe ser mayor que 0' }]), 422, 'DATOS_NO_VALIDOS'],
    ['503 sigue siendo 503, no 500', () => e.noDisponible('catálogo caído'), 503, 'SERVICIO_NO_DISPONIBLE'],
  ])('un AppError %s rechazado por una promesa llega solo al manejador (Express 5) y conserva estado y código', async (_n, crear, status, codigo) => {
    const error = crear();
    const { request } = miniApp((app) => app.get('/x', async () => { throw error; }));
    const res = await request.get('/x');
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { codigo, mensaje: error.message, detalles: error.detalles } });
  });

  describe('error desconocido → 500 ERROR_INTERNO genérico', () => {
    it.each([
      ['lanzado de forma síncrona', (app) => app.get('/x', () => { throw new Error('clave-secreta-123'); })],
      ['rechazado por una promesa', (app) => app.get('/x', async () => { throw new Error('clave-secreta-123'); })],
      ['lanzado un valor que no es Error', (app) => app.get('/x', () => { throw 'clave-secreta-123'; })],
      ['lanzado un objeto que no se puede convertir a texto (el registro no debe fallar)', (app) => app.get('/x', () => { throw Object.create(null); })],
      ['con status 503 propio de una librería (D18: todo 5xx ajeno es 500)', (app) => app.get('/x', (_req, _res, next) => next(Object.assign(new Error('clave-secreta-123'), { status: 503 })))],
      ['con status 500 y expose', (app) => app.get('/x', (_req, _res, next) => next(Object.assign(new Error('clave-secreta-123'), { status: 500, expose: true })))],
      ['con un status que no es HTTP', (app) => app.get('/x', (_req, _res, next) => next(Object.assign(new Error('clave-secreta-123'), { status: 'abc' })))],
    ])('%s: sin filtrar el stack ni el mensaje, aunque el entorno sea de desarrollo', async (_n, rutas) => {
      const { app, request } = miniApp(rutas);
      app.set('env', 'development');
      const res = await request.get('/x');
      expect(res.status).toBe(500);
      expect(res.body).toEqual(CUERPO_500);
      expect(res.text).not.toContain('clave-secreta-123');
      expect(res.text).not.toMatch(/\bat \S/); // «at Object.<anonymous> (…)»
      expect(res.text).not.toContain('.js');
      expect(res.text).not.toContain('node_modules');
    });
  });

  describe('base de datos inalcanzable → 503 SERVICIO_NO_DISPONIBLE (RNF18, D35)', () => {
    const CUERPO_503 = { error: { codigo: 'SERVICIO_NO_DISPONIBLE', mensaje: 'El servicio no está disponible', detalles: [] } };
    const conCodigo = (code, mensaje = 'clave-secreta-123') => Object.assign(new Error(mensaje), { code });

    it.each([
      ['conexión rechazada', () => conCodigo('ECONNREFUSED')],
      ['nombre del servidor que ya no resuelve', () => conCodigo('ENOTFOUND')],
      ['DNS sin respuesta', () => conCodigo('EAI_AGAIN')],
      ['conexión reiniciada', () => conCodigo('ECONNRESET')],
      ['plazo de red agotado', () => conCodigo('ETIMEDOUT')],
      ['servidor apagándose (57P01)', () => conCodigo('57P01')],
      ['servidor sin poder aceptar conexiones (57P03)', () => conCodigo('57P03')],
      ['demasiadas conexiones (53300)', () => conCodigo('53300')],
      ['fallo de conexión de la clase 08', () => conCodigo('08006')],
      ['Knex sin conexión libre', () => Object.assign(new Error('clave-secreta-123'), { name: 'KnexTimeoutError' })],
      ['pg: conexión terminada de golpe', () => new Error('Connection terminated unexpectedly clave-secreta-123')],
      ['pg: plazo para conectar', () => new Error('timeout exceeded when trying to connect clave-secreta-123')],
    ])('%s es 503, sin filtrar el mensaje, y se registra como fallo de disponibilidad', async (_n, crear) => {
      const { request } = miniApp((app) => app.get('/x', async () => { throw crear(); }));
      const res = await request.get('/x');
      expect(res.status).toBe(503);
      expect(res.body).toEqual(CUERPO_503);
      expect(res.text).not.toContain('clave-secreta-123');
      const linea = await stdout.esperar((l) => l.mensaje === 'Error de disponibilidad');
      expect(linea).toMatchObject({ estado: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
    });

    it.each([
      ['columna que no existe (42703)', () => conCodigo('42703')],
      ['violación de unicidad (23505)', () => conCodigo('23505')],
      ['error de programación sin código', () => new Error('clave-secreta-123')],
    ])('%s sigue siendo 500: no es un problema de conexión', async (_n, crear) => {
      const { request } = miniApp((app) => app.get('/x', async () => { throw crear(); }));
      const res = await request.get('/x');
      expect(res.status).toBe(500);
      expect(res.body).toEqual(CUERPO_500);
    });
  });

  describe('errores 4xx de Express o de express.json() (D18)', () => {
    const cuerpoMalFormada = (res) => {
      expect(res.body.error.codigo).toBe('PETICION_MAL_FORMADA');
      expect(res.body.error.detalles).toEqual([]);
      expect(typeof res.body.error.mensaje).toBe('string');
    };

    it('JSON mal formado → 400 PETICION_MAL_FORMADA', async () => {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.json({})));
      const res = await request.post('/x').set('Content-Type', 'application/json').send('{"a":');
      expect(res.status).toBe(400);
      expect(res.body.error.codigo).toBe('PETICION_MAL_FORMADA');
      cuerpoMalFormada(res);
    });

    it('no devuelve al cliente el mensaje del analizador (que cita trozos del cuerpo)', async () => {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.json({})));
      const res = await request.post('/x').set('Content-Type', 'application/json').send('trozo-del-cuerpo-xyz');
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('trozo-del-cuerpo-xyz');
      expect(res.text).not.toMatch(/Unexpected|JSON at position|is not valid JSON/i);
    });

    it('cuerpo de más de 100 kb → 413 PETICION_MAL_FORMADA', async () => {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.json({})));
      const res = await request.post('/x').set('Content-Type', 'application/json').send(JSON.stringify({ a: 'x'.repeat(150 * 1024) }));
      expect(res.status).toBe(413);
      cuerpoMalFormada(res);
    });

    it('charset no soportado → 415 PETICION_MAL_FORMADA', async () => {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.json({})));
      const res = await request.post('/x').set('Content-Type', 'application/json; charset=iso-8859-1').send('{}');
      expect(res.status).toBe(415);
      cuerpoMalFormada(res);
    });

    it('codificación de contenido no soportada → 415 PETICION_MAL_FORMADA', async () => {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.json({})));
      const res = await request.post('/x').set('Content-Type', 'application/json').set('Content-Encoding', 'foo').send('{}');
      expect(res.status).toBe(415);
      cuerpoMalFormada(res);
    });

    it('contenido comprimido corrupto → 400 PETICION_MAL_FORMADA sin filtrar el mensaje de la librería', async () => {
      const { request } = miniApp((app) => app.post('/x', (_req, res) => res.json({})));
      const res = await request.post('/x').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send('esto no es gzip');
      expect(res.status).toBe(400);
      cuerpoMalFormada(res);
      expect(res.text).not.toMatch(/header check|descriptor|zlib/i);
    });

    it('dirección con una codificación de porcentaje inválida → 400 PETICION_MAL_FORMADA', async () => {
      const { request } = miniApp((app) => app.get('/p/:id', (_req, res) => res.json({})));
      const res = await request.get('/p/%E0%A4%A');
      expect(res.status).toBe(400);
      cuerpoMalFormada(res);
    });

    it('cualquier otro error con status 4xx conserva su estado y no filtra su mensaje', async () => {
      const { request } = miniApp((app) => app.get('/x', (_req, _res, next) => next(Object.assign(new Error('detalle-interno-abc'), { status: 418 }))));
      const res = await request.get('/x');
      expect(res.status).toBe(418);
      cuerpoMalFormada(res);
      expect(res.text).not.toContain('detalle-interno-abc');
    });
  });

  it('ruta inexistente → 404 NO_EXISTE', async () => {
    const { request } = miniApp((app) => app.get('/existe', (_req, res) => res.json({})));
    const res = await request.get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.codigo).toBe('NO_EXISTE');
    expect(res.body.error.detalles).toEqual([]);
    expect(typeof res.body.error.mensaje).toBe('string');
  });

  it('un error 500 no filtra traza ni mensaje y se registra con el mismo request_id de la respuesta', async () => {
    const { app, request } = miniApp((a) => a.get('/boom', () => { throw new Error('clave-secreta-123'); }));
    app.set('env', 'development'); // el entorno de desarrollo es donde el manejador por defecto de Express sí enseña la traza
    const res = await request.get('/boom');
    const requestId = res.headers['x-request-id'];
    expect(requestId).toMatch(UUID);
    expect(res.status).toBe(500);
    expect(res.body).toEqual(CUERPO_500);
    expect(res.text).not.toContain('clave-secreta-123');
    expect(res.text).not.toMatch(/\bat \S/);

    // La causa solo queda en el registro del servidor, con el mismo identificador que ve el cliente.
    const linea = await stdout.esperar((registro) => registro.nivel === 'error' && registro.request_id === requestId);
    expect(linea).toMatchObject({ servicio: 'ms-inventario', nivel: 'error', request_id: requestId, metodo: 'GET', ruta: '/boom' });
    expect(linea.error.mensaje).toBe('clave-secreta-123');
    expect(linea.error.pila).toMatch(/\bat \S/);
  });

  it('un error 500 con X-Request-Id del cliente se registra con ese identificador', async () => {
    const { request } = miniApp((app) => app.get('/boom', async () => { throw new Error('x'); }));
    const res = await request.get('/boom').set('X-Request-Id', 'gateway-abc-123');
    expect(res.headers['x-request-id']).toBe('gateway-abc-123');
    const linea = await stdout.esperar((registro) => registro.nivel === 'error' && registro.request_id === 'gateway-abc-123');
    expect(linea.ruta).toBe('/boom');
  });

  it('un 503 de un AppError también se registra con su request_id (la causa operativa queda en el log)', async () => {
    const { request } = miniApp((app) => app.get('/x', () => { throw e.noDisponible('catálogo caído'); }));
    const res = await request.get('/x');
    const linea = await stdout.esperar((registro) => registro.nivel === 'error' && registro.request_id === res.headers['x-request-id']);
    expect(linea).toMatchObject({ estado: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
  });

  it('un 4xx no escribe línea de error (solo la línea de la petición, de nivel info)', async () => {
    const { request } = miniApp((app) => app.get('/x', () => { throw e.sinPermiso('x'); }));
    const res = await request.get('/x');
    await stdout.esperar((registro) => registro.request_id === res.headers['x-request-id'] && registro.estado === 403);
    expect(stdout.lineas().filter((registro) => registro.nivel === 'error')).toEqual([]);
  });
});

describe('request_id por petición (D19)', () => {
  let stdout;
  beforeEach(() => {
    stdout = capturarStdout();
  });
  afterEach(() => stdout.restaurar());

  it('dos peticiones concurrentes no mezclan su request_id, aunque registren después de un await', async () => {
    const { request } = miniApp((app) => {
      for (const [ruta, espera] of [['/lenta', 60], ['/rapida', 5]]) {
        app.get(ruta, async (_req, res) => {
          logger.info({ mensaje: 'antes', ruta });
          await dormir(espera);
          logger.info({ mensaje: 'despues', ruta });
          await dormir(espera);
          logger.error({ mensaje: 'advertencia de un cliente', ruta });
          res.json({});
        });
      }
    });
    const [lenta, rapida] = await Promise.all([request.get('/lenta'), request.get('/rapida')]);
    const ids = { '/lenta': lenta.headers['x-request-id'], '/rapida': rapida.headers['x-request-id'] };
    expect(ids['/lenta']).toMatch(UUID);
    expect(ids['/rapida']).toMatch(UUID);
    expect(ids['/lenta']).not.toBe(ids['/rapida']);

    // Toda línea de la petición lleva SU identificador: antes, después de los await, y también las de nivel error.
    const propias = stdout.lineas().filter((linea) => ['antes', 'despues', 'advertencia de un cliente'].includes(linea.mensaje));
    expect(propias).toHaveLength(6);
    for (const linea of propias) expect(linea.request_id).toBe(ids[linea.ruta]);
  });

  it('un registro con valores no serializables no cambia la respuesta: el 500 sigue siendo genérico (D18) y las líneas válidas', async () => {
    const circular = { nombre: 'c' };
    circular.yo = circular;
    const { app, request } = miniApp((a) =>
      a.get('/x', async () => {
        logger.info({ mensaje: 'antes', circular, cantidad: 5n });
        logger.error({ mensaje: 'imposible', detalle: { toJSON() { throw new Error('toJSON falla'); } } });
        throw new Error('clave-secreta-123');
      }),
    );
    app.set('env', 'development');
    const res = await request.get('/x');
    const id = res.headers['x-request-id'];
    expect(res.status).toBe(500);
    expect(res.body).toEqual(CUERPO_500);
    expect(res.text).not.toContain('clave-secreta-123');
    expect(res.text).not.toMatch(/\bat \S/);

    // Todas las líneas son JSON válido (capturarStdout las parsea) y llevan el request_id de la petición.
    const antes = await stdout.esperar((linea) => linea.mensaje === 'antes');
    expect(antes).toMatchObject({ request_id: id, circular: { nombre: 'c', yo: '[Circular]' }, cantidad: '5' });
    const respaldo = await stdout.esperar((linea) => linea.aviso === 'registro_no_serializable');
    expect(respaldo).toEqual({ aviso: 'registro_no_serializable', servicio: 'ms-inventario', nivel: 'error', request_id: id });
    const error = await stdout.esperar((linea) => linea.mensaje === 'Error interno no controlado');
    expect(error).toMatchObject({ nivel: 'error', request_id: id, estado: 500 });
    await stdout.esperar((linea) => linea.metodo === 'GET' && linea.request_id === id && linea.estado === 500);
  });

  it('un registro no serializable en una petición que acaba bien no la rompe', async () => {
    const { request } = miniApp((a) =>
      a.get('/x', (_req, res) => {
        logger.info({ detalle: { get explota() { throw new Error('getter falla'); } } });
        res.json({ ok: true });
      }),
    );
    const res = await request.get('/x');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const respaldo = await stdout.esperar((linea) => linea.aviso === 'registro_no_serializable');
    expect(respaldo.request_id).toBe(res.headers['x-request-id']);
  });

  it('una línea emitida fuera de toda petición no lleva request_id', async () => {
    const { request } = miniApp((app) => app.get('/x', (_req, res) => { logger.info({ mensaje: 'dentro' }); res.json({}); }));
    const res = await request.get('/x');
    logger.info({ mensaje: 'fuera' });
    const lineas = stdout.lineas();
    expect(lineas.find((linea) => linea.mensaje === 'dentro').request_id).toBe(res.headers['x-request-id']);
    expect(lineas.find((linea) => linea.mensaje === 'fuera')).not.toHaveProperty('request_id');
  });

  it('dos peticiones consecutivas por la misma conexión registran request_id distintos y la segunda no hereda el de la primera', async () => {
    const { app } = miniApp((a) => a.get('/ping', (_req, res) => { logger.info({ mensaje: 'dentro' }); res.json({}); }));
    const servidor = app.listen(0, '127.0.0.1');
    await new Promise((resolver) => servidor.once('listening', resolver));
    try {
      const base = `http://127.0.0.1:${servidor.address().port}`;
      // fetch reutiliza la conexión (keep-alive): el contexto no puede ser el de la conexión.
      const primera = await fetch(`${base}/ping`, { headers: { 'X-Request-Id': 'primera-peticion' } });
      await primera.text();
      const segunda = await fetch(`${base}/ping`);
      await segunda.text();

      expect(primera.headers.get('x-request-id')).toBe('primera-peticion');
      const idSegunda = segunda.headers.get('x-request-id');
      expect(idSegunda).toMatch(UUID);
      expect(idSegunda).not.toBe('primera-peticion');
      const dentro = stdout.lineas().filter((linea) => linea.mensaje === 'dentro');
      expect(dentro.map((linea) => linea.request_id)).toEqual(['primera-peticion', idSegunda]);
    } finally {
      servidor.closeAllConnections();
      await new Promise((resolver) => servidor.close(resolver));
    }
  });
});

describe('cableado en createApp', () => {
  let prueba;
  beforeAll(() => {
    prueba = buildTestApp();
  });
  afterAll(() => prueba.db.destroy());

  it('ruta inexistente → 404 NO_EXISTE con X-Request-Id en la respuesta', async () => {
    const res = await prueba.request.get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.codigo).toBe('NO_EXISTE');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('un X-Request-Id del cliente se devuelve igual en la respuesta', async () => {
    const res = await prueba.request.get('/health').set('X-Request-Id', 'abc-123');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('JSON mal formado → 400 PETICION_MAL_FORMADA (el analizador corre antes que el 404)', async () => {
    const res = await prueba.request.post('/cualquiera').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.codigo).toBe('PETICION_MAL_FORMADA');
  });

  it('cuerpo de más de 100 kb → 413 y charset no soportado → 415, ambos PETICION_MAL_FORMADA', async () => {
    const grande = await prueba.request.post('/cualquiera').set('Content-Type', 'application/json').send(JSON.stringify({ a: 'x'.repeat(150 * 1024) }));
    expect(grande.status).toBe(413);
    expect(grande.body.error.codigo).toBe('PETICION_MAL_FORMADA');
    const charset = await prueba.request.post('/cualquiera').set('Content-Type', 'application/json; charset=iso-8859-1').send('{}');
    expect(charset.status).toBe(415);
    expect(charset.body.error.codigo).toBe('PETICION_MAL_FORMADA');
  });

  it('X-User-Id inválido → 401 NO_AUTENTICADO, y se rechaza antes de leer el cuerpo', async () => {
    const res = await prueba.request
      .post('/cualquiera')
      .set('X-User-Id', 'abc')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(401);
    expect(res.body.error.codigo).toBe('NO_AUTENTICADO');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('GET /health sigue respondiendo con las cabeceras de identidad válidas', async () => {
    const res = await prueba.request.get('/health').set({ 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' });
    expect(res.status).toBe(200);
  });
});
