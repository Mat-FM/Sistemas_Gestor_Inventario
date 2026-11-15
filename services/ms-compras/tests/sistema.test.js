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
