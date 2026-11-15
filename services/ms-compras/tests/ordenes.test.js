const { app, request, pool, ADMIN, ordenBase, reiniciarBase } = require('./apoyo');

beforeAll(reiniciarBase);
afterAll(() => pool.end());

describe('Órdenes de compra (RF06)', () => {
  test('crea una orden CREADA con número consecutivo y total calculado', async () => {
    const res = await request(app).post('/ordenes-compra').set(ADMIN).send(ordenBase);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ numero: 'OC-0001', estado: 'CREADA', total: 206000, id_usuario: 1 });
    expect(res.body.detalles).toHaveLength(2);
    expect(res.body.detalles[0]).toMatchObject({ cantidad_pedida: 10, cantidad_recibida: 0, subtotal: 185000 });

    const segunda = await request(app).post('/ordenes-compra').set(ADMIN).send(ordenBase);
    expect(segunda.body.numero).toBe('OC-0002');
  });

  test('rechaza una orden sin líneas o con un producto repetido (422)', async () => {
    const sinLineas = await request(app).post('/ordenes-compra').set(ADMIN).send({ ...ordenBase, detalles: [] });
    expect(sinLineas.status).toBe(422);
    expect(sinLineas.body.error.codigo).toBe('DATOS_INVALIDOS');

    const repetido = await request(app)
      .post('/ordenes-compra')
      .set(ADMIN)
      .send({ ...ordenBase, detalles: [ordenBase.detalles[0], ordenBase.detalles[0]] });
    expect(repetido.status).toBe(422);
    expect(repetido.body.error.detalles[0].mensaje).toMatch(/repetido/);
  });

  test('valida tipos y fechas de cada campo', async () => {
    const res = await request(app)
      .post('/ordenes-compra')
      .set(ADMIN)
      .send({ id_proveedor: 'tres', id_bodega_destino: 1, fecha_esperada: '2026-02-30', detalles: [{ id_producto: 1, cantidad_pedida: 0, precio_unitario: -1 }] });
    expect(res.status).toBe(422);
    const campos = res.body.error.detalles.map((d) => d.campo);
    expect(campos).toEqual(
      expect.arrayContaining(['id_proveedor', 'fecha_esperada', 'detalles[0].cantidad_pedida', 'detalles[0].precio_unitario']),
    );
  });

  test('exige la identidad del usuario para crear (401)', async () => {
    const res = await request(app).post('/ordenes-compra').send(ordenBase);
    expect(res.status).toBe(401);
  });

  test('consulta una orden y responde 404 si no existe', async () => {
    const ok = await request(app).get('/ordenes-compra/1');
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('recepciones');
    expect((await request(app).get('/ordenes-compra/999')).status).toBe(404);
    expect((await request(app).get('/ordenes-compra/abc')).status).toBe(404);
  });

  test('edita solo en estado CREADA (409 ESTADO_NO_EDITABLE)', async () => {
    const editada = await request(app)
      .put('/ordenes-compra/2')
      .set(ADMIN)
      .send({ ...ordenBase, detalles: [{ id_producto: 30, cantidad_pedida: 2, precio_unitario: 1000 }] });
    expect(editada.status).toBe(200);
    expect(editada.body.total).toBe(2000);
    expect(editada.body.detalles).toHaveLength(1);

    await request(app).patch('/ordenes-compra/2/estado').set(ADMIN).send({ estado: 'ENVIADA' });
    const bloqueada = await request(app).put('/ordenes-compra/2').set(ADMIN).send(ordenBase);
    expect(bloqueada.status).toBe(409);
    expect(bloqueada.body.error.codigo).toBe('ESTADO_NO_EDITABLE');
  });

  test('aplica las transiciones de estado permitidas', async () => {
    const invalido = await request(app).patch('/ordenes-compra/1/estado').set(ADMIN).send({ estado: 'RECIBIDA' });
    expect(invalido.status).toBe(422);

    const anulada = await request(app).patch('/ordenes-compra/1/estado').set(ADMIN).send({ estado: 'ANULADA' });
    expect(anulada.body.estado).toBe('ANULADA');

    const desdeFinal = await request(app).patch('/ordenes-compra/1/estado').set(ADMIN).send({ estado: 'ENVIADA' });
    expect(desdeFinal.status).toBe(409);
    expect(desdeFinal.body.error.codigo).toBe('TRANSICION_INVALIDA');
  });

  test('lista con filtros y paginación', async () => {
    const todas = await request(app).get('/ordenes-compra?por_pagina=1');
    expect(todas.status).toBe(200);
    expect(todas.body.meta).toEqual({ pagina: 1, por_pagina: 1, total: 2 });
    expect(todas.body.datos).toHaveLength(1);

    const enviadas = await request(app).get('/ordenes-compra?estado=ENVIADA');
    expect(enviadas.body.datos.map((o) => o.numero)).toEqual(['OC-0002']);

    const hoy = new Date().toISOString().slice(0, 10);
    const porFecha = await request(app).get(`/ordenes-compra?fecha_desde=${hoy}&fecha_hasta=${hoy}&id_proveedor=3`);
    expect(porFecha.body.meta.total).toBe(2);

    const malos = await request(app).get('/ordenes-compra?estado=X&por_pagina=500&fecha_desde=ayer');
    expect(malos.status).toBe(422);
  });

  test('responde con el formato común de error en rutas inexistentes y JSON mal formado', async () => {
    const ruta = await request(app).get('/no-existe');
    expect(ruta.status).toBe(404);
    expect(ruta.body.error.codigo).toBe('RUTA_NO_ENCONTRADA');

    const json = await request(app).post('/ordenes-compra').set(ADMIN).set('Content-Type', 'application/json').send('{malo');
    expect(json.status).toBe(400);
  });
});
