const { AppError, e } = require('../src/errors');
const { ejecutarEnPeticion } = require('../src/logger');
const { createCatalogoClient } = require('../src/clients/catalogoClient');
const { createNotificacionesClient } = require('../src/clients/notificacionesClient');
const { headersDe, soloPropagables } = require('../src/clients/propagacion');
const { miniApp } = require('./helpers/miniapp');

// Pruebas de los clientes de ms-catalogo y ms-notificaciones y de la propagación de cabeceras. El cliente HTTP de debajo se
// reemplaza por un doble ({ request }); la integración con el cliente resiliente real y servidores HTTP está en server.test.js.

const fakeHttp = (impl) => ({ request: jest.fn(impl) });
const loggerEspia = () => ({ info: jest.fn(), error: jest.fn() });

/** Exige que la promesa se rechace con un AppError 503 (si se resuelve la prueba falla) y devuelve el error. */
async function esperarNoDisponible(promesa) {
  const error = await promesa.then(
    () => {
      throw new Error('Se esperaba un rechazo y la llamada se resolvió');
    },
    (err) => err,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
  return error;
}

describe('headersDe', () => {
  const identidad = { idUsuario: 7, rol: 'OPERADOR_BODEGA', idBodega: 3, requestId: 'req-identidad' };

  it('arma X-Request-Id, X-User-Id, X-User-Rol y X-User-Bodega, todos como texto', () => {
    expect(headersDe(identidad)).toEqual({
      'X-Request-Id': 'req-identidad',
      'X-User-Id': '7',
      'X-User-Rol': 'OPERADOR_BODEGA',
      'X-User-Bodega': '3',
    });
  });

  it('omite X-User-Bodega cuando es null o undefined (con bodega sí aparece)', () => {
    expect(headersDe(identidad)).toHaveProperty('X-User-Bodega', '3');
    for (const idBodega of [null, undefined]) {
      const cabeceras = headersDe({ ...identidad, idBodega });
      expect(cabeceras).not.toHaveProperty('X-User-Bodega');
      expect(cabeceras).toEqual({ 'X-Request-Id': 'req-identidad', 'X-User-Id': '7', 'X-User-Rol': 'OPERADOR_BODEGA' });
    }
  });

  it('una llamada interna (sin usuario ni rol) solo propaga el X-Request-Id', () => {
    expect(headersDe({ idUsuario: null, rol: null, idBodega: null, requestId: 'req-1' })).toEqual({ 'X-Request-Id': 'req-1' });
  });

  it('el X-Request-Id es el de la petición en curso (el que lleva el registro), aunque la identidad traiga otro', () => {
    const dentro = ejecutarEnPeticion('req-contexto', () => headersDe(identidad));
    expect(dentro['X-Request-Id']).toBe('req-contexto');
    // fuera de toda petición se usa el de la identidad
    expect(headersDe(identidad)['X-Request-Id']).toBe('req-identidad');
  });

  it('sin contexto ni requestId en la identidad no inventa un identificador: omite la cabecera', () => {
    const cabeceras = headersDe({ idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null });
    expect(cabeceras).toEqual({ 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' });
    expect(headersDe(undefined)).toEqual({});
    expect(headersDe(null)).toEqual({});
  });

  it('omite los valores vacíos (un X-User-Id vacío sería un 401 en el servicio destino)', () => {
    expect(headersDe({ idUsuario: 7, rol: '', idBodega: null, requestId: '' })).toEqual({ 'X-User-Id': '7' });
  });

  it('un valor con saltos de línea no llega nunca a una cabecera: lanza TypeError (no se omite en silencio)', () => {
    expect(() => headersDe({ ...identidad, rol: 'ADMINISTRADOR' })).not.toThrow(); // control
    for (const sucio of ['ADMINISTRADOR\r\nX-Inyectada: 1', 'A\nB', 'A\rB']) {
      expect(() => headersDe({ ...identidad, rol: sucio })).toThrow(TypeError);
      expect(() => headersDe({ ...identidad, requestId: sucio })).toThrow(TypeError);
    }
    // el mensaje no cita el valor
    let mensaje = '';
    try {
      headersDe({ ...identidad, rol: 'secreto\r\nX: 1' });
    } catch (err) {
      mensaje = err.message;
    }
    expect(mensaje).not.toContain('secreto');
    expect(mensaje).toContain('X-User-Rol');
    // tampoco dentro de una petición (el X-Request-Id del contexto también se comprueba)
    expect(() => ejecutarEnPeticion('a\r\nb', () => headersDe(identidad))).toThrow(TypeError);
  });

  it('funciona con la forma real de req.identity y usa el request_id de la petición en curso', async () => {
    const { request } = miniApp((app) => app.get('/h', (req, res) => res.json(headersDe(req.identity))), { logger: loggerEspia() });
    const res = await request.get('/h').set({ 'X-User-Id': '9', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': '4', 'X-Request-Id': 'req-real-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'X-Request-Id': 'req-real-1', 'X-User-Id': '9', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': '4' });
    expect(res.headers['x-request-id']).toBe('req-real-1');

    // llamada interna: sin usuario, sin rol y sin bodega; el identificador lo genera el servicio y coincide con el de la respuesta
    const interna = await request.get('/h');
    expect(Object.keys(interna.body)).toEqual(['X-Request-Id']);
    expect(interna.body['X-Request-Id']).toBe(interna.headers['x-request-id']);
  });
});

describe('soloPropagables', () => {
  it('deja pasar solo las cuatro cabeceras de propagación (sin distinguir mayúsculas) y descarta Authorization, Cookie y el resto', () => {
    const entrada = {
      'x-request-id': 'r',
      'X-User-Id': '7',
      'X-USER-ROL': 'ADMINISTRADOR',
      'x-user-bodega': '2',
      Authorization: 'Bearer secreto',
      Cookie: 'sid=1',
      'Idempotency-Key': 'k',
      Host: 'interno',
    };
    expect(soloPropagables(entrada)).toEqual({ 'x-request-id': 'r', 'X-User-Id': '7', 'X-USER-ROL': 'ADMINISTRADOR', 'x-user-bodega': '2' });
  });

  it('con null, undefined o algo que no es un objeto devuelve un objeto vacío', () => {
    for (const valor of [null, undefined, 'texto', 5]) expect(soloPropagables(valor)).toEqual({});
  });
});

describe('createCatalogoClient.obtenerProducto', () => {
  const producto = { id_producto: 5, codigo: 'P5', nombre: 'Producto 5', precio: 10 };
  const cabeceras = { 'X-Request-Id': 'req-1', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' };

  it('pide GET /productos/{id} como lectura reintentable, con las cabeceras de propagación, y devuelve el producto', async () => {
    const http = fakeHttp(async () => ({ status: 200, body: producto }));
    const catalogo = createCatalogoClient(http, loggerEspia());
    expect(await catalogo.obtenerProducto(5, cabeceras)).toEqual(producto);
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledWith('GET', '/productos/5', { headers: cabeceras, reintentable: true });
  });

  it('un 404 significa que el producto no existe: devuelve null', async () => {
    const http = fakeHttp(async () => ({ status: 404, body: { error: { codigo: 'NO_EXISTE' } } }));
    const logger = loggerEspia();
    expect(await createCatalogoClient(http, logger).obtenerProducto(999, cabeceras)).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('no reenvía cabeceras ajenas aunque el llamador las pase (Authorization, Cookie)', async () => {
    const http = fakeHttp(async () => ({ status: 200, body: producto }));
    await createCatalogoClient(http, loggerEspia()).obtenerProducto(5, { ...cabeceras, Authorization: 'Bearer secreto', Cookie: 'sid=1' });
    expect(http.request.mock.calls[0][2].headers).toEqual(cabeceras);
  });

  it('acepta el id máximo de la base y funciona sin cabeceras', async () => {
    const http = fakeHttp(async () => ({ status: 200, body: producto }));
    const catalogo = createCatalogoClient(http, loggerEspia());
    await catalogo.obtenerProducto(2147483647);
    expect(http.request).toHaveBeenCalledWith('GET', '/productos/2147483647', { headers: {}, reintentable: true });
    await catalogo.obtenerProducto(1);
    expect(http.request.mock.calls[1][1]).toBe('/productos/1');
  });

  it.each([
    ['cero', 0],
    ['negativo', -1],
    ['decimal', 1.5],
    ['inyección de ruta', '1/../x'],
    ['inyección con consulta', '1?x=1'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['texto numérico', '5'],
    ['texto', 'abc'],
    ['por encima del INTEGER de la base', 2147483648],
    ['null', null],
    ['undefined', undefined],
    ['objeto', {}],
    ['arreglo', [5]],
    ['BigInt', 5n],
  ])('un id inválido (%s) es un error de programación: TypeError y ninguna llamada', async (_caso, id) => {
    const http = fakeHttp(async () => ({ status: 200, body: producto }));
    const catalogo = createCatalogoClient(http, loggerEspia());
    await expect(catalogo.obtenerProducto(id, cabeceras)).rejects.toThrow(TypeError);
    await expect(catalogo.obtenerProducto(id, cabeceras)).rejects.not.toBeInstanceOf(AppError);
    expect(http.request).not.toHaveBeenCalled();
    // control: el mismo cliente con un id válido sí llama
    await catalogo.obtenerProducto(5, cabeceras);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['400', 400],
    ['401', 401],
    ['403', 403],
    ['409', 409],
    ['422', 422],
    ['429', 429],
  ])('un %s inesperado es un error de integración, no un producto inexistente: 503 registrado y sin devolver null', async (_caso, status) => {
    const http = fakeHttp(async () => ({ status, body: { error: { mensaje: 'detalle-interno-del-catalogo' } } }));
    const logger = loggerEspia();
    const error = await esperarNoDisponible(createCatalogoClient(http, logger).obtenerProducto(5, cabeceras));
    expect(error.message).toBe('El servicio ms-catalogo no está disponible');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]).toEqual([
      { mensaje: 'Respuesta inesperada de ms-catalogo', estado: status, id_producto: 5 },
    ]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('detalle-interno-del-catalogo');
    expect(http.request).toHaveBeenCalledTimes(1); // no se reintenta
  });

  it.each([
    ['200 sin cuerpo (null)', { status: 200, body: null }],
    ['200 con un arreglo', { status: 200, body: [producto] }],
    ['200 con texto', { status: 200, body: 'ok' }],
    ['200 con un número', { status: 200, body: 5 }],
    ['204 sin cuerpo', { status: 204, body: null }],
    ['201 con producto', { status: 201, body: producto }],
  ])('%s no es un producto: 503 registrado, nunca null (null significaría "no existe")', async (_caso, respuesta) => {
    const http = fakeHttp(async () => respuesta);
    const logger = loggerEspia();
    await esperarNoDisponible(createCatalogoClient(http, logger).obtenerProducto(5, cabeceras));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ mensaje: 'Respuesta inesperada de ms-catalogo', estado: respuesta.status });
  });

  it('un AppError 503 del cliente HTTP (red, plazo, 5xx, circuito abierto) se propaga tal cual y sin registrar de más', async () => {
    const http = fakeHttp(async () => {
      throw e.noDisponible('El servicio ms-catalogo no está disponible');
    });
    const logger = loggerEspia();
    const error = await esperarNoDisponible(createCatalogoClient(http, logger).obtenerProducto(5, cabeceras));
    expect(error.message).toBe('El servicio ms-catalogo no está disponible');
    expect(logger.error).not.toHaveBeenCalled(); // el cliente resiliente ya registró el fallo
  });

  it('un error de programación del cliente HTTP también se propaga (no se disfraza de 503)', async () => {
    const http = fakeHttp(async () => {
      throw new TypeError('ruta inválida');
    });
    await expect(createCatalogoClient(http, loggerEspia()).obtenerProducto(5, cabeceras)).rejects.toThrow('ruta inválida');
  });
});

describe('createNotificacionesClient.notificarStockBajo', () => {
  const datos = { idProducto: 12, idBodega: 2, cantidadTotal: 3, cantidadMinima: 10 };
  const cabeceras = { 'X-Request-Id': 'req-77', 'X-User-Id': '7', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': '2' };
  const ACEPTADA = async () => ({ status: 202, body: { aceptada: true } });

  it('envía POST /internas/notificaciones con el cuerpo del contrato, sin reintentos, y resuelve undefined', async () => {
    const http = fakeHttp(ACEPTADA);
    const logger = loggerEspia();
    const resultado = await createNotificacionesClient(http, logger).notificarStockBajo(datos, cabeceras);
    expect(resultado).toBeUndefined();
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledWith('POST', '/internas/notificaciones', {
      headers: cabeceras,
      body: {
        tipo: 'STOCK_BAJO',
        mensaje: 'Stock bajo del producto 12 tras un movimiento en la bodega 2: quedan 3 unidades en total y el mínimo es 10.',
        id_producto: 12,
        id_bodega: 2,
      },
      reintentable: false,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('el mensaje es legible en español: singular con una unidad y 0 unidades cuando no queda nada', async () => {
    const http = fakeHttp(ACEPTADA);
    const notificaciones = createNotificacionesClient(http, loggerEspia());
    await notificaciones.notificarStockBajo({ ...datos, cantidadTotal: 1 }, cabeceras);
    await notificaciones.notificarStockBajo({ ...datos, cantidadTotal: 0 }, cabeceras);
    expect(http.request.mock.calls[0][2].body.mensaje).toBe(
      'Stock bajo del producto 12 tras un movimiento en la bodega 2: queda 1 unidad en total y el mínimo es 10.',
    );
    expect(http.request.mock.calls[1][2].body.mensaje).toBe(
      'Stock bajo del producto 12 tras un movimiento en la bodega 2: quedan 0 unidades en total y el mínimo es 10.',
    );
  });

  it('no reenvía cabeceras ajenas (Authorization, Cookie)', async () => {
    const http = fakeHttp(ACEPTADA);
    await createNotificacionesClient(http, loggerEspia()).notificarStockBajo(datos, { ...cabeceras, Authorization: 'Bearer secreto-9', Cookie: 'sid=1' });
    expect(http.request.mock.calls[0][2].headers).toEqual(cabeceras);
  });

  it('funciona sin cabeceras', async () => {
    const http = fakeHttp(ACEPTADA);
    await createNotificacionesClient(http, loggerEspia()).notificarStockBajo(datos);
    expect(http.request.mock.calls[0][2].headers).toEqual({});
  });

  it.each([
    ['AppError 503 (red, plazo, 5xx o circuito abierto)', () => { throw e.noDisponible('ms-notificaciones no está disponible'); }],
    ['TypeError de programación', () => { throw new TypeError('cabecera inválida'); }],
    ['Error genérico', () => { throw new Error('algo inesperado'); }],
    ['rechazo con un texto', () => Promise.reject('texto suelto')],
    ['rechazo con null', () => Promise.reject(null)],
    ['rechazo con undefined', () => Promise.reject(undefined)],
  ])('NUNCA lanza si el destino falla (%s): registra una vez con campos de texto y resuelve undefined', async (_caso, fallo) => {
    const http = fakeHttp(async () => fallo());
    const logger = loggerEspia();
    await expect(createNotificacionesClient(http, logger).notificarStockBajo(datos, cabeceras)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]).toHaveLength(1);
    const [registro] = logger.error.mock.calls[0];
    expect(registro).toMatchObject({ mensaje: 'No se pudo avisar el stock bajo a ms-notificaciones', id_producto: 12, id_bodega: 2 });
    // un Error crudo saldría como {} en el JSON del registro: se pasa descrito
    expect(JSON.parse(JSON.stringify(registro))).toEqual(registro);
  });

  it('describe el Error con nombre, mensaje y pila (no el objeto Error crudo)', async () => {
    const http = fakeHttp(async () => {
      throw e.noDisponible('ms-notificaciones no está disponible');
    });
    const logger = loggerEspia();
    await createNotificacionesClient(http, logger).notificarStockBajo(datos, cabeceras);
    expect(logger.error.mock.calls[0][0].error).toEqual({
      nombre: 'AppError',
      mensaje: 'ms-notificaciones no está disponible',
      pila: expect.stringContaining('AppError'),
    });
  });

  it.each([
    ['422', 422],
    ['400', 400],
    ['404', 404],
    ['500 (un doble del cliente HTTP lo devolvería sin convertirlo)', 500],
  ])('un %s devuelto por el destino no lanza, pero es un aviso fallido y se registra con su estado', async (_caso, status) => {
    const http = fakeHttp(async () => ({ status, body: { error: { detalles: 'cuerpo-de-respuesta-secreto' } } }));
    const logger = loggerEspia();
    await expect(createNotificacionesClient(http, logger).notificarStockBajo(datos, cabeceras)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toEqual({
      mensaje: 'No se pudo avisar el stock bajo a ms-notificaciones',
      id_producto: 12,
      id_bodega: 2,
      estado: status,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('cuerpo-de-respuesta-secreto');
  });

  it('cualquier 2xx cuenta como aviso entregado (el contrato dice 202)', async () => {
    for (const status of [200, 201, 202, 204]) {
      const http = fakeHttp(async () => ({ status, body: null }));
      const logger = loggerEspia();
      await createNotificacionesClient(http, logger).notificarStockBajo(datos, cabeceras);
      expect(logger.error).not.toHaveBeenCalled();
    }
  });

  it('no lanza aunque el cliente HTTP lance de forma síncrona, ni aunque devuelva algo que no es una respuesta', async () => {
    const sincrono = { request: jest.fn(() => { throw new Error('síncrono'); }) };
    const logger = loggerEspia();
    await expect(createNotificacionesClient(sincrono, logger).notificarStockBajo(datos, cabeceras)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);

    for (const raro of [undefined, null, 'x']) {
      const logger2 = loggerEspia();
      const http = fakeHttp(async () => raro);
      await expect(createNotificacionesClient(http, logger2).notificarStockBajo(datos, cabeceras)).resolves.toBeUndefined();
      expect(logger2.error).toHaveBeenCalledTimes(1);
    }
  });

  it('no lanza con datos o cabeceras inválidos: lo registra y no llama al destino', async () => {
    const venenosas = new Proxy({}, { ownKeys() { throw new Error('cabeceras venenosas'); } });
    const casos = [
      [null, cabeceras],
      [undefined, cabeceras],
      [{ idProducto: 12 }, cabeceras],
      [{ ...datos, cantidadTotal: 'tres' }, cabeceras],
      [{ ...datos, idBodega: 1.5 }, cabeceras],
      [datos, venenosas],
    ];
    for (const [entrada, headers] of casos) {
      const http = fakeHttp(ACEPTADA);
      const logger = loggerEspia();
      await expect(createNotificacionesClient(http, logger).notificarStockBajo(entrada, headers)).resolves.toBeUndefined();
      expect(http.request).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    }
  });

  it('un logger que lanza tampoco hace que notificarStockBajo lance', async () => {
    const http = fakeHttp(async () => {
      throw new Error('destino caído');
    });
    const logger = { info: jest.fn(), error: jest.fn(() => { throw new Error('logger roto'); }) };
    await expect(createNotificacionesClient(http, logger).notificarStockBajo(datos, cabeceras)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('nunca registra las cabeceras ni el cuerpo enviado', async () => {
    const http = fakeHttp(async () => {
      throw new Error('destino caído');
    });
    const logger = loggerEspia();
    await createNotificacionesClient(http, logger).notificarStockBajo(datos, { ...cabeceras, Authorization: 'Bearer secreto-9' });
    const volcado = JSON.stringify(logger.error.mock.calls);
    for (const prohibido of ['secreto-9', 'req-77', 'OPERADOR_BODEGA', 'Stock bajo del producto']) expect(volcado).not.toContain(prohibido);
  });
});
