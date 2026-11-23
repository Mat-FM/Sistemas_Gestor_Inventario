const supertest = require('supertest');
const { createApp } = require('../src/app');
const { TIPOS } = require('../src/domain/tipos');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearMovimiento, fakeCatalogo, fakeNotificaciones, headers } = require('./helpers/fixtures');
const { ISO_8601, datosNoValidos, esError, recursoNoExiste, rutaNoExiste } = require('./helpers/respuestas');

// El kardex (RF10, RF15): las dos lecturas de movimientos de la Tabla 9 de la Entrega 2, GET /movimientos y GET /movimientos/{id},
// de punta a punta contra PostgreSQL real. Los movimientos se SIEMBRAN con Knex y con la `fecha` explícita (crearMovimiento): estas
// pruebas no dependen del motor de stock, salvo la de integración, que crea con POST /movimientos y lee con la API. Las capas por
// separado (repositorio y servicio) están en movimientosCapas.test.js y la lista de rutas en routes.test.js.

const ADM = headers('ADMINISTRADOR');
// Los roles que ven el kardex de cualquier bodega. El VENDEDOR no: el kardex es de ADMINISTRADOR, CONTADOR y OPERADOR_BODEGA (D37).
const ROLES = ['ADMINISTRADOR', 'CONTADOR'];
const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];
// Una clave que no debe aparecer jamás en una respuesta, ni su nombre ni su valor.
const CLAVE_SECRETA = 'secreto-clave-centinela';

let request;
let db;
let clients;
let b1;
let b2;
let b3;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp());
});
beforeEach(async () => {
  await truncateAll(db);
  [b1, b2, b3] = [(await crearBodega(db, { codigo: 'B1' })).id_bodega, (await crearBodega(db, { codigo: 'B2' })).id_bodega, (await crearBodega(db, { codigo: 'B3' })).id_bodega];
  clients.catalogo.obtenerProducto.mockClear();
});
afterAll(() => db.destroy());

// Lo que debe devolver la API para una fila sembrada: sin la clave de idempotencia y con la fecha como texto ISO 8601.
const comoApi = ({ clave_idempotencia: _clave, ...resto }) => ({ ...resto, fecha: resto.fecha.toISOString() });
const ids = (cuerpo) => cuerpo.datos.map((movimiento) => movimiento.id_movimiento);

// Siembra D29: cuatro movimientos pegados a las medianoches UTC del 1 y el 2 de noviembre de 2026, de más viejo a más nuevo
// (ids 1 a 4). Un filtro que dependiera del huso de la sesión de PostgreSQL movería la frontera de los cuatro.
const FECHAS_LIMITE = ['2026-10-31T23:59:59.999Z', '2026-11-01T00:00:00Z', '2026-11-01T23:59:59.999Z', '2026-11-02T00:00:00Z'];
async function sembrarLimites() {
  // En serie: los ids (1 a 4) deben seguir el orden de las fechas.
  for (const [k, fecha] of FECHAS_LIMITE.entries()) await crearMovimiento(db, { idBodega: b1, fecha, claveIdempotencia: `limite-${k}` });
}

