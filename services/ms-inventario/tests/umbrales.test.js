const supertest = require('supertest');
const { createApp } = require('../src/app');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, crearUmbral, fakeCatalogo, headers } = require('./helpers/fixtures');
const { ISO_8601, datosNoValidos, esError, recursoNoExiste, rutaNoExiste } = require('./helpers/respuestas');

// Umbrales de stock mínimo (RF09): GET /umbrales y PUT /umbrales/{id_producto} de la Tabla 9 de la Entrega 2, contra
// PostgreSQL real. Las pruebas de cada capa por separado están en umbralesCapas.test.js y la lista de rutas en routes.test.js.

const ADM = headers('ADMINISTRADOR');
const CLAVES = ['id_producto', 'cantidad_minima', 'fecha_actualizacion'];

let request;
let db;
let clients;
// Segunda aplicación con el catálogo caído: ms-catalogo no responde (503).
let requestCaido;
let dbCaido;
let catalogoCaido;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp());
  ({ request: requestCaido, db: dbCaido, clients: { catalogo: catalogoCaido } } = buildTestApp({ clients: { catalogo: fakeCatalogo({ caido: true }) } }));
});
beforeEach(async () => {
  await truncateAll(db);
  clients.catalogo.obtenerProducto.mockClear();
  catalogoCaido.obtenerProducto.mockClear();
});
afterAll(() => Promise.all([db.destroy(), dbCaido.destroy()]));

const filas = () => db('umbrales_producto').select('*').orderBy('id_producto');
const catalogoSinLlamadas = () => expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();

// PUT /umbrales/{id} con el cuerpo dado y las cabeceras del administrador.
const guardar = (id, cuerpo, cabeceras = ADM) => request.put(`/umbrales/${id}`).set(cabeceras).send(cuerpo);

// Control positivo antes de un rechazo: un PUT válido que debe dar 200. Después limpia las llamadas al catálogo.
async function control(id = 5, cantidadMinima = 1) {
  const res = await guardar(id, { cantidad_minima: cantidadMinima });
  expect(res.status).toBe(200);
  clients.catalogo.obtenerProducto.mockClear();
  return res.body;
}

