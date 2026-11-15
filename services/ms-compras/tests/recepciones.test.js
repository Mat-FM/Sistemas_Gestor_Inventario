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

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await reiniciarBase();
  await levantarSimulador();
});
afterAll(async () => {
  await detenerSimulador();
  await pool.end();
});
beforeEach(cerrarCortacircuito);

const recibir = (id, lineas, clave, cabeceras = ADMIN) =>
  request(app).post(`/ordenes-compra/${id}/recepciones`).set(cabeceras).set('Idempotency-Key', clave).send({ lineas });

describe('Recepción de mercancía (RF06)', () => {
  test('una recepción parcial deja la orden RECIBIDA_PARCIAL y registra el movimiento en inventario', async () => {
    const orden = await crearOrdenEnviada();
    const [linea1] = orden.detalles;
    const res = await recibir(orden.id_orden, [{ id_detalle: linea1.id_detalle, cantidad: 4, codigo_lote: 'L-1', fecha_vencimiento: '2027-01-31' }], 'r-1');
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('RECIBIDA_PARCIAL');
    expect(res.body.recepciones[0]).toMatchObject({ cantidad: 4, codigo_lote: 'L-1', fecha_vencimiento: '2027-01-31' });
    expect(simulador().saldos.get('25:1')).toBe(4);

    await esperar(50);
    expect(simulador().avisos.at(-1)).toMatchObject({ tipo: 'ORDEN_RECIBIDA', id_bodega: 1 });
  });

  test('repetir la petición con la misma clave no duplica la recepción (RNF17)', async () => {
    const orden = await crearOrdenEnviada();
    const lineas = [{ id_detalle: orden.detalles[0].id_detalle, cantidad: 3 }];
    const primera = await recibir(orden.id_orden, lineas, 'r-dup');
    const segunda = await recibir(orden.id_orden, lineas, 'r-dup');
    expect(segunda.status).toBe(201);
    expect(segunda.body).toEqual(primera.body);

    const detalle = await request(app).get(`/ordenes-compra/${orden.id_orden}`);
    expect(detalle.body.detalles[0].cantidad_recibida).toBe(3);
  });

  test('al recibir todo, la orden pasa a RECIBIDA y ya no acepta más', async () => {
    const orden = await crearOrdenEnviada();
    const lineas = orden.detalles.map((d) => ({ id_detalle: d.id_detalle, cantidad: d.cantidad_pedida }));
    const res = await recibir(orden.id_orden, lineas, 'r-total');
    expect(res.body.estado).toBe('RECIBIDA');

    const otra = await recibir(orden.id_orden, [lineas[0]], 'r-total-2');
    expect(otra.status).toBe(409);
    expect(otra.body.error.codigo).toBe('ESTADO_NO_RECIBIBLE');

    const listado = await request(app).get(`/ordenes-compra/${orden.id_orden}/recepciones`);
    expect(listado.body.datos).toHaveLength(2);
  });

  test('no deja recibir más de lo pendiente, líneas ajenas ni líneas repetidas (422)', async () => {
    const orden = await crearOrdenEnviada();
    const id = orden.detalles[0].id_detalle;
    expect((await recibir(orden.id_orden, [{ id_detalle: id, cantidad: 11 }], 'v-1')).status).toBe(422);
    expect((await recibir(orden.id_orden, [{ id_detalle: 9999, cantidad: 1 }], 'v-2')).status).toBe(422);
    expect((await recibir(orden.id_orden, [{ id_detalle: id, cantidad: 1 }, { id_detalle: id, cantidad: 1 }], 'v-3')).status).toBe(422);
    expect((await recibir(orden.id_orden, [{ id_detalle: id, cantidad: 1, codigo_lote: 'L-9' }], 'v-4')).status).toBe(422);
    expect((await recibir(orden.id_orden, [], 'v-5')).status).toBe(422);
  });

  test('exige Idempotency-Key (400) y responde 404 si la orden no existe', async () => {
    const sinClave = await request(app).post('/ordenes-compra/1/recepciones').set(ADMIN).send({ lineas: [{ id_detalle: 1, cantidad: 1 }] });
    expect(sinClave.status).toBe(400);
    expect((await recibir(999, [{ id_detalle: 1, cantidad: 1 }], 'x')).status).toBe(404);
  });

  test('el operador de bodega solo recibe en su bodega (403 BODEGA_AJENA)', async () => {
    const orden = await crearOrdenEnviada();
    const lineas = [{ id_detalle: orden.detalles[0].id_detalle, cantidad: 1 }];
    const ajena = await recibir(orden.id_orden, lineas, 'b-1', operador(2));
    expect(ajena.status).toBe(403);
    expect(ajena.body.error.codigo).toBe('BODEGA_AJENA');

    const propia = await recibir(orden.id_orden, lineas, 'b-2', operador(1));
    expect(propia.status).toBe(201);

    const sinBodega = await recibir(orden.id_orden, lineas, 'b-3', { 'X-User-Id': '7', 'X-User-Rol': 'OPERADOR_BODEGA' });
    expect(sinBodega.status).toBe(403);
  });

  test('si inventario no responde: 503, nada queda guardado y el reintento con la misma clave completa', async () => {
    const orden = await crearOrdenEnviada();
    const lineas = [{ id_detalle: orden.detalles[1].id_detalle, cantidad: 2 }];
    await detenerSimulador();

    const caida = await recibir(orden.id_orden, lineas, 'caida-1');
    expect(caida.status).toBe(503);
    expect(caida.body.error.codigo).toBe('SERVICIO_NO_DISPONIBLE');
    const sinCambios = await request(app).get(`/ordenes-compra/${orden.id_orden}`);
    expect(sinCambios.body.estado).toBe('ENVIADA');
    expect(sinCambios.body.recepciones).toHaveLength(0);

    await levantarSimulador();
    cerrarCortacircuito();
    const reintento = await recibir(orden.id_orden, lineas, 'caida-1');
    expect(reintento.status).toBe(201);
    expect(reintento.body.estado).toBe('RECIBIDA_PARCIAL');
  });

  test('si una línea falla, las demás se registran y el reintento completa solo las faltantes', async () => {
    const orden = await crearOrdenEnviada();
    const [a, b] = orden.detalles;
    const lineas = [
      { id_detalle: a.id_detalle, cantidad: 1 },
      { id_detalle: b.id_detalle, cantidad: 1 },
    ];
    // El simulador rechaza la segunda línea una sola vez con 409.
    const original = simulador().servidor.listeners('request')[0];
    let rechazada = false;
    simulador().servidor.removeAllListeners('request');
    simulador().servidor.on('request', (req, res) => {
      if (!rechazada && req.headers['idempotency-key']?.endsWith(`:${b.id_detalle}`)) {
        rechazada = true;
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { codigo: 'BODEGA_INACTIVA', mensaje: 'Bodega inactiva', detalles: [] } }));
      }
      return original(req, res);
    });

    const parcial = await recibir(orden.id_orden, lineas, 'mix-1');
    expect(parcial.status).toBe(409);
    expect(parcial.body.error.detalles).toEqual([expect.objectContaining({ id_detalle: b.id_detalle, codigo: 'BODEGA_INACTIVA' })]);

    const reintento = await recibir(orden.id_orden, lineas, 'mix-1');
    expect(reintento.status).toBe(201);
    expect(reintento.body.recepciones).toHaveLength(2);
    const final = await request(app).get(`/ordenes-compra/${orden.id_orden}`);
    expect(final.body.detalles.map((d) => d.cantidad_recibida)).toEqual([1, 1]);
  });

  test('dos recepciones simultáneas no superan la cantidad pendiente', async () => {
    const orden = await crearOrdenEnviada();
    const lineas = [{ id_detalle: orden.detalles[0].id_detalle, cantidad: 6 }]; // pendiente: 10
    const [a, b] = await Promise.all([recibir(orden.id_orden, lineas, 'con-a'), recibir(orden.id_orden, lineas, 'con-b')]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const final = await request(app).get(`/ordenes-compra/${orden.id_orden}`);
    expect(final.body.detalles[0].cantidad_recibida).toBe(6);
  });

  test('una orden ENVIADA con recepciones ya no se puede anular', async () => {
    const orden = await crearOrdenEnviada();
    await recibir(orden.id_orden, [{ id_detalle: orden.detalles[0].id_detalle, cantidad: 1 }], 'an-1');
    // Queda RECIBIDA_PARCIAL: anular ya no está permitido.
    const res = await request(app).patch(`/ordenes-compra/${orden.id_orden}/estado`).set(ADMIN).send({ estado: 'ANULADA' });
    expect(res.status).toBe(409);
  });
});
