const {
  app,
  request,
  pool,
  ADMIN,
  operador,
  reiniciarBase,
  levantarSimulador,
  detenerSimulador,
  cerrarCortacircuito,
  crearOrdenEnviada,
  simulador,
} = require('./apoyo');

beforeAll(async () => {
  await reiniciarBase();
  await levantarSimulador();
  simulador().saldos.set('25:1', 20);
});
afterAll(async () => {
  await detenerSimulador();
  await pool.end();
});
beforeEach(cerrarCortacircuito);

const devolucion = { id_proveedor: 3, id_producto: 25, id_bodega: 1, cantidad: 2, motivo: 'Producto con empaque roto' };
const devolver = (cuerpo, clave, cabeceras = ADMIN) =>
  request(app).post('/devoluciones-proveedor').set(cabeceras).set('Idempotency-Key', clave).send(cuerpo);

describe('Devoluciones a proveedor (RF13)', () => {
  test('registra la devolución y su movimiento DEVOLUCION_PROVEEDOR', async () => {
    const res = await devolver(devolucion, 'd-1');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id_proveedor: 3, cantidad: 2, id_orden: null });
    expect(res.body.id_movimiento).toEqual(expect.any(Number));
    expect(simulador().saldos.get('25:1')).toBe(18);
  });

  test('la misma clave no duplica la devolución (RNF17)', async () => {
    const primera = await devolver(devolucion, 'd-dup');
    const segunda = await devolver(devolucion, 'd-dup');
    expect(segunda.body.id_devolucion).toBe(primera.body.id_devolucion);
    expect(simulador().saldos.get('25:1')).toBe(16);
  });

  test('propaga STOCK_INSUFICIENTE de inventario (409)', async () => {
    const res = await devolver({ ...devolucion, cantidad: 500 }, 'd-stock');
    expect(res.status).toBe(409);
    expect(res.body.error.codigo).toBe('STOCK_INSUFICIENTE');
  });

  test('puede ligarse a una orden del mismo proveedor', async () => {
    const orden = await crearOrdenEnviada();
    const ok = await devolver({ ...devolucion, id_orden: orden.id_orden }, 'd-orden');
    expect(ok.status).toBe(201);
    expect(ok.body.id_orden).toBe(orden.id_orden);

    expect((await devolver({ ...devolucion, id_orden: orden.id_orden, id_proveedor: 99 }, 'd-otro')).status).toBe(422);
    expect((await devolver({ ...devolucion, id_orden: 9999 }, 'd-404')).status).toBe(404);
  });

  test('valida los datos y la bodega del operador', async () => {
    expect((await devolver({ ...devolucion, motivo: '' }, 'd-val')).status).toBe(422);
    const ajena = await devolver(devolucion, 'd-ajena', operador(2));
    expect(ajena.status).toBe(403);
    expect((await request(app).post('/devoluciones-proveedor').set(ADMIN).send(devolucion)).status).toBe(400);
  });

  test('responde 503 si inventario no responde', async () => {
    await detenerSimulador();
    const res = await devolver(devolucion, 'd-caida');
    expect(res.status).toBe(503);
    await levantarSimulador();
  });

  test('lista con filtros y paginación', async () => {
    const res = await request(app).get('/devoluciones-proveedor?id_proveedor=3&por_pagina=2');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 2, total: 3 });
    expect(res.body.datos).toHaveLength(2);
    const hoy = new Date().toISOString().slice(0, 10);
    expect((await request(app).get(`/devoluciones-proveedor?fecha_desde=${hoy}&fecha_hasta=${hoy}`)).body.meta.total).toBe(3);
    expect((await request(app).get('/devoluciones-proveedor?id_proveedor=-1')).status).toBe(422);
  });
});