describe('GET /umbrales', () => {
  it('lista los umbrales con el envoltorio paginado y exactamente sus tres campos, ordenados por id_producto', async () => {
    // Insertados en desorden: el orden de la respuesta es por id_producto, no por inserción.
    await crearUmbral(db, { idProducto: 9, cantidadMinima: 1 });
    await crearUmbral(db, { idProducto: 3, cantidadMinima: 30 });
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 0 });
    const res = await request.get('/umbrales').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
    expect(res.body.datos.map((umbral) => umbral.id_producto)).toEqual([3, 5, 9]);
    expect(res.body.datos.map((umbral) => umbral.cantidad_minima)).toEqual([30, 0, 1]);
    for (const umbral of res.body.datos) expect(Object.keys(umbral).sort()).toEqual([...CLAVES].sort());
    expect(res.body.datos[0]).toEqual({ id_producto: 3, cantidad_minima: 30, fecha_actualizacion: expect.stringMatching(ISO_8601) });
  });

  it('los tipos son los del contrato: id y cantidad como NÚMEROS y la fecha como texto ISO 8601', async () => {
    const guardado = await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    const [umbral] = (await request.get('/umbrales').set(ADM)).body.datos;
    expect(typeof umbral.id_producto).toBe('number');
    expect(typeof umbral.cantidad_minima).toBe('number');
    expect(umbral.fecha_actualizacion).toBe(guardado.fecha_actualizacion.toISOString());
  });

  it('sin umbrales → {datos: [], meta: {pagina: 1, por_pagina: 20, total: 0}} con total numérico', async () => {
    const res = await request.get('/umbrales').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
  });

  describe('?id_producto', () => {
    beforeEach(async () => {
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
      await crearUmbral(db, { idProducto: 6, cantidadMinima: 20 });
    });

    it('filtra por producto: un solo umbral y meta.total = 1', async () => {
      const res = await request.get('/umbrales').query({ id_producto: 6 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 1 });
      expect(res.body.datos).toEqual([{ id_producto: 6, cantidad_minima: 20, fecha_actualizacion: expect.stringMatching(ISO_8601) }]);
    });

    it('un producto sin umbral (o que no existe) → 200 con lista vacía y total 0 (no 404); no se llama al catálogo', async () => {
      const res = await request.get('/umbrales').query({ id_producto: 999 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
      catalogoSinLlamadas();
    });

    it.each([
      ['abc', ['id_producto']],
      ['0', ['id_producto']],
      ['-1', ['id_producto']],
      ['1.5', ['id_producto']],
      ['', ['id_producto']],
      ['2147483648', ['id_producto']],
    ])('?id_producto=%p → 422 sobre "id_producto" (nunca un 500)', async (valor, campos) => {
      expect((await request.get('/umbrales').query({ id_producto: 5 }).set(ADM)).status).toBe(200); // control
      datosNoValidos(await request.get('/umbrales').query({ id_producto: valor }).set(ADM), campos);
    });

    it('?id_producto repetido (arreglo) → 422 sobre "id_producto"', async () => {
      datosNoValidos(await request.get('/umbrales?id_producto=5&id_producto=6').set(ADM), ['id_producto']);
    });

    it('informa a la vez id_producto, pagina y por_pagina inválidos', async () => {
      datosNoValidos(await request.get('/umbrales').query({ id_producto: 'x', pagina: '0', por_pagina: '500' }).set(ADM), ['id_producto', 'pagina', 'por_pagina']);
    });

    it('el id más alto que cabe en el INTEGER (2147483647) se acepta y devuelve una lista vacía', async () => {
      const res = await request.get('/umbrales').query({ id_producto: '2147483647' }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 0 });
    });
  });

  describe('paginación (el mismo contrato que /saldos y /bodegas: total exacto y orden estable)', () => {
    async function recorrer(query, porPagina) {
      const paginas = [];
      for (let pagina = 1; pagina <= 20; pagina += 1) {
        const res = await request.get('/umbrales').query({ ...query, pagina, por_pagina: porPagina }).set(ADM);
        expect(res.status).toBe(200);
        paginas.push(res.body);
        if (pagina * porPagina >= res.body.meta.total) return paginas;
      }
      throw new Error('El recorrido no termina: meta.total nunca alcanzó pagina * por_pagina');
    }

    beforeEach(async () => {
      for (const idProducto of [4, 2, 5, 1, 3]) await crearUmbral(db, { idProducto, cantidadMinima: idProducto * 10 });
    });

    it('con por_pagina pequeño la unión de las páginas es exactamente lo sembrado, sin repetidos ni saltos y en orden', async () => {
      const paginas = await recorrer({}, 2);
      expect(paginas.map((pagina) => pagina.datos.length)).toEqual([2, 2, 1]);
      const productos = paginas.flatMap((pagina) => pagina.datos.map((umbral) => umbral.id_producto));
      expect(productos).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(productos).size).toBe(5);
      for (const pagina of paginas) {
        expect(pagina.meta.total).toBe(5);
        expect(typeof pagina.meta.total).toBe('number');
      }
    });

    it('meta devuelve la página y el por_pagina pedidos, y la página siguiente empieza donde terminó la anterior', async () => {
      const res = await request.get('/umbrales').query({ pagina: 2, por_pagina: 2 }).set(ADM);
      expect(res.body.meta).toEqual({ pagina: 2, por_pagina: 2, total: 5 });
      expect(res.body.datos.map((umbral) => umbral.id_producto)).toEqual([3, 4]);
    });

    it('con id_producto el recorrido cubre solo ese producto y meta.total es el del filtro', async () => {
      const paginas = await recorrer({ id_producto: 3 }, 1);
      expect(paginas).toHaveLength(1);
      expect(paginas[0].meta).toEqual({ pagina: 1, por_pagina: 1, total: 1 });
      expect(paginas[0].datos.map((umbral) => umbral.id_producto)).toEqual([3]);
    });

    it('una página fuera de rango → 200 con datos vacíos y el total exacto (no 0)', async () => {
      const res = await request.get('/umbrales').query({ pagina: 99, por_pagina: 2 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ datos: [], meta: { pagina: 99, por_pagina: 2, total: 5 } });
    });

    it.each([
      ['por_pagina=0', { por_pagina: '0' }, ['por_pagina']],
      ['por_pagina=101', { por_pagina: '101' }, ['por_pagina']],
      ['pagina=0', { pagina: '0' }, ['pagina']],
      ['pagina=abc', { pagina: 'abc' }, ['pagina']],
    ])('%s → 422', async (_descripcion, query, campos) => {
      expect((await request.get('/umbrales').query({ por_pagina: '100' }).set(ADM)).status).toBe(200); // control
      datosNoValidos(await request.get('/umbrales').query(query).set(ADM), campos);
    });
  });

  describe('lecturas sin X-User-Id (llamadas internas válidas, D8)', () => {
    it('GET /umbrales sin cabeceras de identidad → 200; con una cabecera de identidad inválida, 401', async () => {
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
      const res = await request.get('/umbrales');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      esError(await request.get('/umbrales').set({ 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
    });
  });
});

describe('PUT /umbrales/:id_producto', () => {
  it('crea el umbral → 200 (no 201) con exactamente sus tres campos; queda guardado', async () => {
    const res = await guardar(5, { cantidad_minima: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_producto: 5, cantidad_minima: 10, fecha_actualizacion: expect.stringMatching(ISO_8601) });
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES].sort());
    for (const campo of ['id_producto', 'cantidad_minima']) expect(typeof res.body[campo]).toBe('number');
    const guardadas = await filas();
    expect(guardadas).toEqual([{ id_producto: 5, cantidad_minima: 10, fecha_actualizacion: new Date(res.body.fecha_actualizacion) }]);
  });

  it('un segundo PUT del mismo producto actualiza la MISMA fila (200) y cambia fecha_actualizacion', async () => {
    const primero = await guardar(5, { cantidad_minima: 10 });
    expect(primero.status).toBe(200);
    // Se retrasa la fila una hora: así la comparación no depende de que pase un milisegundo entre los dos PUT.
    await db('umbrales_producto').where({ id_producto: 5 }).update({ fecha_actualizacion: db.raw("now() - interval '1 hour'") });
    const [retrasada] = await filas();
    expect(retrasada.fecha_actualizacion.getTime()).toBeLessThan(new Date(primero.body.fecha_actualizacion).getTime());

    const segundo = await guardar(5, { cantidad_minima: 25 });
    expect(segundo.status).toBe(200);
    expect(segundo.body).toEqual({ id_producto: 5, cantidad_minima: 25, fecha_actualizacion: expect.stringMatching(ISO_8601) });
    expect(new Date(segundo.body.fecha_actualizacion).getTime()).toBeGreaterThan(retrasada.fecha_actualizacion.getTime());
    expect(new Date(segundo.body.fecha_actualizacion).getTime()).toBeGreaterThanOrEqual(new Date(primero.body.fecha_actualizacion).getTime());
    expect(await filas()).toEqual([{ id_producto: 5, cantidad_minima: 25, fecha_actualizacion: new Date(segundo.body.fecha_actualizacion) }]);
  });

  it('repetir el mismo valor sigue siendo 200 y también refresca fecha_actualizacion', async () => {
    await guardar(5, { cantidad_minima: 10 });
    await db('umbrales_producto').where({ id_producto: 5 }).update({ fecha_actualizacion: db.raw("now() - interval '1 hour'") });
    const [retrasada] = await filas();
    const res = await guardar(5, { cantidad_minima: 10 });
    expect(res.status).toBe(200);
    expect(res.body.cantidad_minima).toBe(10);
    expect(new Date(res.body.fecha_actualizacion).getTime()).toBeGreaterThan(retrasada.fecha_actualizacion.getTime());
    expect(await filas()).toHaveLength(1);
  });

  it('solo cambia el producto de la ruta: el umbral de otro producto queda intacto', async () => {
    const otro = await crearUmbral(db, { idProducto: 6, cantidadMinima: 20 });
    await guardar(5, { cantidad_minima: 10 });
    await guardar(5, { cantidad_minima: 11 });
    expect(await filas()).toEqual([expect.objectContaining({ id_producto: 5, cantidad_minima: 11 }), otro]);
  });

  it('descarta lo que el cliente no puede fijar: el id_producto y la fecha del cuerpo no se aplican', async () => {
    const res = await guardar(5, { cantidad_minima: 10, id_producto: 99, fecha_actualizacion: '2000-01-01T00:00:00.000Z', otro: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.id_producto).toBe(5);
    expect(res.body).not.toHaveProperty('otro');
    expect(new Date(res.body.fecha_actualizacion).getFullYear()).toBeGreaterThan(2000);
    expect((await filas()).map((fila) => fila.id_producto)).toEqual([5]);
  });

  it('confirma el producto en el catálogo con GET /productos/{id}: una llamada, con el id y las cabeceras de propagación', async () => {
    const res = await request.put('/umbrales/5').set(ADM).set('X-Request-Id', 'prueba-put-1').send({ cantidad_minima: 10 });
    expect(res.status).toBe(200);
    expect(clients.catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
    expect(clients.catalogo.obtenerProducto).toHaveBeenCalledWith(5, { 'X-Request-Id': 'prueba-put-1', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' });
  });

  it('no mantiene una conexión de la base tomada mientras espera a ms-catalogo (ni transacción abierta)', async () => {
    let tomadasDuranteLaLlamada;
    clients.catalogo.obtenerProducto.mockImplementationOnce(async (idProducto) => {
      tomadasDuranteLaLlamada = db.client.pool.numUsed();
      return { id_producto: idProducto, codigo: `P${idProducto}`, nombre: `Producto ${idProducto}` };
    });
    expect((await guardar(5, { cantidad_minima: 10 })).status).toBe(200);
    expect(tomadasDuranteLaLlamada).toBe(0);
  });

  it('un umbral creado aquí lo ve GET /umbrales y, sin saldos, aparece en GET /saldos/bajo-umbral con total 0', async () => {
    await guardar(5, { cantidad_minima: 10 });
    expect((await request.get('/umbrales').query({ id_producto: 5 }).set(ADM)).body.datos[0]).toMatchObject({ id_producto: 5, cantidad_minima: 10 });
    expect((await request.get('/saldos/bajo-umbral')).body).toEqual([{ id_producto: 5, cantidad_total: 0, cantidad_minima: 10 }]);
    const { id_bodega: idBodega } = await crearBodega(db, { codigo: 'B1' });
    await crearSaldo(db, { idProducto: 5, idBodega, cantidad: 10 });
    expect((await request.get('/saldos/bajo-umbral')).body).toEqual([]);
    await guardar(5, { cantidad_minima: 11 });
    expect((await request.get('/saldos/bajo-umbral')).body).toEqual([{ id_producto: 5, cantidad_total: 10, cantidad_minima: 11 }]);
  });

  describe('concurrencia', () => {
    it('diez PUT simultáneos del mismo producto: todos 200 y UNA sola fila (el alta es un UPSERT atómico, no leer y luego insertar)', async () => {
      const valores = Array.from({ length: 10 }, (_, k) => k + 1);
      const respuestas = await Promise.all(valores.map((cantidad) => guardar(5, { cantidad_minima: cantidad })));
      expect(respuestas.map((res) => res.status)).toEqual(Array(10).fill(200));
      // Cada respuesta devuelve lo que ESE PUT escribió, aunque otro lo sobrescriba después.
      expect(respuestas.map((res) => res.body.cantidad_minima)).toEqual(valores);
      const guardadas = await filas();
      expect(guardadas).toHaveLength(1);
      expect(valores).toContain(guardadas[0].cantidad_minima);
    });

    it('PUT simultáneos de productos distintos crean cada uno su fila', async () => {
      const respuestas = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => guardar(id, { cantidad_minima: id * 10 })));
      expect(respuestas.map((res) => res.status)).toEqual(Array(6).fill(200));
      expect((await filas()).map((fila) => [fila.id_producto, fila.cantidad_minima])).toEqual([[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    });
  });

  describe('cantidad_minima (422, nunca un 500, y NO se llama al catálogo ni se escribe nada)', () => {
    it.each([
      ['-1', { cantidad_minima: -1 }],
      ['"x"', { cantidad_minima: 'x' }],
      ['1.5', { cantidad_minima: 1.5 }],
      ['"5" (un texto)', { cantidad_minima: '5' }],
      ['null', { cantidad_minima: null }],
      ['ausente ({})', {}],
      ['un arreglo', { cantidad_minima: [5] }],
      ['un objeto', { cantidad_minima: { valor: 5 } }],
      ['un booleano', { cantidad_minima: true }],
      ['2147483648 (más que el INTEGER)', { cantidad_minima: 2147483648 }],
      ['1e21 (fuera del rango seguro)', { cantidad_minima: 1e21 }],
    ])('cantidad_minima %s → 422 sobre ese campo', async (_descripcion, cuerpo) => {
      await control(5, 1);
      const res = await guardar(5, cuerpo);
      datosNoValidos(res, ['cantidad_minima']);
      catalogoSinLlamadas();
      // El umbral de control no cambió: el 422 no escribió nada.
      expect(await filas()).toEqual([expect.objectContaining({ id_producto: 5, cantidad_minima: 1 })]);
    });

    it('0 y 2147483647 (los extremos válidos) se aceptan; 2147483648 no', async () => {
      for (const valor of [0, 1, 2147483647]) {
        const res = await guardar(5, { cantidad_minima: valor });
        expect(res.status).toBe(200);
        expect(res.body.cantidad_minima).toBe(valor);
      }
      expect((await filas())[0].cantidad_minima).toBe(2147483647);
      datosNoValidos(await guardar(5, { cantidad_minima: 2147483648 }), ['cantidad_minima']);
      expect((await filas())[0].cantidad_minima).toBe(2147483647);
    });

    it.each([['sin cuerpo', undefined], ['con un arreglo vacío', []], ['con un arreglo con un objeto', [{ cantidad_minima: 5 }]]])(
      '%s → 422 y no se llama al catálogo',
      async (descripcion, cuerpo) => {
        await control(5, 1);
        const peticion = request.put('/umbrales/5').set(ADM);
        const res = await (cuerpo === undefined ? peticion : peticion.send(cuerpo));
        datosNoValidos(res, [descripcion === 'sin cuerpo' ? 'cantidad_minima' : 'cuerpo']);
        catalogoSinLlamadas();
        expect(await filas()).toEqual([expect.objectContaining({ cantidad_minima: 1 })]);
      },
    );

    it('con Content-Type que no es JSON (text/plain) el cuerpo no se lee → 422 sobre cantidad_minima, no un 500', async () => {
      const res = await request.put('/umbrales/5').set(ADM).set('Content-Type', 'text/plain').send('cantidad_minima=5');
      datosNoValidos(res, ['cantidad_minima']);
      catalogoSinLlamadas();
    });

    it('un JSON mal formado → 400 PETICION_MAL_FORMADA y no se llama al catálogo', async () => {
      const res = await request.put('/umbrales/5').set(ADM).set('Content-Type', 'application/json').send('{"cantidad_minima": ');
      esError(res, 400, 'PETICION_MAL_FORMADA');
      catalogoSinLlamadas();
      expect(await filas()).toEqual([]);
    });
  });

  describe('el id de la ruta', () => {
    it.each(['abc', '0', '-1', '1.5', '07', '1e3', '2147483648', '99999999999', '99999999999999999999'])(
      'el id %p → 404 NO_EXISTE sin llamar al catálogo ni escribir nada',
      async (id) => {
        await control(5, 1);
        recursoNoExiste(await guardar(id, { cantidad_minima: 10 }));
        catalogoSinLlamadas();
        expect(await filas()).toEqual([expect.objectContaining({ id_producto: 5, cantidad_minima: 1 })]);
      },
    );

    it('el id se valida ANTES que el cuerpo: un id inválido con un cuerpo inválido → 404, no 422', async () => {
      recursoNoExiste(await guardar('abc', { cantidad_minima: -1 }));
      recursoNoExiste(await guardar('0', {}));
      catalogoSinLlamadas();
    });

    it('el id más alto que cabe en el INTEGER (2147483647) llega al catálogo y se guarda', async () => {
      const res = await guardar('2147483647', { cantidad_minima: 3 });
      expect(res.status).toBe(200);
      expect(res.body.id_producto).toBe(2147483647);
      expect(clients.catalogo.obtenerProducto).toHaveBeenCalledWith(2147483647, expect.any(Object));
    });

    it('un id con escapes válidos (%35 = "5") es el mismo recurso', async () => {
      const res = await request.put('/umbrales/%35').set(ADM).send({ cantidad_minima: 3 });
      expect(res.status).toBe(200);
      expect(res.body.id_producto).toBe(5);
    });
  });

  describe('producto inexistente o catálogo caído: no se escribe nada', () => {
    it('un producto que el catálogo no conoce → 404 NO_EXISTE y no se crea el umbral', async () => {
      await control(5, 1); // control: el catálogo conoce el 5
      const res = await guardar(999, { cantidad_minima: 10 });
      recursoNoExiste(res);
      expect(res.body.error.mensaje).toBe('El producto no existe');
      expect(clients.catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
      expect(clients.catalogo.obtenerProducto).toHaveBeenCalledWith(999, expect.any(Object));
      expect((await filas()).map((fila) => fila.id_producto)).toEqual([5]);
    });

    it('un producto que ya tenía umbral y el catálogo ya no conoce → 404 y el umbral existente no cambia', async () => {
      const previo = await crearUmbral(db, { idProducto: 999, cantidadMinima: 4 });
      recursoNoExiste(await guardar(999, { cantidad_minima: 40 }));
      expect(await filas()).toEqual([previo]);
    });

    it('con ms-catalogo caído → 503 SERVICIO_NO_DISPONIBLE y no se crea ni se cambia nada', async () => {
      await control(5, 1);
      const previo = await filas();
      const res = await requestCaido.put('/umbrales/5').set(ADM).send({ cantidad_minima: 99 });
      esError(res, 503, 'SERVICIO_NO_DISPONIBLE');
      expect(catalogoCaido.obtenerProducto).toHaveBeenCalledTimes(1);
      expect(await filas()).toEqual(previo);
      const nuevo = await requestCaido.put('/umbrales/6').set(ADM).send({ cantidad_minima: 99 });
      esError(nuevo, 503, 'SERVICIO_NO_DISPONIBLE');
      expect(await filas()).toEqual(previo);
    });

    it('el 503 solo llega cuando la entrada es válida: con un cuerpo inválido y el catálogo caído → 422, sin llamarlo', async () => {
      datosNoValidos(await requestCaido.put('/umbrales/5').set(ADM).send({ cantidad_minima: -1 }), ['cantidad_minima']);
      expect(catalogoCaido.obtenerProducto).not.toHaveBeenCalled();
    });
  });

  describe('identidad en las escrituras (D8, D22)', () => {
    it('sin X-User-Id → 401 NO_AUTENTICADO, sin llamar al catálogo y sin escribir; con él, 200', async () => {
      esError(await request.put('/umbrales/5').send({ cantidad_minima: 10 }), 401, 'NO_AUTENTICADO');
      catalogoSinLlamadas();
      expect(await filas()).toEqual([]);
      expect((await guardar(5, { cantidad_minima: 10 })).status).toBe(200);
    });

    it('la identidad se exige ANTES que el id y el cuerpo: sin X-User-Id, con un id inválido o un cuerpo inválido → 401, no 404 ni 422', async () => {
      esError(await request.put('/umbrales/abc').send({ cantidad_minima: 10 }), 401, 'NO_AUTENTICADO');
      esError(await request.put('/umbrales/5').send({ cantidad_minima: -1 }), 401, 'NO_AUTENTICADO');
      esError(await request.put('/umbrales/999').send({ cantidad_minima: 10 }), 401, 'NO_AUTENTICADO');
      catalogoSinLlamadas();
    });

    it.each([
      ['X-User-Id no numérico', { 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }],
      ['X-User-Id cero', { 'X-User-Id': '0', 'X-User-Rol': 'ADMINISTRADOR' }],
      ['X-User-Rol desconocido', { 'X-User-Id': '7', 'X-User-Rol': 'SUPERUSUARIO' }],
      ['X-User-Id sin X-User-Rol', { 'X-User-Id': '7' }],
    ])('%s → 401 y no se escribe nada', async (_descripcion, cabeceras) => {
      esError(await guardar(5, { cantidad_minima: 10 }, cabeceras), 401, 'NO_AUTENTICADO');
      catalogoSinLlamadas();
      expect(await filas()).toEqual([]);
    });
  });
});

describe('un fallo de la base (500)', () => {
  // La base «rota» lanza en el primer acceso: simula una caída de PostgreSQL sin tocar la base de pruebas.
  const dbRota = () => {
    throw new Error('secreto-de-la-base: password authentication failed');
  };

  it.each([
    ['GET', '/umbrales', undefined],
    ['GET', '/umbrales?id_producto=5', undefined],
    ['PUT', '/umbrales/5', { cantidad_minima: 3 }],
  ])('%s %s → 500 ERROR_INTERNO sin mensaje ni traza; el registro lleva {nombre, mensaje, pila} y el request_id (D18)', async (metodo, ruta, cuerpo) => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const catalogo = fakeCatalogo();
    const app = createApp({ db: dbRota, clients: { catalogo }, logger, env: entornoValido() });
    const peticion = supertest(app)[metodo.toLowerCase()](ruta).set(ADM).set('X-Request-Id', 'prueba-500');
    const res = await (cuerpo ? peticion.send(cuerpo) : peticion);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno del servidor', detalles: [] } });
    expect(res.text).not.toContain('secreto');
    expect(res.text).not.toMatch(/\bat\s.+\(/); // ninguna línea de pila

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({
      request_id: 'prueba-500',
      estado: 500,
      codigo: 'ERROR_INTERNO',
      error: { nombre: 'Error', mensaje: expect.stringContaining('secreto-de-la-base'), pila: expect.stringContaining('secreto-de-la-base') },
    });
    // El PUT confirmó el producto antes de tocar la base.
    expect(catalogo.obtenerProducto).toHaveBeenCalledTimes(metodo === 'PUT' ? 1 : 0);
  });
});

describe('rutas que no existen en umbrales', () => {
  it.each([
    ['DELETE', '/umbrales/5'],
    ['PATCH', '/umbrales/5'],
    ['POST', '/umbrales'],
    ['POST', '/umbrales/5'],
    ['PUT', '/umbrales'],
    ['GET', '/umbrales/5'],
  ])('%s %s → 404 NO_EXISTE (un umbral se crea y se cambia con PUT /umbrales/{id_producto}; no se borra)', async (metodo, ruta) => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    expect((await request.get('/umbrales').set(ADM)).status).toBe(200); // control
    const peticion = request[metodo.toLowerCase()](ruta).set(ADM);
    rutaNoExiste(await (metodo === 'GET' ? peticion : peticion.send({ cantidad_minima: 3 })));
    expect(await filas()).toEqual([expect.objectContaining({ id_producto: 5, cantidad_minima: 10 })]);
  });
});
