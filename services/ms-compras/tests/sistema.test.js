const { app, request, pool, reiniciarBase } = require('./apoyo');

beforeAll(reiniciarBase);
afterAll(() => pool.end());

test('/health responde ok con la base de datos y el estado de los cortacircuitos', async () => {
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ estado: 'ok', base_de_datos: 'ok' });
  expect(res.body.cortacircuitos).toHaveProperty('ms-inventario');
});

test('/docs publica la especificación OpenAPI', async () => {
  const spec = await request(app).get('/docs/openapi.json');
  expect(spec.status).toBe(200);
  expect(Object.keys(spec.body.paths)).toEqual(
    expect.arrayContaining(['/ordenes-compra', '/ordenes-compra/{id}/recepciones', '/devoluciones-proveedor']),
  );
  expect((await request(app).get('/docs/')).status).toBe(200);
});

test('devuelve el X-Request-Id que recibe o genera uno nuevo', async () => {
  const propio = await request(app).get('/health').set('X-Request-Id', 'abc-123');
  expect(propio.headers['x-request-id']).toBe('abc-123');
  const nuevo = await request(app).get('/health');
  expect(nuevo.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});

test('migrar dos veces no falla ni repite migraciones', async () => {
  const { migrar } = require('../scripts/migrar');
  await migrar({ silencioso: true });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM migracion');
  expect(rows[0].n).toBe(1);
});

test('si PostgreSQL se apaga o reinicia, el proceso NO muere: el pool atiende el error de una conexión inactiva', () => {
  // Sin un oyente de 'error', Node lanza el evento como excepción y el servicio entero se cae (pasaba con «terminating connection due to
  // administrator command»); Docker lo reinicia en bucle mientras la base no vuelve y el Gateway ve 503 de más.
  expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
});

describe('errores de la base de datos', () => {
  const { manejarErrores } = require('../src/middleware/errores');
  const responder = () => {
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    return res;
  };

  test('el pool lleno responde 503 en vez de colgar o dar 500', () => {
    const res = responder();
    manejarErrores(new Error('timeout exceeded when trying to connect'), { contexto: {} }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0].error.codigo).toBe('SERVICIO_NO_DISPONIBLE');
  });

  test.each([
    ['conexión rechazada', { code: 'ECONNREFUSED' }],
    ['nombre de la base que ya no resuelve', { code: 'ENOTFOUND' }],
    ['DNS sin respuesta', { code: 'EAI_AGAIN' }],
    ['conexión reiniciada', { code: 'ECONNRESET' }],
    ['servidor apagándose', { code: '57P01' }],
    ['demasiadas conexiones', { code: '53300' }],
    ['fallo de conexión de la clase 08', { code: '08006' }],
    ['conexión terminada de golpe', { message: 'Connection terminated unexpectedly' }],
  ])('una base inalcanzable (%s) responde 503 sin mostrar el detalle', (_nombre, datos) => {
    const res = responder();
    manejarErrores(Object.assign(new Error(datos.message ?? 'detalle-interno-secreto'), datos), { contexto: {} }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0].error.codigo).toBe('SERVICIO_NO_DISPONIBLE');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('detalle-interno-secreto');
  });

  test('un error de SQL que no es de conexión sigue siendo 500', () => {
    const res = responder();
    manejarErrores(Object.assign(new Error('la columna x no existe'), { code: '42703' }), { contexto: {} }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('esperar demasiado el candado de una orden responde 409 ORDEN_OCUPADA', () => {
    const res = responder();
    manejarErrores(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }), { contexto: {} }, res, () => {});
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error.codigo).toBe('ORDEN_OCUPADA');
  });
});
