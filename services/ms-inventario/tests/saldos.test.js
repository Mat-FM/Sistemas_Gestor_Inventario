const supertest = require('supertest');
const { createApp } = require('../src/app');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, crearUmbral, headers } = require('./helpers/fixtures');
const { ISO_8601, datosNoValidos, esError, rutaNoExiste } = require('./helpers/respuestas');

// Consultas de saldos (RF05) y productos bajo el umbral (RF09): las dos filas de saldos de la Tabla 9 de la Entrega 2,
// contra PostgreSQL real. Las pruebas de cada capa por separado están en saldosCapas.test.js y la lista de rutas en
// routes.test.js. Los umbrales se siembran directamente con Knex (crearUmbral): estas pruebas no dependen del código de umbrales.

const ADM = headers('ADMINISTRADOR');
const ROLES = ['ADMINISTRADOR', 'VENDEDOR', 'CONTADOR'];
const CLAVES_SALDO = ['id_saldo', 'id_producto', 'id_bodega', 'cantidad_disponible', 'fecha_actualizacion'];

let request;
let db;
let clients;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp());
});
beforeEach(async () => {
  await truncateAll(db);
  clients.catalogo.obtenerProducto.mockClear();
});
afterAll(() => db.destroy());

// Tres bodegas y sus ids, en una sola llamada. Los códigos van en orden alfabético inverso al de los ids.
async function sembrarBodegas() {
  const [a, b, c] = [await crearBodega(db, { codigo: 'Z1' }), await crearBodega(db, { codigo: 'M1' }), await crearBodega(db, { codigo: 'A1' })];
  return [a.id_bodega, b.id_bodega, c.id_bodega];
}

const ids = (items) => items.map((item) => [item.id_producto, item.id_bodega]);