describe('GET /movimientos', () => {
  describe('el listado', () => {
    it('lista del más reciente al más antiguo con el envoltorio paginado y exactamente los 13 campos de un Movimiento', async () => {
      // Insertados en un orden distinto al de las fechas: ordenar por id (asc o desc) o por fecha ascendente daría otra secuencia.
      const medio = await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-02T10:00:00Z', tipo: 'SALIDA', cantidad: 4, saldoResultante: 6, documentoReferencia: 'FAC-9', observacion: 'Venta' });
      const viejo = await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T10:00:00Z', cantidad: 10, saldoResultante: 10 });
      const nuevo = await crearMovimiento(db, { idBodega: b2, idProducto: 6, fecha: '2026-11-03T10:00:00Z', tipo: 'AJUSTE', cantidad: -2, saldoResultante: 8, idUsuario: 12 });
      const res = await request.get('/movimientos').set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
      expect(ids(res.body)).toEqual([nuevo.id_movimiento, medio.id_movimiento, viejo.id_movimiento]);
      expect(res.body.datos).toEqual([comoApi(nuevo), comoApi(medio), comoApi(viejo)]);
      for (const movimiento of res.body.datos) expect(Object.keys(movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
    });

    it('los tipos son los del contrato: ids, cantidad y saldo_resultante como NÚMEROS, fecha ISO 8601 en UTC y null donde no hay dato', async () => {
      const lote = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L-1', cantidad: 3 });
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T10:00:00Z', idLote: lote.id_lote, cantidad: 3, saldoResultante: 3 });
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T11:00:00Z', tipo: 'AJUSTE', cantidad: -1, saldoResultante: 2 });
      const [sinLote, conLote] = (await request.get('/movimientos').set(ADM)).body.datos;
      for (const campo of ['id_movimiento', 'id_producto', 'id_bodega', 'id_usuario', 'cantidad', 'saldo_resultante']) {
        expect(typeof sinLote[campo]).toBe('number');
        expect(typeof conLote[campo]).toBe('number');
      }
      expect(sinLote).toMatchObject({ cantidad: -1, saldo_resultante: 2, id_lote: null, id_traslado: null, id_conteo: null, documento_referencia: null, observacion: null });
      expect(conLote).toMatchObject({ id_lote: lote.id_lote, cantidad: 3 });
      expect(typeof conLote.id_lote).toBe('number');
      expect(sinLote.fecha).toMatch(ISO_8601);
      expect(sinLote.fecha).toBe('2026-11-01T11:00:00.000Z');
    });

    it('sin movimientos → {datos: [], meta: {pagina: 1, por_pagina: 20, total: 0}}, con total numérico', async () => {
      await crearMovimiento(db, { idBodega: b1 });
      expect((await request.get('/movimientos').set(ADM)).body.meta.total).toBe(1); // control
      await truncateAll(db);
      const res = await request.get('/movimientos').set(ADM);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
    });

    it('con la misma fecha, el desempate es id_movimiento DESCENDENTE: el orden es estable y las páginas no repiten ni saltan filas', async () => {
      const mismaFecha = '2026-11-02T10:00:00Z';
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T10:00:00Z' }); // id 1, más viejo
      for (let k = 0; k < 4; k += 1) await crearMovimiento(db, { idBodega: b1, fecha: mismaFecha }); // ids 2 a 5: empatados
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-03T10:00:00Z' }); // id 6, más nuevo
      const todos = await request.get('/movimientos').set(ADM);
      expect(ids(todos.body)).toEqual([6, 5, 4, 3, 2, 1]);
      const paginas = [];
      for (const pagina of [1, 2, 3]) paginas.push(ids((await request.get('/movimientos').query({ pagina, por_pagina: 2 }).set(ADM)).body));
      expect(paginas).toEqual([[6, 5], [4, 3], [2, 1]]);
    });

    it('nunca devuelve clave_idempotencia, ni su nombre ni su valor, aunque la fila la tenga', async () => {
      await crearMovimiento(db, { idBodega: b1, claveIdempotencia: CLAVE_SECRETA });
      expect((await db('movimientos').first()).clave_idempotencia).toBe(CLAVE_SECRETA); // control: la columna existe y guarda el valor
      const res = await request.get('/movimientos').set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.datos).toHaveLength(1);
      expect(res.text).not.toMatch(/clave_idempotencia|centinela/);
    });

    it('?tipo acepta cada uno de los nueve tipos como filtro, incluidos los que POST /movimientos no admite', async () => {
      for (const tipo of TIPOS) await crearMovimiento(db, { idBodega: b1, tipo, cantidad: tipo === 'AJUSTE' ? -1 : 1 });
      expect((await request.get('/movimientos').set(ADM)).body.meta.total).toBe(9); // control
      for (const tipo of TIPOS) {
        const res = await request.get('/movimientos').query({ tipo }).set(ADM);
        expect({ tipo, estado: res.status, tipos: res.body.datos.map((movimiento) => movimiento.tipo), total: res.body.meta.total }).toEqual({ tipo, estado: 200, tipos: [tipo], total: 1 });
      }
    });

    it('es una lectura: no llama al catálogo ni a notificaciones', async () => {
      await crearMovimiento(db, { idBodega: b1 });
      expect((await request.get('/movimientos').set(ADM)).status).toBe(200);
      expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
      expect(clients.notificaciones.notificarStockBajo).not.toHaveBeenCalled();
    });
  });

  describe('filtros', () => {
    // Seis movimientos que se distinguen en cada filtro (ids 1 a 6, con fechas crecientes).
    beforeEach(async () => {
      await crearMovimiento(db, { idBodega: b1, idProducto: 5, idUsuario: 7, tipo: 'ENTRADA', fecha: '2026-11-01T10:00:00Z' }); // 1
      await crearMovimiento(db, { idBodega: b1, idProducto: 5, idUsuario: 8, tipo: 'SALIDA', fecha: '2026-11-02T10:00:00Z' }); // 2
      await crearMovimiento(db, { idBodega: b1, idProducto: 6, idUsuario: 7, tipo: 'SALIDA', fecha: '2026-11-03T10:00:00Z' }); // 3
      await crearMovimiento(db, { idBodega: b2, idProducto: 5, idUsuario: 7, tipo: 'ENTRADA', fecha: '2026-11-04T10:00:00Z' }); // 4
      await crearMovimiento(db, { idBodega: b2, idProducto: 6, idUsuario: 9, tipo: 'AJUSTE', cantidad: -1, fecha: '2026-11-05T10:00:00Z' }); // 5
      await crearMovimiento(db, { idBodega: b3, idProducto: 7, idUsuario: 8, tipo: 'ENTRADA', fecha: '2026-11-06T10:00:00Z' }); // 6
    });

    // La consulta es una función porque los ids de las bodegas los fija el beforeEach de la suite.
    it.each([
      ['id_producto', () => ({ id_producto: 5 }), [4, 2, 1]],
      ['id_bodega', () => ({ id_bodega: b2 }), [5, 4]],
      ['id_usuario', () => ({ id_usuario: 7 }), [4, 3, 1]],
      ['tipo', () => ({ tipo: 'ENTRADA' }), [6, 4, 1]],
    ])('filtra por %s: solo sus movimientos, del más reciente al más antiguo, con meta.total de ese filtro', async (_filtro, query, esperados) => {
      const res = await request.get('/movimientos').query(query()).set(ADM);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(esperados);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: esperados.length });
    });

    it('un filtro sin coincidencias → 200 con lista vacía y total 0 (el contrato no prevé 404); no se llama al catálogo', async () => {
      expect((await request.get('/movimientos').query({ id_producto: 5 }).set(ADM)).body.meta.total).toBe(3); // control
      for (const query of [{ id_producto: 999 }, { id_bodega: 999 }, { id_usuario: 999 }, { tipo: 'CARGA_INICIAL' }, { id_producto: 7, id_bodega: b1 }]) {
        const res = await request.get('/movimientos').query(query).set(ADM);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
      }
      expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
    });

    it('los filtros se combinan con AND y meta.total cuenta el filtro combinado, no el total de la tabla', async () => {
      const casos = [
        [{ id_producto: 5, id_bodega: b1 }, [2, 1]],
        [{ id_producto: 5, id_usuario: 7 }, [4, 1]],
        [{ id_bodega: b1, tipo: 'SALIDA' }, [3, 2]],
        [{ id_producto: 5, id_bodega: b1, id_usuario: 7, tipo: 'ENTRADA' }, [1]],
        [{ id_producto: 6, id_bodega: b2, id_usuario: 9, tipo: 'AJUSTE', fecha_desde: '2026-11-05', fecha_hasta: '2026-11-05' }, [5]],
        [{ id_producto: 5, fecha_desde: '2026-11-02', fecha_hasta: '2026-11-04' }, [4, 2]],
      ];
      for (const [query, esperados] of casos) {
        const res = await request.get('/movimientos').query(query).set(ADM);
        expect({ query, ids: ids(res.body), total: res.body.meta.total }).toEqual({ query, ids: esperados, total: esperados.length });
      }
      // La paginación respeta el mismo filtro: con por_pagina=1 el total sigue siendo el del filtro.
      const pagina = await request.get('/movimientos').query({ id_producto: 5, por_pagina: 1, pagina: 2 }).set(ADM);
      expect(ids(pagina.body)).toEqual([2]);
      expect(pagina.body.meta).toEqual({ pagina: 2, por_pagina: 1, total: 3 });
    });
  });

  describe('fecha_desde y fecha_hasta: días UTC (D29)', () => {
    it.each([
      ['fecha_desde=2026-11-01 incluye el 1 de noviembre desde las 00:00:00 UTC', { fecha_desde: '2026-11-01' }, [4, 3, 2]],
      ['fecha_hasta=2026-11-01 incluye TODO el 1 de noviembre (hasta las 23:59:59.999 UTC) y no el día siguiente', { fecha_hasta: '2026-11-01' }, [3, 2, 1]],
      ['fecha_desde=fecha_hasta=2026-11-01 es exactamente ese día', { fecha_desde: '2026-11-01', fecha_hasta: '2026-11-01' }, [3, 2]],
      ['fecha_desde=2026-11-02 deja fuera el 1 de noviembre', { fecha_desde: '2026-11-02' }, [4]],
      ['fecha_hasta=2026-10-31 incluye el último milisegundo del 31 de octubre', { fecha_hasta: '2026-10-31' }, [1]],
      ['un rango sin movimientos → vacío y total 0', { fecha_desde: '2026-11-03' }, []],
      ['un rango anterior a todo → vacío y total 0', { fecha_hasta: '2026-10-30' }, []],
    ])('%s', async (_caso, query, esperados) => {
      await sembrarLimites();
      const res = await request.get('/movimientos').query(query).set(ADM);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(esperados);
      expect(res.body.meta.total).toBe(esperados.length);
    });

    // La invariancia que pide D29: los MISMOS cuatro movimientos dan el MISMO resultado con la sesión de PostgreSQL en UTC, en
    // Bogotá (UTC−5) y en Auckland (UTC+13 en noviembre). Cada app usa un pool cuyas conexiones llevan esa zona.
    describe.each(['UTC', 'America/Bogota', 'Pacific/Auckland'])('con la sesión de PostgreSQL en %s', (zona) => {
      let dbZona;
      let requestZona;
      beforeAll(() => {
        dbZona = createTestDb(process.env, { zonaHoraria: zona });
        const app = createApp({ db: dbZona, clients: { catalogo: fakeCatalogo(), notificaciones: fakeNotificaciones() }, logger: { info() {}, error() {} }, env: entornoValido() });
        requestZona = supertest(app);
      });
      afterAll(() => dbZona.destroy());

      it('los cuatro movimientos de la frontera dan el mismo resultado que en UTC', async () => {
        await sembrarLimites();
        // Control del arnés: la sesión de verdad está en esa zona, y las lecturas de la fecha no cambian.
        expect((await dbZona.raw('SHOW TimeZone')).rows[0].TimeZone).toBe(zona);
        const casos = [
          [{ fecha_desde: '2026-11-01' }, [4, 3, 2]],
          [{ fecha_hasta: '2026-11-01' }, [3, 2, 1]],
          [{ fecha_desde: '2026-11-01', fecha_hasta: '2026-11-01' }, [3, 2]],
          [{ fecha_desde: '2026-11-02' }, [4]],
          [{ fecha_hasta: '2026-10-31' }, [1]],
          [{ fecha_desde: '2026-11-02', fecha_hasta: '2026-11-02' }, [4]],
          [{}, [4, 3, 2, 1]],
        ];
        for (const [query, esperados] of casos) {
          const res = await requestZona.get('/movimientos').query(query).set(ADM);
          expect({ zona, query, estado: res.status, ids: ids(res.body), total: res.body.meta?.total }).toEqual({ zona, query, estado: 200, ids: esperados, total: esperados.length });
        }
      });
    });

    it('control del arnés: con `fecha >= ?::date` el resultado SÍ cambia con el huso de la sesión (por eso se prueban dos husos)', async () => {
      await sembrarLimites();
      const contar = async (zona) => {
        const conexion = createTestDb(process.env, { zonaHoraria: zona });
        try {
          const { rows: [{ n }] } = await conexion.raw('SELECT count(*) AS n FROM movimientos WHERE fecha >= ?::date', ['2026-11-01']);
          return n;
        } finally {
          await conexion.destroy();
        }
      };
      // La medianoche del 1 de noviembre en Bogotá son las 05:00Z (deja fuera al movimiento de las 00:00Z) y en Auckland, las 11:00Z del 31 (mete uno más).
      expect([await contar('America/Bogota'), await contar('UTC'), await contar('Pacific/Auckland')]).toEqual([2, 3, 4]);
    });

    it('las fechas extremas del calendario que acepta el validador no dan un 500 (0001-01-01 y 9999-12-31)', async () => {
      await sembrarLimites();
      const res = await request.get('/movimientos').query({ fecha_desde: '0001-01-01', fecha_hasta: '9999-12-31' }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(4);
      expect((await request.get('/movimientos').query({ fecha_desde: '9999-12-31' }).set(ADM)).body.meta.total).toBe(0);
      expect((await request.get('/movimientos').query({ fecha_hasta: '0001-01-01' }).set(ADM)).body.meta.total).toBe(0);
    });
  });

  describe('paginación (la usa ms-reportes: pide por_pagina=100 y se detiene cuando pagina * por_pagina >= meta.total)', () => {
    // Recorre el kardex con la regla literal del consumidor. Corta si no termina, para que un fallo no cuelgue la prueba.
    async function recorrer(query, porPagina) {
      const paginas = [];
      for (let pagina = 1; pagina <= 20; pagina += 1) {
        const res = await request.get('/movimientos').query({ ...query, pagina, por_pagina: porPagina }).set(ADM);
        expect(res.status).toBe(200);
        paginas.push(res.body);
        if (pagina * porPagina >= res.body.meta.total) return paginas;
      }
      throw new Error('El recorrido no termina: meta.total nunca alcanzó pagina * por_pagina');
    }

    // Siete movimientos con empates de fecha (ids 1-2 y 4-6 comparten fecha) insertados sin ningún orden especial.
    const FECHAS = ['2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z', '2026-11-02T10:00:00Z', '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z', '2026-11-04T10:00:00Z'];
    let sembrados;
    beforeEach(async () => {
      sembrados = [];
      for (const fecha of FECHAS) sembrados.push(await crearMovimiento(db, { idBodega: b1, idProducto: 5, fecha }));
    });

    it('un recorrido de TODAS las páginas de 2 en 2 reconstruye el conjunto exacto: sin repetidos, sin faltantes y en orden', async () => {
      const paginas = await recorrer({}, 2);
      expect(paginas.map((pagina) => pagina.datos.length)).toEqual([2, 2, 2, 1]);
      const recibidos = paginas.flatMap((pagina) => pagina.datos);
      const esperados = [...sembrados].sort((a, b) => b.fecha - a.fecha || b.id_movimiento - a.id_movimiento).map(comoApi);
      expect(recibidos).toEqual(esperados);
      expect(new Set(recibidos.map((movimiento) => movimiento.id_movimiento)).size).toBe(7);
    });

    it('meta.total es el de TODAS las filas del filtro (un número exacto) en cada página, y la meta repite pagina y por_pagina pedidas', async () => {
      const paginas = await recorrer({}, 2);
      expect(paginas.map((pagina) => pagina.meta)).toEqual([1, 2, 3, 4].map((pagina) => ({ pagina, por_pagina: 2, total: 7 })));
      for (const pagina of paginas) expect(typeof pagina.meta.total).toBe('number');
    });

    it('con filtros el recorrido cubre solo las filas del filtro y el total no cambia de una página a otra', async () => {
      await crearMovimiento(db, { idBodega: b2, idProducto: 6, fecha: '2026-11-05T10:00:00Z' });
      const paginas = await recorrer({ id_producto: 5, fecha_desde: '2026-11-03' }, 2);
      expect(paginas.flatMap((pagina) => ids(pagina))).toEqual([7, 6, 5, 4]);
      expect(paginas.map((pagina) => pagina.meta.total)).toEqual([4, 4]);
    });

    it('por_pagina=100 (lo que pide ms-reportes) devuelve todo en una sola página', async () => {
      const res = await request.get('/movimientos').query({ pagina: 1, por_pagina: 100 }).set(ADM);
      expect(res.body.datos).toHaveLength(7);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 100, total: 7 });
    });

    it('una página fuera de rango, aun la más grande que admite la validación, da datos vacíos y el total exacto (el desplazamiento no desborda)', async () => {
      const normal = await request.get('/movimientos').query({ pagina: 99, por_pagina: 4 }).set(ADM);
      expect(normal.body).toEqual({ datos: [], meta: { pagina: 99, por_pagina: 4, total: 7 } });
      const enorme = await request.get('/movimientos').query({ pagina: 2147483647, por_pagina: 100 }).set(ADM);
      expect(enorme.status).toBe(200);
      expect(enorme.body).toEqual({ datos: [], meta: { pagina: 2147483647, por_pagina: 100, total: 7 } });
    });
  });

  describe('validación de la consulta (422, nunca un 500)', () => {
    it.each([
      ['id_producto=abc', { id_producto: 'abc' }, ['id_producto']],
      ['id_bodega=0', { id_bodega: '0' }, ['id_bodega']],
      ['id_usuario=-1', { id_usuario: '-1' }, ['id_usuario']],
      ['id_usuario=2147483648 (más que el INTEGER)', { id_usuario: '2147483648' }, ['id_usuario']],
      ['tipo desconocido', { tipo: 'TRASLADO' }, ['tipo']],
      ['tipo vacío', { tipo: '' }, ['tipo']],
      ['tipo en minúsculas', { tipo: 'entrada' }, ['tipo']],
      ['fecha_desde=2026-02-30 (un día que no existe)', { fecha_desde: '2026-02-30' }, ['fecha_desde']],
      ['fecha_hasta=2026-2-3 (sin ceros)', { fecha_hasta: '2026-2-3' }, ['fecha_hasta']],
      ['fecha_desde con hora', { fecha_desde: '2026-11-01T00:00:00Z' }, ['fecha_desde']],
      ['fecha_hasta vacía', { fecha_hasta: '' }, ['fecha_hasta']],
      ['fecha_desde posterior a fecha_hasta', { fecha_desde: '2026-11-02', fecha_hasta: '2026-11-01' }, ['fecha_desde']],
      ['pagina=0', { pagina: '0' }, ['pagina']],
      ['por_pagina=101', { por_pagina: '101' }, ['por_pagina']],
      ['todos inválidos a la vez', { id_producto: 'x', id_bodega: 'y', id_usuario: 'z', tipo: 'Q', fecha_desde: 'a', fecha_hasta: 'b', pagina: '0', por_pagina: '500' },
        ['id_producto', 'id_bodega', 'id_usuario', 'tipo', 'fecha_desde', 'fecha_hasta', 'pagina', 'por_pagina']],
    ])('%s → 422 con todos los parámetros inválidos', async (_descripcion, query, campos) => {
      // Control positivo: con todos los filtros bien escritos, y con fecha_desde = fecha_hasta, la consulta es válida.
      const valida = { id_producto: '5', id_bodega: '1', id_usuario: '7', tipo: 'ENTRADA', fecha_desde: '2026-11-01', fecha_hasta: '2026-11-01', pagina: '1', por_pagina: '100' };
      expect((await request.get('/movimientos').query(valida).set(ADM)).status).toBe(200);
      const res = await request.get('/movimientos').query(query).set(ADM);
      datosNoValidos(res, campos);
      expect(res.body).not.toHaveProperty('datos');
    });

    it('con una fecha mal escrita se informa esa fecha y no el rango', async () => {
      expect((await request.get('/movimientos').query({ fecha_desde: '2026-01-01', fecha_hasta: '2026-01-02' }).set(ADM)).status).toBe(200); // control
      datosNoValidos(await request.get('/movimientos').query({ fecha_desde: '2026-02-30', fecha_hasta: '2026-01-01' }).set(ADM), ['fecha_desde']);
    });
  });

  // Parámetros que el cliente puede escribir «raro»: repetidos, vacíos o con nombre extraño. Ninguno deja a un operador de bodega
  // fuera de su alcance. Siembra el caso de la bodega b1 (2 movimientos), b2 (3) y b3 (1).
  describe('parámetros repetidos o con nombre raro (no esquivan el alcance del operador)', () => {
    beforeEach(async () => {
      for (const idBodega of [b1, b1, b2, b2, b2, b3]) await crearMovimiento(db, { idBodega, fecha: '2026-11-01T10:00:00Z' });
    });

    const LLAMADORES = [
      ['un OPERADOR_BODEGA', () => headers('OPERADOR_BODEGA', { idBodega: b2 })],
      ['un ADMINISTRADOR', () => ADM],
    ];

    // Cada caso es una cadena de consulta escrita a mano (así se ve exactamente lo que viaja) y los campos inválidos que informa.
    const INVALIDOS = [
      ['id_bodega repetido con una ajena primero', () => `id_bodega=${b1}&id_bodega=${b2}`, ['id_bodega']],
      ['id_bodega repetido con la propia primero', () => `id_bodega=${b2}&id_bodega=${b1}`, ['id_bodega']],
      ['id_bodega vacío', () => 'id_bodega=', ['id_bodega']],
      ['id_bodega con un espacio delante (%20)', () => `id_bodega=%20${b2}`, ['id_bodega']],
      ['id_producto repetido', () => 'id_producto=5&id_producto=6', ['id_producto']],
      ['id_usuario repetido', () => 'id_usuario=7&id_usuario=8', ['id_usuario']],
      ['tipo repetido', () => 'tipo=ENTRADA&tipo=SALIDA', ['tipo']],
      ['fecha_desde repetida', () => 'fecha_desde=2026-11-01&fecha_desde=2026-11-02', ['fecha_desde']],
      ['fecha_hasta repetida', () => 'fecha_hasta=2026-11-01&fecha_hasta=2026-11-02', ['fecha_hasta']],
      ['pagina repetida', () => 'pagina=1&pagina=2', ['pagina']],
      ['id_bodega repetido y pagina inválida', () => `id_bodega=${b1}&id_bodega=${b2}&pagina=0`, ['id_bodega', 'pagina']],
    ];

    describe.each(LLAMADORES)('%s', (_nombre, cabeceras) => {
      it.each(INVALIDOS)('%s → 422 sobre los campos inválidos (no 403 ni 200), sin datos', async (_caso, consulta, campos) => {
        expect((await request.get('/movimientos').set(cabeceras())).status).toBe(200); // control positivo
        const res = await request.get(`/movimientos?${consulta()}`).set(cabeceras());
        datosNoValidos(res, campos);
        expect(res.body).not.toHaveProperty('datos');
      });
    });

    // Express 5 usa el analizador de consulta «simple»: un nombre con corchetes es OTRO parámetro y se ignora (200, sin filtro).
    // Si alguien activara el analizador extendido, `id_bodega[]=x` llegaría como arreglo o como objeto y estas pruebas avisan.
    const IGNORADOS = [
      ['id_bodega[] (corchetes)', () => `id_bodega[]=${b1}`],
      ['id_bodega[0] (índice)', () => `id_bodega[0]=${b1}`],
      ['ID_BODEGA (mayúsculas)', () => `ID_BODEGA=${b1}`],
      ['pagina[] (corchetes)', () => 'pagina[]=2'],
      ['tipo[] (corchetes)', () => 'tipo[]=SALIDA'],
      ['fecha_desde[] (corchetes)', () => 'fecha_desde[]=2030-01-01'],
    ];

    it.each(IGNORADOS)('un operador que escribe %s sigue viendo SOLO su bodega: el nombre se ignora (200), no es 403 ni deja ver la ajena', async (_caso, consulta) => {
      const operador = headers('OPERADOR_BODEGA', { idBodega: b2 });
      esError(await request.get(`/movimientos?id_bodega=${b1}`).set(operador), 403, 'SIN_PERMISO'); // control: la ajena, con el nombre bueno, sí es 403
      const res = await request.get(`/movimientos?${consulta()}`).set(operador);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
      expect(new Set(res.body.datos.map((movimiento) => movimiento.id_bodega))).toEqual(new Set([b2]));
    });

    it.each(IGNORADOS)('el administrador que escribe %s no filtra: el nombre se ignora y ve las seis filas', async (_caso, consulta) => {
      const res = await request.get(`/movimientos?${consulta()}`).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 6 });
    });
  });

  describe('alcance por rol (restricción global 4: un operador nunca consulta otra bodega)', () => {
    // b1: ids 1 y 2 (producto 5); b2: ids 3, 4 y 5; b3: id 6.
    beforeEach(async () => {
      for (const [idBodega, tipo] of [[b1, 'ENTRADA'], [b1, 'SALIDA'], [b2, 'ENTRADA'], [b2, 'ENTRADA'], [b2, 'SALIDA'], [b3, 'ENTRADA']]) {
        await crearMovimiento(db, { idBodega, tipo, fecha: '2026-11-01T10:00:00Z' });
      }
    });
    const operador = (idBodega = b2) => headers('OPERADOR_BODEGA', { idBodega });

    it.each(ROLES)('un %s ve cualquier bodega: con y sin id_bodega', async (rol) => {
      const todos = await request.get('/movimientos').set(headers(rol));
      expect(todos.status).toBe(200);
      expect(todos.body.meta.total).toBe(6);
      for (const [id, total] of [[b1, 2], [b2, 3], [b3, 1]]) {
        const una = await request.get('/movimientos').query({ id_bodega: id }).set(headers(rol));
        expect(una.status).toBe(200);
        expect(una.body.meta.total).toBe(total);
        expect(una.body.datos.every((movimiento) => movimiento.id_bodega === id)).toBe(true);
      }
    });

    it('la llamada interna sin X-User-Id (ms-reportes, D8) ve todo', async () => {
      const res = await request.get('/movimientos');
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 6 });
      expect((await request.get('/movimientos').query({ id_bodega: b3 })).body.datos).toHaveLength(1);
    });

    it('un operador sin id_bodega ve SOLO su bodega, y meta.total cuenta solo lo suyo (no revela cuántos hay en total)', async () => {
      const res = await request.get('/movimientos').set(operador());
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
      expect(ids(res.body)).toEqual([5, 4, 3]);
    });

    it('los demás filtros no amplían el alcance de un operador: con tipo, producto, usuario o fechas sigue viendo solo su bodega', async () => {
      const res = await request.get('/movimientos').query({ tipo: 'ENTRADA', id_producto: 5, id_usuario: 7, fecha_desde: '2026-11-01', fecha_hasta: '2026-11-01' }).set(operador());
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([4, 3]);
      expect(res.body.meta.total).toBe(2);
    });

    it('un operador que pide su propia bodega la ve; si pide otra → 403 SIN_PERMISO sin datos', async () => {
      const propia = await request.get('/movimientos').query({ id_bodega: b2 }).set(operador());
      expect(propia.status).toBe(200);
      expect(propia.body.meta.total).toBe(3);
      for (const ajena of [b1, b3, 999]) {
        const res = await request.get('/movimientos').query({ id_bodega: ajena }).set(operador());
        esError(res, 403, 'SIN_PERMISO');
        expect(res.body).not.toHaveProperty('datos');
      }
    });

    it('un operador sin X-User-Bodega → 403 SIN_PERMISO, con y sin id_bodega', async () => {
      const sinBodega = headers('OPERADOR_BODEGA');
      expect(sinBodega).not.toHaveProperty('X-User-Bodega');
      expect((await request.get('/movimientos').set(operador())).status).toBe(200); // control: con bodega asignada sí consulta
      esError(await request.get('/movimientos').set(sinBodega), 403, 'SIN_PERMISO');
      esError(await request.get('/movimientos').query({ id_bodega: b1 }).set(sinBodega), 403, 'SIN_PERMISO');
    });

    it('un operador con un parámetro inválido recibe 422 (la validación va antes que el alcance)', async () => {
      expect((await request.get('/movimientos').query({ id_bodega: b2 }).set(operador())).status).toBe(200); // control
      datosNoValidos(await request.get('/movimientos').query({ id_bodega: 'x' }).set(operador()), ['id_bodega']);
    });
  });

  describe('lecturas sin X-User-Id (llamadas internas válidas, D8)', () => {
    it('sin cabeceras de identidad → 200; con una cabecera de identidad inválida la lectura sí es 401 (nunca se ignora en silencio)', async () => {
      await crearMovimiento(db, { idBodega: b1 });
      const res = await request.get('/movimientos');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      esError(await request.get('/movimientos').set({ 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
    });
  });

  describe('integración con POST /movimientos', () => {
    it('un movimiento creado con la API aparece en el kardex con el mismo id_movimiento, fecha y saldo_resultante; el filtro por usuario lo encuentra', async () => {
      const crear = (cuerpo, clave, idUsuario) => request.post('/movimientos').set(headers('ADMINISTRADOR', { idUsuario })).set('Idempotency-Key', clave).send(cuerpo);
      const entrada = await crear({ tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, cantidad: 10, documento_referencia: 'FAC-1' }, 'k1', 12);
      const salida = await crear({ tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 4 }, 'k2', 13);
      expect([entrada.status, salida.status]).toEqual([201, 201]);

      const kardex = await request.get('/movimientos').set(ADM);
      expect(kardex.body.datos).toEqual([salida.body, entrada.body]); // el más reciente primero, idénticos a lo que respondió el POST
      expect(kardex.body.datos.map((movimiento) => movimiento.saldo_resultante)).toEqual([6, 10]);
      expect(kardex.body.meta.total).toBe(2);
      expect((await request.get('/movimientos').query({ id_usuario: 12 }).set(ADM)).body.datos).toEqual([entrada.body]);
      expect((await request.get(`/movimientos/${salida.body.id_movimiento}`).set(ADM)).body).toEqual(salida.body);
    });
  });
});

describe('GET /movimientos/{id}', () => {
  // b1: ids 1 y 2; b2: id 3.
  let m;
  beforeEach(async () => {
    m = [
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T10:00:00Z', cantidad: 10, saldoResultante: 10, documentoReferencia: 'FAC-1', observacion: 'Compra', claveIdempotencia: CLAVE_SECRETA }),
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-02T10:00:00Z', tipo: 'AJUSTE', cantidad: -3, saldoResultante: 7, idUsuario: 12 }),
      await crearMovimiento(db, { idBodega: b2, fecha: '2026-11-03T10:00:00Z', idProducto: 6 }),
    ];
  });
  const operador = (idBodega) => headers('OPERADOR_BODEGA', { idBodega });

  it('→ 200 con el Movimiento exacto: sus 13 campos, con números, fecha ISO 8601 y nulos, y sin clave_idempotencia', async () => {
    const res = await request.get(`/movimientos/${m[0].id_movimiento}`).set(ADM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(comoApi(m[0]));
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
    expect(res.body).toMatchObject({ id_movimiento: 1, id_lote: null, id_traslado: null, id_conteo: null, cantidad: 10, saldo_resultante: 10, documento_referencia: 'FAC-1' });
    expect(res.text).not.toMatch(/clave_idempotencia|centinela/);
    const ajuste = (await request.get(`/movimientos/${m[1].id_movimiento}`).set(ADM)).body;
    expect(ajuste).toMatchObject({ tipo: 'AJUSTE', cantidad: -3, saldo_resultante: 7, id_usuario: 12, documento_referencia: null, observacion: null });
    expect(ajuste.fecha).toMatch(ISO_8601);
  });

  it('es el mismo objeto que el del listado', async () => {
    const lista = (await request.get('/movimientos').set(ADM)).body.datos;
    for (const movimiento of lista) {
      expect((await request.get(`/movimientos/${movimiento.id_movimiento}`).set(ADM)).body).toEqual(movimiento);
    }
  });

  it('un id que no existe → 404 NO_EXISTE de recurso (no de ruta)', async () => {
    expect((await request.get('/movimientos/3').set(ADM)).status).toBe(200); // control
    recursoNoExiste(await request.get('/movimientos/4').set(ADM));
    recursoNoExiste(await request.get('/movimientos/999').set(ADM));
  });

  it.each(['0', '-1', '1.5', 'abc', '01', '1e2', '%20', '2147483648'])('el id %s no es un id posible → 404 NO_EXISTE (no 422 ni 500)', async (id) => {
    expect((await request.get('/movimientos/1').set(ADM)).status).toBe(200); // control
    recursoNoExiste(await request.get(`/movimientos/${id}`).set(ADM));
  });

  it('un id inválido o fuera del INTEGER no llega a la base', async () => {
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta.sql);
    db.on('query', registrar);
    try {
      await request.get('/movimientos/2147483648').set(ADM);
      await request.get('/movimientos/abc').set(ADM);
      expect(consultas).toEqual([]);
      await request.get('/movimientos/1').set(ADM); // control: un id posible sí consulta
      expect(consultas.length).toBeGreaterThan(0);
    } finally {
      db.removeListener('query', registrar);
    }
  });

  it('el id más alto del INTEGER (2147483647) es un id posible: 404 porque no existe, sin error de la base', async () => {
    recursoNoExiste(await request.get('/movimientos/2147483647').set(ADM));
  });

  it.each(ROLES)('un %s lo ve aunque sea de cualquier bodega', async (rol) => {
    for (const { id_movimiento: id } of m) expect((await request.get(`/movimientos/${id}`).set(headers(rol))).status).toBe(200);
  });

  it('la llamada interna sin X-User-Id lo ve; con una cabecera de identidad inválida es 401', async () => {
    expect((await request.get('/movimientos/1')).status).toBe(200);
    esError(await request.get('/movimientos/1').set({ 'X-User-Id': '0', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
  });

  it('un operador ve un movimiento de SU bodega (200) y uno de OTRA bodega → 403 SIN_PERMISO sin datos', async () => {
    expect((await request.get('/movimientos/1').set(operador(b1))).status).toBe(200); // control
    const ajeno = await request.get('/movimientos/3').set(operador(b1));
    esError(ajeno, 403, 'SIN_PERMISO');
    expect(ajeno.text).not.toMatch(/id_producto|cantidad/);
    expect((await request.get('/movimientos/3').set(operador(b2))).status).toBe(200);
    expect((await request.get('/movimientos/1').set(operador(b2))).status).toBe(403);
  });

  it('un operador sin X-User-Bodega → 403 SIN_PERMISO, existan o no el movimiento', async () => {
    const sinBodega = headers('OPERADOR_BODEGA');
    expect((await request.get('/movimientos/1').set(operador(b1))).status).toBe(200); // control: con bodega asignada sí lo ve
    esError(await request.get('/movimientos/1').set(sinBodega), 403, 'SIN_PERMISO');
    esError(await request.get('/movimientos/999').set(sinBodega), 403, 'SIN_PERMISO');
  });

  it('un operador pide un movimiento que no existe → 404 (no 403)', async () => {
    expect((await request.get('/movimientos/1').set(operador(b1))).status).toBe(200); // control: uno de su bodega sí existe
    recursoNoExiste(await request.get('/movimientos/999').set(operador(b1)));
  });

  it('es una lectura: no llama al catálogo', async () => {
    expect((await request.get('/movimientos/1').set(ADM)).status).toBe(200);
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
  });
});

describe('un fallo de la base (500)', () => {
  // La base «rota» lanza en el primer acceso: simula una caída de PostgreSQL sin tocar la base de pruebas.
  const dbRota = () => {
    throw new Error('secreto-de-la-base: password authentication failed');
  };

  it.each([['/movimientos'], ['/movimientos?id_producto=5&fecha_desde=2026-11-01'], ['/movimientos/1']])(
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

describe('rutas que no existen en movimientos', () => {
  it.each([
    ['PUT', '/movimientos'],
    ['DELETE', '/movimientos'],
    ['POST', '/movimientos/1'],
    ['PUT', '/movimientos/1'],
    ['DELETE', '/movimientos/1'],
    ['GET', '/movimientos/1/detalle'],
  ])('%s %s → 404 NO_EXISTE (un movimiento del kardex no se edita ni se borra)', async (metodo, ruta) => {
    expect((await request.get('/movimientos').set(ADM)).status).toBe(200); // control
    rutaNoExiste(await request[metodo.toLowerCase()](ruta).set(ADM));
  });
});
