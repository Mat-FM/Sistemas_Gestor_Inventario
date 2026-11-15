const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const supertest = require('supertest');
const { createApp } = require('../src/app');
const loteRepository = require('../src/repositories/loteRepository');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, fakeCatalogo, fakeNotificaciones, headers } = require('./helpers/fixtures');
const { datosNoValidos, esError, rutaNoExiste } = require('./helpers/respuestas');

// Los lotes (RF17): las dos consultas de la Tabla 9 de la Entrega 2, GET /lotes y GET /lotes/sugerencia-salida, de punta a punta
// contra PostgreSQL real. Los lotes se SIEMBRAN con Knex (crearLote): estas pruebas no dependen del motor de stock, salvo la de
// integración de la sugerencia, que contrasta con POST /movimientos. Las capas por separado (repositorio y servicio) están en
// lotesCapas.test.js y la lista de rutas en routes.test.js.

const ADM = headers('ADMINISTRADOR');
const CLAVES_LOTE = ['id_lote', 'id_producto', 'id_bodega', 'codigo_lote', 'fecha_vencimiento', 'cantidad_disponible'];
const RAIZ = path.resolve(__dirname, '..');
const ejecutar = promisify(execFile);

let request;
let db;
let clients;
let b1;
let b2;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp());
});
beforeEach(async () => {
  await truncateAll(db);
  [b1, b2] = [(await crearBodega(db, { codigo: 'B1' })).id_bodega, (await crearBodega(db, { codigo: 'B2' })).id_bodega];
  clients.catalogo.obtenerProducto.mockClear();
  clients.notificaciones.notificarStockBajo.mockClear();
});
afterAll(() => db.destroy());

const ids = (cuerpo) => cuerpo.datos.map((lote) => lote.id_lote);
// Siembra un lote de la bodega b1 y el producto 5 salvo que se diga otra cosa; el código nunca se repite dentro de una prueba.
let siguiente = 0;
const sembrar = (extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: `L${(siguiente += 1)}`, cantidad: 5, ...extra });

// Siembra común de los filtros y del alcance (ids 1 a 7). En orden FEFO: 5, 4, 1, 7, 2, 6, 3.
//  id  bodega  producto  vence        existencia
//  1   b1      5         2027-01-31   5
//  2   b1      5         2027-02-01   0
//  3   b1      5         (sin fecha)  3
//  4   b1      5         2027-01-30   2
//  5   b1      6         2027-01-15   7
//  6   b2      5         2027-02-15   1
//  7   b2      5         2027-01-31   0
async function sembrarVarios() {
  await sembrar({ fechaVencimiento: '2027-01-31', cantidad: 5 });
  await sembrar({ fechaVencimiento: '2027-02-01', cantidad: 0 });
  await sembrar({ fechaVencimiento: null, cantidad: 3 });
  await sembrar({ fechaVencimiento: '2027-01-30', cantidad: 2 });
  await sembrar({ idProducto: 6, fechaVencimiento: '2027-01-15', cantidad: 7 });
  await sembrar({ idBodega: b2, fechaVencimiento: '2027-02-15', cantidad: 1 });
  await sembrar({ idBodega: b2, fechaVencimiento: '2027-01-31', cantidad: 0 });
}
const FEFO_DE_TODOS = [5, 4, 1, 7, 2, 6, 3];

// Los lotes de b1 y el producto 5 con el bloqueo FOR UPDATE de un movimiento en curso (la transacción dueña sigue abierta
// mientras corre `comprobar`). Control del arnés: otra transacción que pide esas mismas filas con FOR UPDATE SÍ queda esperando,
// así que el bloqueo es real y no una prueba vacía. Al terminar se libera todo.
async function conLotesBloqueados(comprobar) {
  const par = { idBodega: b1, idProducto: 5 };
  const duenio = await db.transaction();
  let espera;
  try {
    await loteRepository.listarParaFefo(duenio, par);
    espera = db.transaction((otra) => loteRepository.listarParaFefo(otra, par));
    await esperarBloqueo(db);
    await comprobar();
  } finally {
    await duenio.rollback();
    if (espera) await espera;
  }
}
const AGOTADO = Symbol('plazo agotado');
const plazo = (ms) => new Promise((resolver) => { setTimeout(() => resolver(AGOTADO), ms); });