describe('GET /saldos', () => {
  it('lista los saldos con el envoltorio paginado y exactamente sus cinco campos, ordenados por id_producto y id_bodega', async () => {
    const [b1, b2] = await sembrarBodegas();
    // Insertados en el desorden contrario al esperado: ordenar por id_saldo daría otra secuencia.
    await crearSaldo(db, { idProducto: 9, idBodega: b1, cantidad: 1 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 2 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    const res = await request.get('/saldos').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
    expect(ids(res.body.datos)).toEqual([[5, b1], [5, b2], [9, b1]]);
    expect(res.body.datos.map((saldo) => saldo.cantidad_disponible)).toEqual([3, 2, 1]);
    for (const saldo of res.body.datos) expect(Object.keys(saldo).sort()).toEqual([...CLAVES_SALDO].sort());
    expect(res.body.datos[0]).toEqual({ id_saldo: 3, id_producto: 5, id_bodega: b1, cantidad_disponible: 3, fecha_actualizacion: expect.stringMatching(ISO_8601) });
  });

  it('los tipos son los del contrato: cantidades e ids como NÚMEROS y la fecha como texto ISO 8601', async () => {
    const [b1] = await sembrarBodegas();
    const guardado = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 12 });
    const [saldo] = (await request.get('/saldos').set(ADM)).body.datos;
    for (const campo of ['id_saldo', 'id_producto', 'id_bodega', 'cantidad_disponible']) expect(typeof saldo[campo]).toBe('number');
    expect(saldo.fecha_actualizacion).toBe(guardado.fecha_actualizacion.toISOString());
  });

  it('sin saldos → {datos: [], meta: {pagina: 1, por_pagina: 20, total: 0}}, con total numérico y sin cantidad_total', async () => {
    const res = await request.get('/saldos').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
  });

  describe('?id_producto (RF05: también el total de las bodegas, D10)', () => {
    it('con id_producto, meta.cantidad_total suma las bodegas: 3 + 4 + 0 = 7; no suma los saldos de otros productos', async () => {
      const [b1, b2, b3] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 0 });
      await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 100 });
      const res = await request.get('/saldos').query({ id_producto: 5 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3, cantidad_total: 7 });
      expect(typeof res.body.meta.cantidad_total).toBe('number');
      expect(ids(res.body.datos)).toEqual([[5, b1], [5, b2], [5, b3]]);
      expect(res.body.datos.map((saldo) => saldo.cantidad_disponible)).toEqual([3, 4, 0]);
    });

    it('cantidad_total es la de TODAS las filas del filtro, no la de la página: con por_pagina=1 sigue siendo 7', async () => {
      const [b1, b2, b3] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 0 });
      for (const pagina of [1, 2, 3]) {
        const res = await request.get('/saldos').query({ id_producto: 5, por_pagina: 1, pagina }).set(ADM);
        expect(res.body.datos).toHaveLength(1);
        expect(res.body.meta).toEqual({ pagina, por_pagina: 1, total: 3, cantidad_total: 7 });
      }
      // Fuera de rango: sin filas, pero el total y la suma siguen siendo los del filtro.
      const fuera = await request.get('/saldos').query({ id_producto: 5, por_pagina: 1, pagina: 9 }).set(ADM);
      expect(fuera.body).toEqual({ datos: [], meta: { pagina: 9, por_pagina: 1, total: 3, cantidad_total: 7 } });
    });

    it('un producto sin saldos → lista vacía, total 0 y cantidad_total 0 (no 404 ni null); no se llama al catálogo', async () => {
      const [b1] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      expect((await request.get('/saldos').query({ id_producto: 5 }).set(ADM)).body.meta.cantidad_total).toBe(3); // control
      const res = await request.get('/saldos').query({ id_producto: 999 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0, cantidad_total: 0 } });
      expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
    });

    it('sin id_producto la clave cantidad_total NO aparece en meta (ni con id_bodega ni con paginación)', async () => {
      const [b1, b2] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 6, idBodega: b2, cantidad: 4 });
      for (const query of [{}, { id_bodega: b1 }, { por_pagina: 1 }, { pagina: 2, por_pagina: 1 }]) {
        const res = await request.get('/saldos').query(query).set(ADM);
        expect(res.status).toBe(200);
        expect(res.body.meta).not.toHaveProperty('cantidad_total');
        expect(Object.keys(res.body.meta).sort()).toEqual(['pagina', 'por_pagina', 'total']);
      }
    });

    it('la suma no desborda el INTEGER: dos saldos de 2147483647 suman 4294967294, como número', async () => {
      const [b1, b2] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2147483647 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 2147483647 });
      const res = await request.get('/saldos').query({ id_producto: 5 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta.cantidad_total).toBe(4294967294);
    });
  });

  describe('?id_bodega', () => {
    it('filtra por bodega: solo sus saldos, con meta.total de ese filtro y sin cantidad_total', async () => {
      const [b1, b2] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 4 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 9 });
      const res = await request.get('/saldos').query({ id_bodega: b1 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 2 });
      expect(ids(res.body.datos)).toEqual([[5, b1], [6, b1]]);
    });

    it('una bodega sin saldos o que no existe → 200 con lista vacía y total 0 (el contrato no prevé 404)', async () => {
      const [b1] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      expect((await request.get('/saldos').query({ id_bodega: b1 }).set(ADM)).body.meta.total).toBe(1); // control
      for (const id of [999, 2147483647]) {
        const res = await request.get('/saldos').query({ id_bodega: id }).set(ADM);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
      }
    });

    it('id_producto e id_bodega juntos: un solo saldo y cantidad_total de ESE filtro (lectura adoptada del contrato)', async () => {
      // La Tabla 9 dice «con id_producto, también el total de las dos bodegas». Aquí se fija la lectura adoptada: cantidad_total
      // suma lo que cubre el filtro efectivo; con id_bodega, el producto en esa bodega y no en todas.
      const [b1, b2] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      const res = await request.get('/saldos').query({ id_producto: 5, id_bodega: b2 }).set(ADM);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 1, cantidad_total: 4 });
      expect(ids(res.body.datos)).toEqual([[5, b2]]);
    });
  });

  describe('paginación (la usa ms-reportes: pide por_pagina=100 y se detiene cuando pagina * por_pagina >= meta.total)', () => {
    // Recorre el listado con la regla literal del consumidor. Corta si no termina, para que un fallo no cuelgue la prueba.
    async function recorrer(query, porPagina) {
      const paginas = [];
      for (let pagina = 1; pagina <= 20; pagina += 1) {
        const res = await request.get('/saldos').query({ ...query, pagina, por_pagina: porPagina }).set(ADM);
        expect(res.status).toBe(200);
        paginas.push(res.body);
        if (pagina * porPagina >= res.body.meta.total) return paginas;
      }
      throw new Error('El recorrido no termina: meta.total nunca alcanzó pagina * por_pagina');
    }

    let bodegas;
    beforeEach(async () => {
      bodegas = await sembrarBodegas();
      // 3 productos × 3 bodegas = 9 saldos, insertados en orden inverso al de lectura.
      for (const idProducto of [3, 2, 1]) {
        for (const idBodega of [...bodegas].reverse()) await crearSaldo(db, { idProducto, idBodega, cantidad: idProducto * 10 });
      }
    });

    it('con por_pagina pequeño la unión de las páginas es exactamente lo sembrado, sin repetidos ni saltos y en orden', async () => {
      const paginas = await recorrer({}, 4);
      expect(paginas.map((pagina) => pagina.datos.length)).toEqual([4, 4, 1]);
      const todos = ids(paginas.flatMap((pagina) => pagina.datos));
      const esperados = [1, 2, 3].flatMap((idProducto) => bodegas.map((idBodega) => [idProducto, idBodega]));
      expect(todos).toEqual(esperados);
      expect(new Set(todos.map(String)).size).toBe(9);
    });

    it('meta.total es el de TODAS las filas del filtro (un número exacto) en cada página', async () => {
      for (const pagina of await recorrer({}, 4)) {
        expect(pagina.meta.total).toBe(9);
        expect(typeof pagina.meta.total).toBe('number');
      }
    });

    it('con id_producto el recorrido cubre solo ese producto y cantidad_total no cambia de una página a otra', async () => {
      const paginas = await recorrer({ id_producto: 2 }, 2);
      expect(paginas.map((pagina) => pagina.datos.length)).toEqual([2, 1]);
      expect(paginas.map((pagina) => pagina.meta)).toEqual([
        { pagina: 1, por_pagina: 2, total: 3, cantidad_total: 60 },
        { pagina: 2, por_pagina: 2, total: 3, cantidad_total: 60 },
      ]);
    });

    it('con id_bodega el recorrido cubre solo esa bodega', async () => {
      const paginas = await recorrer({ id_bodega: bodegas[1] }, 2);
      expect(paginas.flatMap((pagina) => ids(pagina.datos))).toEqual([[1, bodegas[1]], [2, bodegas[1]], [3, bodegas[1]]]);
      expect(paginas.map((pagina) => pagina.meta.total)).toEqual([3, 3]);
    });

    it('por_pagina=100 (lo que pide ms-reportes) devuelve todo en una sola página; una página fuera de rango da datos vacíos y el total exacto', async () => {
      const res = await request.get('/saldos').query({ pagina: 1, por_pagina: 100 }).set(ADM);
      expect(res.body.datos).toHaveLength(9);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 100, total: 9 });
      const fuera = await request.get('/saldos').query({ pagina: 99, por_pagina: 4 }).set(ADM);
      expect(fuera.body).toEqual({ datos: [], meta: { pagina: 99, por_pagina: 4, total: 9 } });
    });
  });

  describe('validación de la consulta (422, nunca un 500)', () => {
    it.each([
      ['id_producto=abc', { id_producto: 'abc' }, ['id_producto']],
      ['id_producto=0', { id_producto: '0' }, ['id_producto']],
      ['id_producto=-1', { id_producto: '-1' }, ['id_producto']],
      ['id_producto=1.5', { id_producto: '1.5' }, ['id_producto']],
      ['id_producto vacío', { id_producto: '' }, ['id_producto']],
      ['id_producto=2147483648 (más que el INTEGER)', { id_producto: '2147483648' }, ['id_producto']],
      ['id_producto repetido (arreglo)', { id_producto: ['1', '2'] }, ['id_producto']],
      ['id_bodega=abc', { id_bodega: 'abc' }, ['id_bodega']],
      ['id_bodega=0', { id_bodega: '0' }, ['id_bodega']],
      ['id_bodega=2147483648', { id_bodega: '2147483648' }, ['id_bodega']],
      ['pagina=0', { pagina: '0' }, ['pagina']],
      ['por_pagina=101', { por_pagina: '101' }, ['por_pagina']],
      ['todos inválidos a la vez', { id_producto: 'x', id_bodega: 'y', pagina: '0', por_pagina: '500' }, ['id_producto', 'id_bodega', 'pagina', 'por_pagina']],
    ])('%s → 422 con todos los parámetros inválidos', async (_descripcion, query, campos) => {
      expect((await request.get('/saldos').query({ id_producto: '5', id_bodega: '1', por_pagina: '100' }).set(ADM)).status).toBe(200); // control
      datosNoValidos(await request.get('/saldos').query(query).set(ADM), campos);
    });

    it('el id más alto que cabe en el INTEGER (2147483647) se acepta y devuelve una lista vacía', async () => {
      const res = await request.get('/saldos').query({ id_producto: '2147483647', id_bodega: '2147483647' }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 0, cantidad_total: 0 });
    });
  });

  // Fija lo que ya hace el código con parámetros que el cliente puede escribir «raro»: los repetidos, vacíos o con espacios son
  // 422 (nunca se toma el primero ni se ignoran) y los nombres que Express no reconoce se ignoran. Ninguno deja a un operador
  // de bodega fuera de su alcance. Siembra la de «alcance por rol»: producto 5 en las tres bodegas (3, 4, 20) y producto 6 en la 2.
  describe('parámetros repetidos, vacíos o con nombre raro (no esquivan el alcance del operador)', () => {
    let b1;
    let b2;
    let b3;
    beforeEach(async () => {
      [b1, b2, b3] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 20 });
      await crearSaldo(db, { idProducto: 6, idBodega: b2, cantidad: 8 });
    });

    // Quien consulta: cada caso se prueba con el operador de la bodega b2 y con el administrador.
    const LLAMADORES = [
      ['un OPERADOR_BODEGA', () => headers('OPERADOR_BODEGA', { idBodega: b2 })],
      ['un ADMINISTRADOR', () => ADM],
    ];

    // Cada caso es una cadena de consulta escrita a mano (así se ve exactamente lo que viaja) y los campos inválidos que informa.
    const INVALIDOS = [
      ['id_bodega repetido con una ajena primero', () => `id_bodega=${b1}&id_bodega=${b2}`, ['id_bodega']],
      ['id_bodega repetido con la propia primero', () => `id_bodega=${b2}&id_bodega=${b1}`, ['id_bodega']],
      ['id_bodega repetido con el mismo valor', () => `id_bodega=${b2}&id_bodega=${b2}`, ['id_bodega']],
      ['id_bodega repetido, uno vacío', () => `id_bodega=&id_bodega=${b2}`, ['id_bodega']],
      ['id_bodega vacío', () => 'id_bodega=', ['id_bodega']],
      ['id_bodega con un espacio delante (%20)', () => `id_bodega=%20${b2}`, ['id_bodega']],
      ['id_bodega con un espacio detrás (%20)', () => `id_bodega=${b2}%20`, ['id_bodega']],
      ['id_bodega con un signo más (+)', () => `id_bodega=%2B${b2}`, ['id_bodega']],
      ['pagina repetido', () => 'pagina=1&pagina=2', ['pagina']],
      ['por_pagina repetido', () => 'por_pagina=1&por_pagina=2', ['por_pagina']],
      ['pagina y por_pagina repetidos a la vez', () => 'pagina=1&pagina=2&por_pagina=1&por_pagina=2', ['pagina', 'por_pagina']],
      ['id_producto repetido', () => 'id_producto=5&id_producto=6', ['id_producto']],
      ['id_bodega repetido y pagina inválida', () => `id_bodega=${b1}&id_bodega=${b2}&pagina=0`, ['id_bodega', 'pagina']],
    ];

    describe.each(LLAMADORES)('%s', (_nombre, cabeceras) => {
      it.each(INVALIDOS)('%s → 422 sobre los campos inválidos (no 403 ni 200), sin datos', async (_caso, consulta, campos) => {
        // Control positivo: la misma persona, con una consulta válida, recibe 200.
        expect((await request.get('/saldos').set(cabeceras())).status).toBe(200);
        const res = await request.get(`/saldos?${consulta()}`).set(cabeceras());
        datosNoValidos(res, campos);
        expect(res.body).not.toHaveProperty('datos');
      });
    });

    // Express 5 usa el analizador de consulta «simple»: los nombres con corchetes o con otras mayúsculas son OTRO parámetro y
    // se ignoran. Si alguien activara el analizador extendido, `id_bodega[]=x` llegaría como arreglo y estas pruebas avisan.
    const IGNORADOS = [
      ['id_bodega[] (corchetes)', () => `id_bodega[]=${b1}`],
      ['id_bodega[0] (índice)', () => `id_bodega[0]=${b1}`],
      ['id_bodega[a] (clave)', () => `id_bodega[a]=${b1}`],
      ['ID_BODEGA (mayúsculas)', () => `ID_BODEGA=${b1}`],
      ['Id_Bodega (mayúsculas mixtas)', () => `Id_Bodega=${b1}`],
      ['id_bodega con un espacio en el nombre', () => `id_bodega%20=${b1}`],
    ];

    it.each(IGNORADOS)('un operador que escribe %s con una bodega ajena sigue viendo SOLO la suya (200), no recibe 403 ni la ajena', async (_caso, consulta) => {
      const operador = headers('OPERADOR_BODEGA', { idBodega: b2 });
      // Control positivo: pedir la ajena con el nombre bueno SÍ es 403.
      esError(await request.get(`/saldos?id_bodega=${b1}`).set(operador), 403, 'SIN_PERMISO');
      const res = await request.get(`/saldos?${consulta()}`).set(operador);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 2 });
      expect(ids(res.body.datos)).toEqual([[5, b2], [6, b2]]);
    });

    it.each(IGNORADOS)('el administrador que escribe %s no filtra por bodega: el nombre se ignora y ve las cuatro filas', async (_caso, consulta) => {
      const res = await request.get(`/saldos?${consulta()}`).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 4 });
    });

    it('un nombre ignorado no impide validar el parámetro bueno: id_bodega=abc junto a ID_BODEGA=1 → 422 sobre id_bodega', async () => {
      for (const [, cabeceras] of LLAMADORES) {
        datosNoValidos(await request.get(`/saldos?ID_BODEGA=${b2}&id_bodega=abc`).set(cabeceras()), ['id_bodega']);
      }
    });
  });

  describe('alcance por rol (restricción global 4: un operador nunca ve otra bodega)', () => {
    let b1;
    let b2;
    let b3;
    beforeEach(async () => {
      [b1, b2, b3] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 20 });
      await crearSaldo(db, { idProducto: 6, idBodega: b2, cantidad: 8 });
    });

    it.each(ROLES)('un %s ve cualquier bodega: con y sin id_bodega', async (rol) => {
      const todos = await request.get('/saldos').set(headers(rol));
      expect(todos.status).toBe(200);
      expect(todos.body.meta.total).toBe(4);
      for (const id of [b1, b2, b3]) {
        const una = await request.get('/saldos').query({ id_bodega: id }).set(headers(rol));
        expect(una.status).toBe(200);
        expect(una.body.datos.every((saldo) => saldo.id_bodega === id)).toBe(true);
      }
      expect((await request.get('/saldos').query({ id_producto: 5 }).set(headers(rol))).body.meta.cantidad_total).toBe(27);
    });

    it('la llamada interna sin X-User-Id (ms-reportes, D8) ve todo', async () => {
      const res = await request.get('/saldos').query({ id_producto: 5 });
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3, cantidad_total: 27 });
      expect((await request.get('/saldos').query({ id_bodega: b3 })).body.datos).toHaveLength(1);
    });

    it('un operador sin id_bodega ve SOLO su bodega', async () => {
      const res = await request.get('/saldos').set(headers('OPERADOR_BODEGA', { idBodega: b2 }));
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 2 });
      expect(ids(res.body.datos)).toEqual([[5, b2], [6, b2]]);
    });

    it('un operador que pide su propia bodega la ve; si pide otra → 403 SIN_PERMISO sin datos', async () => {
      const operador = headers('OPERADOR_BODEGA', { idBodega: b2 });
      const propia = await request.get('/saldos').query({ id_bodega: b2 }).set(operador);
      expect(propia.status).toBe(200);
      expect(propia.body.meta.total).toBe(2);
      for (const ajena of [b1, b3, 999]) {
        const res = await request.get('/saldos').query({ id_bodega: ajena }).set(operador);
        esError(res, 403, 'SIN_PERMISO');
        expect(res.body).not.toHaveProperty('datos');
      }
    });

    it('un operador sin X-User-Bodega → 403 SIN_PERMISO, con y sin id_bodega', async () => {
      const sinBodega = headers('OPERADOR_BODEGA');
      expect(sinBodega).not.toHaveProperty('X-User-Bodega');
      esError(await request.get('/saldos').set(sinBodega), 403, 'SIN_PERMISO');
      esError(await request.get('/saldos').query({ id_bodega: b1 }).set(sinBodega), 403, 'SIN_PERMISO');
    });

    it('con id_producto, meta.cantidad_total de un operador suma SOLO su bodega (el filtro efectivo), no las tres: 4 y no 27', async () => {
      const operador = headers('OPERADOR_BODEGA', { idBodega: b2 });
      const res = await request.get('/saldos').query({ id_producto: 5 }).set(operador);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 1, cantidad_total: 4 });
      expect(ids(res.body.datos)).toEqual([[5, b2]]);
      // Control: el administrador, con el mismo producto, ve las tres bodegas.
      expect((await request.get('/saldos').query({ id_producto: 5 }).set(ADM)).body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3, cantidad_total: 27 });
    });

    it('un operador con un parámetro inválido recibe 422 (la validación va antes que el alcance)', async () => {
      datosNoValidos(await request.get('/saldos').query({ id_bodega: 'x' }).set(headers('OPERADOR_BODEGA', { idBodega: b2 })), ['id_bodega']);
    });
  });

  describe('lecturas sin X-User-Id (llamadas internas válidas, D8)', () => {
    it('GET /saldos sin cabeceras de identidad → 200', async () => {
      const [b1] = await sembrarBodegas();
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      const res = await request.get('/saldos');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
    });

    it('con una cabecera de identidad inválida la lectura sí es 401 (nunca se ignora en silencio)', async () => {
      esError(await request.get('/saldos').set({ 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
    });
  });
});

describe('GET /saldos/bajo-umbral', () => {
  // Control positivo + rechazo: con el total por debajo del mínimo el producto entra y con el total igual o mayor, no.
  const bajoUmbral = (cabeceras = ADM) => request.get('/saldos/bajo-umbral').set(cabeceras);

  it('devuelve un ARREGLO PLANO (no {datos, meta}) con solo el producto cuyo total de las bodegas es menor que el mínimo', async () => {
    const [b1, b2] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
    const res = await bajoUmbral();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([{ id_producto: 5, cantidad_total: 7, cantidad_minima: 10 }]);
    expect(Object.keys(res.body[0])).toEqual(['id_producto', 'cantidad_total', 'cantidad_minima']);
  });

  it('los tres campos son NÚMEROS: el SUM de PostgreSQL es bigint y no debe llegar como texto ("7")', async () => {
    const [b1, b2] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
    await crearUmbral(db, { idProducto: 6, cantidadMinima: 10 }); // sin saldos: el total sale de un COALESCE, otro camino al número
    const res = await bajoUmbral();
    expect(res.body).toHaveLength(2);
    for (const item of res.body) {
      for (const campo of ['id_producto', 'cantidad_total', 'cantidad_minima']) expect(typeof item[campo]).toBe('number');
    }
  });

  it('el límite es ESTRICTO (D13): total 9 entra; total 10 (= mínimo) y 11 no', async () => {
    const [b1, b2] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    const saldo = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 9 });
    await crearSaldo(db, { idProducto: 6, idBodega: b2, cantidad: 0 }); // otro producto, sin umbral: no cuenta
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 5, cantidad_total: 9, cantidad_minima: 10 }]);
    for (const [cantidad, alerta] of [[10, false], [11, false], [9, true]]) {
      await db('saldos').where({ id_saldo: saldo.id_saldo }).update({ cantidad_disponible: cantidad });
      expect((await bajoUmbral()).body).toHaveLength(alerta ? 1 : 0);
    }
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 5, cantidad_total: 9, cantidad_minima: 10 }]);
  });

  it('el total suma las bodegas: 3 en una y 7 en otra (= 10) NO alerta con mínimo 10, aunque cada una esté por debajo', async () => {
    const [b1, b2] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    const segunda = await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 6 });
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 5, cantidad_total: 9, cantidad_minima: 10 }]); // control
    await db('saldos').where({ id_saldo: segunda.id_saldo }).update({ cantidad_disponible: 7 });
    expect((await bajoUmbral()).body).toEqual([]);
  });

  it('un producto con umbral y SIN ninguna fila de saldos cuenta como total 0 y alerta', async () => {
    await crearUmbral(db, { idProducto: 7, cantidadMinima: 5 });
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 7, cantidad_total: 0, cantidad_minima: 5 }]);
  });

  it('un producto con umbral y saldos en 0 alerta con total 0', async () => {
    const [b1, b2] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 7, cantidadMinima: 5 });
    await crearSaldo(db, { idProducto: 7, idBodega: b1, cantidad: 0 });
    await crearSaldo(db, { idProducto: 7, idBodega: b2, cantidad: 0 });
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 7, cantidad_total: 0, cantidad_minima: 5 }]);
  });

  it('un umbral de 0 no alerta nunca: ni con saldos en 0 ni sin ninguna fila de saldos', async () => {
    const [b1] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 0 });
    await crearUmbral(db, { idProducto: 6, cantidadMinima: 0 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    await crearUmbral(db, { idProducto: 7, cantidadMinima: 1 }); // control: este sí alerta
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 7, cantidad_total: 0, cantidad_minima: 1 }]);
  });

  it('un producto con saldos pero SIN umbral nunca aparece', async () => {
    const [b1] = await sembrarBodegas();
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    await crearUmbral(db, { idProducto: 6, cantidadMinima: 1 }); // control
    expect((await bajoUmbral()).body.map((item) => item.id_producto)).toEqual([6]);
  });

  it('con varios productos mezclados solo entran los que están bajo su mínimo, ordenados por id_producto', async () => {
    const [b1, b2] = await sembrarBodegas();
    // Umbrales insertados en desorden: el orden de la respuesta es por id_producto, no por inserción.
    await crearUmbral(db, { idProducto: 8, cantidadMinima: 5 }); // sin saldos → total 0 < 5: entra
    await crearUmbral(db, { idProducto: 3, cantidadMinima: 10 }); // 12 ≥ 10: no entra
    await crearUmbral(db, { idProducto: 2, cantidadMinima: 10 }); // 7 < 10: entra
    await crearUmbral(db, { idProducto: 4, cantidadMinima: 10 }); // 10 = 10: no entra
    await crearSaldo(db, { idProducto: 3, idBodega: b1, cantidad: 5 });
    await crearSaldo(db, { idProducto: 3, idBodega: b2, cantidad: 7 });
    await crearSaldo(db, { idProducto: 2, idBodega: b1, cantidad: 3 });
    await crearSaldo(db, { idProducto: 2, idBodega: b2, cantidad: 4 });
    await crearSaldo(db, { idProducto: 4, idBodega: b2, cantidad: 10 });
    const res = await bajoUmbral();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id_producto: 2, cantidad_total: 7, cantidad_minima: 10 },
      { id_producto: 8, cantidad_total: 0, cantidad_minima: 5 },
    ]);
  });

  it('el total de un producto no incluye los saldos de otro', async () => {
    const [b1] = await sembrarBodegas();
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 4 });
    await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 500 });
    expect((await bajoUmbral()).body).toEqual([{ id_producto: 5, cantidad_total: 4, cantidad_minima: 10 }]);
  });

  it('sin umbrales → arreglo vacío []', async () => {
    const [b1] = await sembrarBodegas();
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    const res = await bajoUmbral();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('no se pagina: devuelve TODOS los productos bajo el umbral (más de 20, el tamaño de página por defecto)', async () => {
    for (let id = 1; id <= 25; id += 1) await crearUmbral(db, { idProducto: id, cantidadMinima: 1 });
    const res = await bajoUmbral();
    expect(res.body).toHaveLength(25);
    expect(res.body.map((item) => item.id_producto)).toEqual(Array.from({ length: 25 }, (_, k) => k + 1));
  });

  it('lo consultan sin X-User-Id ms-notificaciones y ms-reportes (llamadas internas, D8) y cualquier rol', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    const esperado = [{ id_producto: 5, cantidad_total: 0, cantidad_minima: 10 }];
    expect((await request.get('/saldos/bajo-umbral')).body).toEqual(esperado);
    for (const rol of ROLES) expect((await bajoUmbral(headers(rol))).body).toEqual(esperado);
  });

  it('no llama al catálogo (es una lectura)', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    expect((await bajoUmbral()).status).toBe(200);
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
  });

  it('con una cabecera de identidad inválida es 401; /saldos/bajo-umbral no se confunde con un id de saldo (no hay GET /saldos/:id)', async () => {
    esError(await request.get('/saldos/bajo-umbral').set({ 'X-User-Id': '0', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
    expect((await bajoUmbral()).status).toBe(200);
  });
});

describe('un fallo de la base (500)', () => {
  // La base «rota» lanza en el primer acceso: simula una caída de PostgreSQL sin tocar la base de pruebas.
  const dbRota = () => {
    throw new Error('secreto-de-la-base: password authentication failed');
  };

  it.each([['/saldos'], ['/saldos?id_producto=5'], ['/saldos/bajo-umbral']])(
    'GET %s → 500 ERROR_INTERNO sin mensaje ni traza; el registro lleva {nombre, mensaje, pila} y el request_id (D18)',
    async (ruta) => {
      const logger = { info: jest.fn(), error: jest.fn() };
      const app = createApp({ db: dbRota, clients: {}, logger, env: entornoValido() });
      const res = await supertest(app).get(ruta).set(ADM).set('X-Request-Id', 'prueba-500');

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
    },
  );
});

describe('rutas que no existen en saldos', () => {
  it.each([
    ['POST', '/saldos'],
    ['PUT', '/saldos/1'],
    ['DELETE', '/saldos/1'],
    ['GET', '/saldos/1'],
    ['POST', '/saldos/bajo-umbral'],
    ['GET', '/saldos/bajo-umbral/detalle'],
  ])('%s %s → 404 NO_EXISTE (los saldos los mueve solo el motor de movimientos)', async (metodo, ruta) => {
    expect((await request.get('/saldos').set(ADM)).status).toBe(200); // control
    rutaNoExiste(await request[metodo.toLowerCase()](ruta).set(ADM));
  });
});