describe('GET /lotes', () => {
  describe('el listado', () => {
    it('lista del que vence primero al último con el envoltorio paginado y exactamente los 6 campos de D1: ids y cantidad como NÚMEROS, la fecha como texto', async () => {
      /* Insertados en un orden distinto al de las fechas: ordenar por id (asc o desc) daría otra secuencia. */
      const tarde = await sembrar({ codigoLote: 'TARDE', fechaVencimiento: '2027-03-01', cantidad: 4 });
      const temprano = await sembrar({ codigoLote: 'TEMPRANO', fechaVencimiento: '2027-01-15', cantidad: 9 });
      const medio = await sembrar({ idBodega: b2, idProducto: 6, codigoLote: 'MEDIO', fechaVencimiento: '2027-02-01', cantidad: 1 });
      const res = await request.get('/lotes').set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
      expect(ids(res.body)).toEqual([temprano.id_lote, medio.id_lote, tarde.id_lote]);
      expect(res.body.datos[0]).toEqual({ id_lote: temprano.id_lote, id_producto: 5, id_bodega: b1, codigo_lote: 'TEMPRANO', fecha_vencimiento: '2027-01-15', cantidad_disponible: 9 });
      for (const lote of res.body.datos) {
        expect(Object.keys(lote).sort()).toEqual([...CLAVES_LOTE].sort());
        for (const campo of ['id_lote', 'id_producto', 'id_bodega', 'cantidad_disponible']) expect(typeof lote[campo]).toBe('number');
        expect(lote.fecha_vencimiento).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('los lotes sin fecha van AL FINAL (fecha_vencimiento: null) y los que vencen el mismo día se desempatan por id_lote ascendente', async () => {
      /* Empate de fecha entre los ids 1, 2 y 3. El UPDATE del primero lo manda al final del montón: sin el desempate por id_lote,
         el orden de las filas empatadas seguiría al del montón y daría [2, 3, 1]. */
      await sembrar({ codigoLote: 'A', fechaVencimiento: '2027-01-31' });
      await sembrar({ codigoLote: 'B', fechaVencimiento: '2027-01-31' });
      await sembrar({ codigoLote: 'C', fechaVencimiento: '2027-01-31' });
      await sembrar({ codigoLote: 'SIN-FECHA', fechaVencimiento: null }); // 4
      await sembrar({ codigoLote: 'ANTES', fechaVencimiento: '2027-01-01' }); // 5
      await db('lotes').where({ id_lote: 1 }).update({ cantidad_disponible: 6 });
      const res = await request.get('/lotes').set(ADM);
      expect(ids(res.body)).toEqual([5, 1, 2, 3, 4]);
      expect(res.body.datos.map((lote) => lote.fecha_vencimiento)).toEqual(['2027-01-01', '2027-01-31', '2027-01-31', '2027-01-31', null]);
    });

    it('sin lotes → {datos: [], meta: {pagina: 1, por_pagina: 20, total: 0}}, con total numérico', async () => {
      await sembrar();
      expect((await request.get('/lotes').set(ADM)).body.meta.total).toBe(1); // control
      await truncateAll(db);
      const res = await request.get('/lotes').set(ADM);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
    });

    it('es una lectura: no llama al catálogo ni a notificaciones y no cambia ningún lote', async () => {
      await sembrarVarios();
      const antes = await db('lotes').orderBy('id_lote');
      expect((await request.get('/lotes').set(ADM)).status).toBe(200);
      expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
      expect(clients.notificaciones.notificarStockBajo).not.toHaveBeenCalled();
      expect(await db('lotes').orderBy('id_lote')).toEqual(antes);
    });
  });

  describe('filtros', () => {
    beforeEach(sembrarVarios);

    // La consulta es una función porque los ids de las bodegas los fija el beforeEach de la suite.
    it.each([
      ['id_producto', () => ({ id_producto: 6 }), [5]],
      ['id_bodega', () => ({ id_bodega: b2 }), [7, 6]],
      ['vence_antes_de', () => ({ vence_antes_de: '2027-02-02' }), [5, 4, 1, 7, 2]],
      ['con_existencia=true', () => ({ con_existencia: 'true' }), [5, 4, 1, 6, 3]],
    ])('filtra por %s: solo sus lotes, del que vence primero al último, con meta.total de ese filtro', async (_filtro, query, esperados) => {
      const res = await request.get('/lotes').query(query()).set(ADM);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(esperados);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: esperados.length });
    });

    it('vence_antes_de es ESTRICTO: el lote que vence ese mismo día NO entra, el día anterior SÍ, y el que no tiene fecha NO entra nunca', async () => {
      /* El 31 de enero vencen los lotes 1 y 7; el 30, el 4. */
      const antes = (valor, extra = {}) => request.get('/lotes').query({ vence_antes_de: valor, ...extra }).set(ADM);
      expect(ids((await antes('2027-02-01')).body)).toEqual([5, 4, 1, 7]); // control: el 31 sí entra con el filtro del día siguiente
      expect(ids((await antes('2027-01-31')).body)).toEqual([5, 4]); // los dos del 31 quedan fuera
      expect(ids((await antes('2027-01-30')).body)).toEqual([5]); // el del 30 también
      expect(ids((await antes('2027-01-15')).body)).toEqual([]); // el único del 15 queda fuera
      expect((await antes('2027-01-15')).body.meta.total).toBe(0);
      const sinFiltro = await request.get('/lotes').set(ADM);
      expect(ids(sinFiltro.body)).toContain(3); // control: el lote sin fecha existe y aparece sin el filtro…
      expect(ids((await antes('9999-12-31')).body)).toEqual([5, 4, 1, 7, 2, 6]); // …pero NO con el filtro, ni con la fecha más lejana
      expect((await antes('9999-12-31', { con_existencia: 'true' })).body.datos.map((lote) => lote.fecha_vencimiento)).not.toContain(null);
    });

    it('con_existencia=true omite los lotes en 0; con false o sin el parámetro los lista (false no filtra)', async () => {
      expect(ids((await request.get('/lotes').query({ con_existencia: 'true' }).set(ADM)).body)).toEqual([5, 4, 1, 6, 3]);
      for (const query of [{}, { con_existencia: 'false' }]) {
        const res = await request.get('/lotes').query(query).set(ADM);
        expect({ query, ids: ids(res.body), total: res.body.meta.total }).toEqual({ query, ids: FEFO_DE_TODOS, total: 7 });
      }
      const ceros = (await request.get('/lotes').query({ con_existencia: 'false' }).set(ADM)).body.datos.filter((lote) => lote.cantidad_disponible === 0);
      expect(ceros.map((lote) => lote.id_lote)).toEqual([7, 2]);
    });

    it('la consulta de ms-reportes y ms-notificaciones (vence_antes_de y con_existencia=true) combina los dos: ni el vacío ni el del día', async () => {
      /* El 7 vence el 31 y está en 0; el 1 vence el 31 y tiene 5; el 2 vence el 1 de febrero y está en 0. */
      const res = await request.get('/lotes').query({ vence_antes_de: '2027-02-02', con_existencia: 'true' }).set(ADM);
      expect(ids(res.body)).toEqual([5, 4, 1]);
      expect(res.body.meta.total).toBe(3);
      expect(ids((await request.get('/lotes').query({ vence_antes_de: '2027-01-31', con_existencia: 'true' }).set(ADM)).body)).toEqual([5, 4]);
    });

    it('los filtros se combinan con AND y meta.total cuenta el filtro combinado, no el total de la tabla', async () => {
      const casos = [
        [{ id_producto: 5, id_bodega: b1 }, [4, 1, 2, 3]],
        [{ id_producto: 5, id_bodega: b2 }, [7, 6]],
        [{ id_producto: 5, id_bodega: b1, con_existencia: 'true' }, [4, 1, 3]],
        [{ id_producto: 5, id_bodega: b1, vence_antes_de: '2027-02-02', con_existencia: 'true' }, [4, 1]],
        [{ id_bodega: b2, vence_antes_de: '2027-02-01', con_existencia: 'false' }, [7]],
        [{ id_producto: 6, id_bodega: b2 }, []],
      ];
      for (const [query, esperados] of casos) {
        const res = await request.get('/lotes').query(query).set(ADM);
        expect({ query, ids: ids(res.body), total: res.body.meta.total }).toEqual({ query, ids: esperados, total: esperados.length });
      }
      // La paginación respeta el mismo filtro: con por_pagina=1 el total sigue siendo el del filtro.
      const pagina = await request.get('/lotes').query({ id_producto: 5, con_existencia: 'true', por_pagina: 1, pagina: 2 }).set(ADM);
      expect(ids(pagina.body)).toEqual([1]);
      expect(pagina.body.meta).toEqual({ pagina: 2, por_pagina: 1, total: 4 });
    });

    it('un filtro sin coincidencias → 200 con lista vacía y total 0 (el contrato no prevé 404); no se llama al catálogo', async () => {
      expect((await request.get('/lotes').query({ id_producto: 6 }).set(ADM)).body.meta.total).toBe(1); // control
      for (const query of [{ id_producto: 999 }, { id_bodega: 999 }, { vence_antes_de: '2000-01-01' }, { id_producto: 6, id_bodega: b2 }]) {
        const res = await request.get('/lotes').query(query).set(ADM);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
      }
      expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
    });
  });

  describe('paginación (la usa ms-reportes: pide por_pagina=100 y se detiene cuando pagina * por_pagina >= meta.total)', () => {
    // Recorre los lotes con la regla literal del consumidor. Corta si no termina, para que un fallo no cuelgue la prueba.
    async function recorrer(query, porPagina) {
      const paginas = [];
      for (let pagina = 1; pagina <= 20; pagina += 1) {
        const res = await request.get('/lotes').query({ ...query, pagina, por_pagina: porPagina }).set(ADM);
        expect(res.status).toBe(200);
        paginas.push(res.body);
        if (pagina * porPagina >= res.body.meta.total) return paginas;
      }
      throw new Error('El recorrido no termina: meta.total nunca alcanzó pagina * por_pagina');
    }

    // Los siete lotes de sembrarVarios (con empate de fecha entre los ids 1 y 7 y uno sin fecha). El UPDATE del 1 lo manda al
    // final del montón: sin el desempate por id_lote, el 7 saldría antes que el 1.
    beforeEach(async () => {
      await sembrarVarios();
      await db('lotes').where({ id_lote: 1 }).update({ cantidad_disponible: 5 });
    });

    it('un recorrido de TODAS las páginas de 2 en 2 reconstruye el conjunto exacto: sin repetidos, sin faltantes y en orden FEFO', async () => {
      const paginas = await recorrer({}, 2);
      expect(paginas.map((pagina) => pagina.datos.length)).toEqual([2, 2, 2, 1]);
      const recibidos = paginas.flatMap((pagina) => pagina.datos);
      const sembrados = await db('lotes');
      const esperados = FEFO_DE_TODOS.map((id) => sembrados.find((lote) => lote.id_lote === id));
      expect(recibidos).toEqual(esperados);
      expect(new Set(recibidos.map((lote) => lote.id_lote)).size).toBe(7);
    });

    it('meta.total es el de TODAS las filas del filtro (un número exacto) en cada página, y la meta repite pagina y por_pagina pedidas', async () => {
      const paginas = await recorrer({}, 2);
      expect(paginas.map((pagina) => pagina.meta)).toEqual([1, 2, 3, 4].map((pagina) => ({ pagina, por_pagina: 2, total: 7 })));
      for (const pagina of paginas) expect(typeof pagina.meta.total).toBe('number');
    });

    it('con la consulta de ms-reportes (vence_antes_de y con_existencia=true) el recorrido cubre solo las filas del filtro y el total no cambia', async () => {
      const paginas = await recorrer({ vence_antes_de: '2027-02-16', con_existencia: 'true' }, 2);
      expect(paginas.flatMap((pagina) => ids(pagina))).toEqual([5, 4, 1, 6]);
      expect(paginas.map((pagina) => pagina.meta.total)).toEqual([4, 4]);
    });

    it('por_pagina=100 (lo que pide ms-reportes) devuelve todo en una sola página', async () => {
      const res = await request.get('/lotes').query({ pagina: 1, por_pagina: 100 }).set(ADM);
      expect(ids(res.body)).toEqual(FEFO_DE_TODOS);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 100, total: 7 });
    });

    it('una página fuera de rango, aun la más grande que admite la validación, da datos vacíos y el total exacto (el desplazamiento no desborda)', async () => {
      expect((await request.get('/lotes').query({ pagina: 99, por_pagina: 4 }).set(ADM)).body).toEqual({ datos: [], meta: { pagina: 99, por_pagina: 4, total: 7 } });
      const enorme = await request.get('/lotes').query({ pagina: 2147483647, por_pagina: 100 }).set(ADM);
      expect(enorme.status).toBe(200);
      expect(enorme.body).toEqual({ datos: [], meta: { pagina: 2147483647, por_pagina: 100, total: 7 } });
    });
  });

  // fecha_vencimiento es una fecha SIN hora: viaja como el texto YYYY-MM-DD de la base y nunca como un Date (Ruling 15). Dos
  // pruebas: (1) la sesión de PostgreSQL en otro huso no cambia lo que se lee ni el filtro vence_antes_de (compara date con
  // date) y (2) el huso del proceso de Node tampoco: Jest aísla process.env, así que TZ solo se puede fijar al lanzar un proceso
  // hijo. Con el parser por defecto de `pg` (un Date a medianoche LOCAL), en Auckland (UTC+13) el 31 de enero se leería, al
  // serializarlo a JSON, como el 30.
  describe.each(['UTC', 'America/Bogota', 'Pacific/Auckland'])('con la sesión de PostgreSQL en %s', (zona) => {
    let dbZona;
    let requestZona;
    beforeAll(() => {
      dbZona = createTestDb(process.env, { zonaHoraria: zona });
      const app = createApp({ db: dbZona, clients: { catalogo: fakeCatalogo(), notificaciones: fakeNotificaciones() }, logger: { info() {}, error() {} }, env: entornoValido() });
      requestZona = supertest(app);
    });
    afterAll(() => dbZona.destroy());

    it('las fechas de vencimiento salen como texto y vence_antes_de da el mismo resultado que en UTC', async () => {
      await sembrar({ codigoLote: 'A', fechaVencimiento: '2027-01-31' });
      await sembrar({ codigoLote: 'B', fechaVencimiento: '2027-02-01' });
      await sembrar({ codigoLote: 'C', fechaVencimiento: null });
      // Control del arnés: la sesión de verdad está en esa zona.
      expect((await dbZona.raw('SHOW TimeZone')).rows[0].TimeZone).toBe(zona);
      const todos = await requestZona.get('/lotes').set(ADM);
      expect(todos.body.datos.map((lote) => lote.fecha_vencimiento)).toEqual(['2027-01-31', '2027-02-01', null]);
      for (const [vence, esperados] of [['2027-01-31', []], ['2027-02-01', [1]], ['2027-02-02', [1, 2]]]) {
        const res = await requestZona.get('/lotes').query({ vence_antes_de: vence }).set(ADM);
        expect({ zona, vence, ids: ids(res.body), total: res.body.meta.total }).toEqual({ zona, vence, ids: esperados, total: esperados.length });
      }
    });
  });

  describe.each(['UTC', 'America/Bogota', 'Pacific/Auckland'])('con el proceso de Node en %s (TZ)', (zona) => {
    it('el repositorio devuelve la fecha de vencimiento como el mismo texto YYYY-MM-DD y null, sin un Date', async () => {
      await sembrar({ codigoLote: 'A', fechaVencimiento: '2027-01-31' });
      await sembrar({ codigoLote: 'B', fechaVencimiento: null });
      const guion = `
        const raiz = process.argv[1];
        const { createTestDb } = require(raiz + '/tests/helpers/db');
        const loteRepository = require(raiz + '/src/repositories/loteRepository');
        (async () => {
          const db = createTestDb();
          try {
            const { filas } = await loteRepository.listar(db, { limit: 10, offset: 0 });
            // control: lo que daría un Date a medianoche local, serializado a JSON (el parser por defecto de pg)
            console.log(JSON.stringify({ zona: Intl.DateTimeFormat().resolvedOptions().timeZone, comoDate: new Date(2027, 0, 31).toISOString().slice(0, 10), filas }));
          } finally {
            await db.destroy();
          }
        })();
      `;
      const { stdout } = await ejecutar(process.execPath, ['-e', guion, RAIZ], { env: { ...process.env, TZ: zona }, encoding: 'utf8' });
      const { zona: zonaReal, comoDate, filas } = JSON.parse(stdout);
      expect(zonaReal).toBe(zona); // control del arnés: el proceso hijo de verdad corre en esa zona
      // En Auckland un Date a medianoche local caería en el 30 (en UTC y en Bogotá no se nota): ese es el fallo que se descarta.
      expect(comoDate).toBe(zona === 'Pacific/Auckland' ? '2027-01-30' : '2027-01-31');
      expect(filas.map((lote) => lote.fecha_vencimiento)).toEqual(['2027-01-31', null]);
    });
  });

  describe('validación de la consulta (422, nunca un 500)', () => {
    it.each([
      ['id_producto=abc', { id_producto: 'abc' }, ['id_producto']],
      ['id_bodega=0', { id_bodega: '0' }, ['id_bodega']],
      ['id_producto=2147483648 (más que el INTEGER)', { id_producto: '2147483648' }, ['id_producto']],
      ['vence_antes_de=2026-02-30 (un día que no existe)', { vence_antes_de: '2026-02-30' }, ['vence_antes_de']],
      ['vence_antes_de con hora', { vence_antes_de: '2026-11-01T00:00:00Z' }, ['vence_antes_de']],
      ['vence_antes_de vacía', { vence_antes_de: '' }, ['vence_antes_de']],
      ['con_existencia=si', { con_existencia: 'si' }, ['con_existencia']],
      ['con_existencia vacío', { con_existencia: '' }, ['con_existencia']],
      ['con_existencia=TRUE (se distingue mayúsculas)', { con_existencia: 'TRUE' }, ['con_existencia']],
      ['pagina=0', { pagina: '0' }, ['pagina']],
      ['por_pagina=101', { por_pagina: '101' }, ['por_pagina']],
      ['todos inválidos a la vez', { id_producto: 'x', id_bodega: 'y', vence_antes_de: 'a', con_existencia: 'b', pagina: '0', por_pagina: '500' },
        ['id_producto', 'id_bodega', 'vence_antes_de', 'con_existencia', 'pagina', 'por_pagina']],
    ])('%s → 422 con todos los parámetros inválidos', async (_descripcion, query, campos) => {
      // Control positivo: con todos los filtros bien escritos la consulta es válida.
      const valida = { id_producto: '5', id_bodega: '1', vence_antes_de: '2027-02-28', con_existencia: 'true', pagina: '1', por_pagina: '100' };
      expect((await request.get('/lotes').query(valida).set(ADM)).status).toBe(200);
      const res = await request.get('/lotes').query(query).set(ADM);
      datosNoValidos(res, campos);
      expect(res.body).not.toHaveProperty('datos');
    });
  });

  // Parámetros que el cliente puede escribir «raro»: repetidos, vacíos o con nombre extraño. Ninguno deja a un operador de bodega
  // fuera de su alcance. Siembra: b1 con 5 lotes (ids 1 a 5) y b2 con 2 (ids 6 y 7).
  describe('parámetros repetidos o con nombre raro (no esquivan el alcance del operador)', () => {
    beforeEach(sembrarVarios);

    const LLAMADORES = [
      ['un OPERADOR_BODEGA', () => headers('OPERADOR_BODEGA', { idBodega: b2 })],
      ['un ADMINISTRADOR', () => ADM],
    ];
    const INVALIDOS = [
      ['id_bodega repetido con una ajena primero', () => `id_bodega=${b1}&id_bodega=${b2}`, ['id_bodega']],
      ['id_bodega repetido con la propia primero', () => `id_bodega=${b2}&id_bodega=${b1}`, ['id_bodega']],
      ['id_bodega vacío', () => 'id_bodega=', ['id_bodega']],
      ['id_bodega con un espacio delante (%20)', () => `id_bodega=%20${b2}`, ['id_bodega']],
      ['id_producto repetido', () => 'id_producto=5&id_producto=6', ['id_producto']],
      ['vence_antes_de repetida', () => 'vence_antes_de=2027-01-01&vence_antes_de=2027-02-01', ['vence_antes_de']],
      ['con_existencia repetido', () => 'con_existencia=true&con_existencia=false', ['con_existencia']],
      ['pagina repetida', () => 'pagina=1&pagina=2', ['pagina']],
      ['id_bodega repetido y pagina inválida', () => `id_bodega=${b1}&id_bodega=${b2}&pagina=0`, ['id_bodega', 'pagina']],
    ];

    describe.each(LLAMADORES)('%s', (_nombre, cabeceras) => {
      it.each(INVALIDOS)('%s → 422 sobre los campos inválidos (no 403 ni 200), sin datos', async (_caso, consulta, campos) => {
        expect((await request.get('/lotes').set(cabeceras())).status).toBe(200); // control positivo
        const res = await request.get(`/lotes?${consulta()}`).set(cabeceras());
        datosNoValidos(res, campos);
        expect(res.body).not.toHaveProperty('datos');
      });
    });

    // Express 5 usa el analizador de consulta «simple»: un nombre con corchetes es OTRO parámetro y se ignora (200, sin filtro).
    const IGNORADOS = [
      ['id_bodega[] (corchetes)', () => `id_bodega[]=${b1}`],
      ['id_bodega[0] (índice)', () => `id_bodega[0]=${b1}`],
      ['ID_BODEGA (mayúsculas)', () => `ID_BODEGA=${b1}`],
      ['pagina[] (corchetes)', () => 'pagina[]=2'],
    ];

    it.each(IGNORADOS)('un operador que escribe %s sigue viendo SOLO su bodega: el nombre se ignora (200), no es 403 ni deja ver la ajena', async (_caso, consulta) => {
      const operador = headers('OPERADOR_BODEGA', { idBodega: b2 });
      esError(await request.get(`/lotes?id_bodega=${b1}`).set(operador), 403, 'SIN_PERMISO'); // control: la ajena, con el nombre bueno, sí es 403
      const res = await request.get(`/lotes?${consulta()}`).set(operador);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 2 });
      expect(new Set(res.body.datos.map((lote) => lote.id_bodega))).toEqual(new Set([b2]));
    });

    it.each(IGNORADOS)('el administrador que escribe %s no filtra: el nombre se ignora y ve los siete lotes', async (_caso, consulta) => {
      const res = await request.get(`/lotes?${consulta()}`).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 7 });
    });
  });

  describe('alcance por rol (restricción global 4: un operador nunca consulta otra bodega)', () => {
    beforeEach(sembrarVarios);
    const operador = (idBodega = b2) => headers('OPERADOR_BODEGA', { idBodega });

    it('el administrador ve cualquier bodega: con y sin id_bodega', async () => {
      const todos = await request.get('/lotes').set(ADM);
      expect(todos.status).toBe(200);
      expect(todos.body.meta.total).toBe(7);
      for (const [id, total] of [[b1, 5], [b2, 2]]) {
        const una = await request.get('/lotes').query({ id_bodega: id }).set(ADM);
        expect(una.status).toBe(200);
        expect(una.body.meta.total).toBe(total);
        expect(una.body.datos.every((lote) => lote.id_bodega === id)).toBe(true);
      }
    });

    it('un operador sin id_bodega ve SOLO su bodega, y meta.total cuenta solo lo suyo (no revela cuántos lotes hay en total)', async () => {
      const res = await request.get('/lotes').set(operador());
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 2 });
      expect(ids(res.body)).toEqual([7, 6]);
      expect(ids((await request.get('/lotes').set(operador(b1))).body)).toEqual([5, 4, 1, 2, 3]);
    });

    it('los demás filtros no amplían el alcance de un operador: con producto, fecha o existencia sigue viendo solo su bodega', async () => {
      const res = await request.get('/lotes').query({ id_producto: 5, vence_antes_de: '2027-12-31', con_existencia: 'false' }).set(operador());
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([7, 6]);
      expect(res.body.meta.total).toBe(2);
    });

    it('un operador que pide su propia bodega la ve; si pide otra → 403 SIN_PERMISO sin datos', async () => {
      const propia = await request.get('/lotes').query({ id_bodega: b2 }).set(operador());
      expect(propia.status).toBe(200);
      expect(propia.body.meta.total).toBe(2);
      for (const ajena of [b1, 999]) {
        const res = await request.get('/lotes').query({ id_bodega: ajena }).set(operador());
        esError(res, 403, 'SIN_PERMISO');
        expect(res.body).not.toHaveProperty('datos');
      }
    });

    it('un operador sin X-User-Bodega → 403 SIN_PERMISO, con y sin id_bodega', async () => {
      const sinBodega = headers('OPERADOR_BODEGA');
      expect(sinBodega).not.toHaveProperty('X-User-Bodega');
      expect((await request.get('/lotes').set(operador())).status).toBe(200); // control: con bodega asignada sí consulta
      esError(await request.get('/lotes').set(sinBodega), 403, 'SIN_PERMISO');
      esError(await request.get('/lotes').query({ id_bodega: b1 }).set(sinBodega), 403, 'SIN_PERMISO');
    });

    it('un operador con un parámetro inválido recibe 422 (la validación va antes que el alcance)', async () => {
      expect((await request.get('/lotes').query({ id_bodega: b2 }).set(operador())).status).toBe(200); // control
      datosNoValidos(await request.get('/lotes').query({ id_bodega: 'x' }).set(operador()), ['id_bodega']);
      datosNoValidos(await request.get('/lotes').query({ id_bodega: b1, pagina: '0' }).set(operador()), ['pagina']);
    });
  });

  describe('lecturas sin X-User-Id (llamadas internas válidas, D8: ms-notificaciones y ms-reportes)', () => {
    it('sin cabeceras de identidad ve todos los lotes (y los filtra igual); con una cabecera de identidad inválida la lectura sí es 401', async () => {
      await sembrarVarios();
      const res = await request.get('/lotes');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(7);
      const consulta = await request.get('/lotes').query({ vence_antes_de: '2027-02-02', con_existencia: 'true' });
      expect(ids(consulta.body)).toEqual([5, 4, 1]);
      esError(await request.get('/lotes').set({ 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
    });
  });

  describe('no espera a los movimientos en curso (una consulta no toma ni espera bloqueos de fila)', () => {
    it('con los lotes del par bloqueados FOR UPDATE por otra transacción, el listado responde igual y de inmediato, también filtrado por ese par', async () => {
      await sembrarVarios();
      await conLotesBloqueados(async () => {
        for (const query of [{}, { id_producto: 5, id_bodega: b1, con_existencia: 'true' }]) {
          const pendiente = request.get('/lotes').query(query).set(ADM).then((res) => res);
          const res = await Promise.race([pendiente, plazo(2000)]);
          expect(res).not.toBe(AGOTADO); // si falla, el finally libera los candados y la petición termina sola
          expect(res.status).toBe(200);
          expect(res.body.meta.total).toBe(query.id_producto === undefined ? 7 : 3);
        }
      });
    });
  });

  describe('un fallo de la base (500)', () => {
    // La base «rota» lanza en el primer acceso: simula una caída de PostgreSQL sin tocar la base de pruebas.
    const dbRota = () => {
      throw new Error('secreto-de-la-base: password authentication failed');
    };

    it.each([['/lotes'], ['/lotes?id_producto=5&vence_antes_de=2027-01-01&con_existencia=true']])(
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

  describe('rutas que no existen en lotes', () => {
    it.each([
      ['POST', '/lotes'],
      ['PUT', '/lotes'],
      ['DELETE', '/lotes'],
      ['GET', '/lotes/1'],
      ['PUT', '/lotes/1'],
      ['DELETE', '/lotes/1'],
    ])('%s %s → 404 NO_EXISTE (los lotes nacen y cambian con los movimientos: no hay alta, edición ni consulta por id)', async (metodo, ruta) => {
      expect((await request.get('/lotes').set(ADM)).status).toBe(200); // control
      rutaNoExiste(await request[metodo.toLowerCase()](ruta).set(ADM));
    });
  });
});
