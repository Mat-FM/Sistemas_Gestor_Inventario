const knex = require('knex');
const supertest = require('supertest');
const { createApp } = require('../src/app');
const { construirConfigKnex } = require('../src/config/db');
const { delta } = require('../src/domain/tipos');
const bodegaRepository = require('../src/repositories/bodegaRepository');
const conteoRepository = require('../src/repositories/conteoRepository');
const conteoService = require('../src/services/conteoService');
const { OPERACIONES, claveAlmacenada } = require('../src/services/idempotencia');
const movimientoService = require('../src/services/movimientoService');
const stockService = require('../src/services/stockService');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { configDePrueba, truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearSaldo, crearUmbral, headers } = require('./helpers/fixtures');
const { ISO_8601, esError, datosNoValidos, recursoNoExiste, stockInsuficiente } = require('./helpers/respuestas');

// Conteos físicos (RF18) de punta a punta, contra PostgreSQL real y con clientes falsos: POST /conteos (programar), GET /conteos
// (listado), GET /conteos/{id}, PUT /conteos/{id}/detalles (registrar lo contado) y POST /conteos/{id}/aprobacion (aprobar: un
// AJUSTE por cada diferencia). Las capas por separado están en conteosCapas.test.js.
//
// El reloj del servicio está FIJADO (`now` inyectado, D32(g)): ninguna prueba depende del día en que corre ni falla a medianoche.
//
// Tras CADA prueba se comprueban en la base los invariantes de un conteo: uno APROBADO tiene fecha_aprobacion, id_usuario_aprueba
// y clave_aprobacion, y exactamente un AJUSTE por cada línea contada con diferencia ≠ 0 (de esa misma diferencia); uno que no
// está APROBADO no tiene ni clave ni movimientos. Nunca un conteo aprobado sin sus ajustes, ni ajustes sin conteo aprobado.

const ADM = headers('ADMINISTRADOR');
const OPE = (idBodega, idUsuario = 8) => headers('OPERADOR_BODEGA', { idUsuario, idBodega });
const CLAVES_CONTEO = ['id_conteo', 'id_bodega', 'estado', 'fecha_programada', 'fecha_aprobacion', 'id_usuario_aprueba', 'detalles'];
const CLAVES_RESUMEN = CLAVES_CONTEO.filter((clave) => clave !== 'detalles');
const CLAVES_DETALLE = ['id_detalle_conteo', 'id_producto', 'cantidad_sistema', 'cantidad_contada', 'diferencia'];

// Reloj fijo: 15 de noviembre de 2026 a mediodía UTC. Una prueba puede moverlo; beforeEach lo repone.
const MEDIODIA = '2026-11-15T12:00:00Z';
let reloj;

let request;
let db;
let clients;
let b1;
let b2;
let b3;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp({ now: () => reloj }));
});
beforeEach(async () => {
  reloj = new Date(MEDIODIA);
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
  b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
  b3 = (await crearBodega(db, { codigo: 'B3' })).id_bodega;
  clients.catalogo.obtenerProducto.mockClear();
  clients.notificaciones.notificarStockBajo.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await comprobarInvariantes();
});
afterAll(() => db.destroy());

async function comprobarInvariantes() {
  const { rows: incoherentes } = await db.raw(`
    SELECT c.id_conteo, c.estado
    FROM conteos c
    WHERE (c.estado = 'APROBADO') <> (c.fecha_aprobacion IS NOT NULL AND c.id_usuario_aprueba IS NOT NULL AND c.clave_aprobacion IS NOT NULL)
       OR (c.estado <> 'APROBADO' AND EXISTS (SELECT 1 FROM movimientos m WHERE m.id_conteo = c.id_conteo))
       OR (c.estado = 'APROBADO' AND (
            (SELECT COUNT(*) FROM detalles_conteo d WHERE d.id_conteo = c.id_conteo AND d.cantidad_contada IS NOT NULL AND d.diferencia <> 0)
            <> (SELECT COUNT(*) FROM movimientos m WHERE m.id_conteo = c.id_conteo)
         OR EXISTS (
            SELECT 1 FROM movimientos m
            LEFT JOIN detalles_conteo d ON d.id_conteo = m.id_conteo AND d.id_producto = m.id_producto
            WHERE m.id_conteo = c.id_conteo
              AND (m.tipo <> 'AJUSTE' OR m.id_bodega <> c.id_bodega OR d.diferencia IS DISTINCT FROM m.cantidad))))`);
  expect(incoherentes).toEqual([]);
  const { rows: lotesRotos } = await db.raw(`
    SELECT l.id_producto, l.id_bodega
    FROM lotes l LEFT JOIN saldos s ON s.id_producto = l.id_producto AND s.id_bodega = l.id_bodega
    GROUP BY l.id_producto, l.id_bodega
    HAVING SUM(l.cantidad_disponible) > COALESCE(MAX(s.cantidad_disponible), 0) OR MIN(l.cantidad_disponible) < 0`);
  expect(lotesRotos).toEqual([]);
}

// POST /conteos con las cabeceras dadas.
const programar = (cuerpo, cabeceras = ADM) => request.post('/conteos').set(cabeceras).send(cuerpo);
const cuerpoConteo = (extra = {}) => ({ id_bodega: b1, fecha_programada: '2026-11-20', ids_producto: [5], ...extra });
const obtener = (id, cabeceras = ADM) => request.get(`/conteos/${id}`).set(cabeceras);

// Foto de lo que un rechazo no debe cambiar.
const foto = async () => ({
  conteos: await db('conteos').select('*').orderBy('id_conteo'),
  detalles: await db('detalles_conteo').select('*').orderBy('id_detalle_conteo'),
  saldos: await db('saldos').select('*').orderBy('id_saldo'),
  movimientos: await db('movimientos').select('*').orderBy('id_movimiento'),
});

// Control positivo antes de un rechazo: un conteo válido que debe dar 201 (y se borra para no ensuciar la foto del rechazo).
async function control(cuerpo = cuerpoConteo(), cabeceras = ADM) {
  const res = await programar(cuerpo, cabeceras);
  expect(res.status).toBe(201);
  await db('conteos').where({ id_conteo: res.body.id_conteo }).del();
  return res.body;
}

// ---------------------------------------------------------------------------------------------------------------------------
// POST /conteos
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /conteos: programación (201)', () => {
  it('con ids_producto: 201 PROGRAMADO con exactamente los campos de un Conteo, una línea por producto ordenada por id_producto, cantidad_sistema = saldo actual (0 sin saldo) y contada y diferencia en null', async () => {
    /* RF18, D32(f)(i): el saldo de OTRA bodega no cuenta; nada cambia en saldos ni en el kardex. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 3, idBodega: b1, cantidad: 4 });
    await crearSaldo(db, { idProducto: 7, idBodega: b2, cantidad: 99 });
    const antes = await foto();
    const res = await programar(cuerpoConteo({ ids_producto: [7, 5, 3] }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES_CONTEO].sort());
    expect(res.body).toEqual({
      id_conteo: 1, id_bodega: b1, estado: 'PROGRAMADO', fecha_programada: '2026-11-20', fecha_aprobacion: null, id_usuario_aprueba: null,
      detalles: [
        { id_detalle_conteo: expect.any(Number), id_producto: 3, cantidad_sistema: 4, cantidad_contada: null, diferencia: null },
        { id_detalle_conteo: expect.any(Number), id_producto: 5, cantidad_sistema: 10, cantidad_contada: null, diferencia: null },
        { id_detalle_conteo: expect.any(Number), id_producto: 7, cantidad_sistema: 0, cantidad_contada: null, diferencia: null },
      ],
    });
    for (const linea of res.body.detalles) expect(Object.keys(linea).sort()).toEqual([...CLAVES_DETALLE].sort());
    const despues = await foto();
    expect(despues.saldos).toEqual(antes.saldos);
    expect(despues.movimientos).toEqual([]);
    expect(despues.conteos).toEqual([expect.objectContaining({ id_conteo: 1, clave_aprobacion: null })]);
    // No llama al catálogo (el contrato no lo pide) ni a notificaciones.
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
    expect(clients.notificaciones.notificarStockBajo).not.toHaveBeenCalled();
  });

  it('sin ids_producto (o con null): las líneas son SOLO los productos con cantidad_disponible > 0 en ESA bodega (D32(f))', async () => {
    /* Un saldo en 0 no entra por omisión; los de otra bodega tampoco. */
    await crearSaldo(db, { idProducto: 8, idBodega: b1, cantidad: 2 });
    await crearSaldo(db, { idProducto: 3, idBodega: b1, cantidad: 4 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    await crearSaldo(db, { idProducto: 9, idBodega: b2, cantidad: 5 });
    for (const cuerpo of [{ id_bodega: b1, fecha_programada: '2026-11-20' }, { id_bodega: b1, fecha_programada: '2026-11-20', ids_producto: null }]) {
      const res = await programar(cuerpo);
      expect(res.status).toBe(201);
      expect(res.body.detalles.map(({ id_producto: id, cantidad_sistema: sistema }) => [id, sistema])).toEqual([[3, 4], [8, 2]]);
    }
  });

  it('con ids_producto explícito entra cualquier producto, aunque su saldo sea 0 o no exista (cantidad_sistema 0)', async () => {
    /* D32(f). */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    const res = await programar(cuerpoConteo({ ids_producto: [6, 5] }));
    expect(res.status).toBe(201);
    expect(res.body.detalles.map((l) => [l.id_producto, l.cantidad_sistema])).toEqual([[5, 0], [6, 0]]);
  });

  it('los campos que fija el servidor se ignoran (id_conteo, estado, fecha_aprobacion, id_usuario_aprueba, detalles, clave_aprobacion)', async () => {
    /* Un conteo siempre nace PROGRAMADO. */
    const res = await programar(cuerpoConteo({
      id_conteo: 77, estado: 'APROBADO', fecha_aprobacion: '2026-11-01T00:00:00Z', id_usuario_aprueba: 3, clave_aprobacion: 'x',
      detalles: [{ id_producto: 9, cantidad_sistema: 1 }],
    }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id_conteo: 1, estado: 'PROGRAMADO', fecha_aprobacion: null, id_usuario_aprueba: null });
    expect(res.body.detalles.map((l) => l.id_producto)).toEqual([5]);
    expect((await db('conteos').first()).clave_aprobacion).toBeNull();
  });
});

describe('POST /conteos: fecha_programada y el reloj (D29, D32(g))', () => {
  it('pasada (ayer) → 422 sobre "fecha_programada" sin escribir; hoy → 201; mañana → 201', async () => {
    /* «hoy» se acepta; el día lo da el reloj inyectado, no el día real. */
    const antes = await foto();
    datosNoValidos(await programar(cuerpoConteo({ fecha_programada: '2026-11-14' })), ['fecha_programada']);
    expect(await foto()).toEqual(antes);
    expect((await programar(cuerpoConteo({ fecha_programada: '2026-11-15' }))).status).toBe(201);
    expect((await programar(cuerpoConteo({ fecha_programada: '2026-11-16' }))).status).toBe(201);
  });

  it('el día es el UTC y no el local: con el reloj en 2026-11-15T23:30:00-05:00 (ya el 16 en UTC) el 15 es pasado y el 16 es hoy, aunque el proceso corra en Bogotá', async () => {
    /* D29: todos los servicios usan UTC. El huso del proceso se fuerza a Bogotá para que la regla local (el 15) se distinga. */
    const zonaOriginal = process.env.TZ;
    process.env.TZ = 'America/Bogota';
    try {
      reloj = new Date('2026-11-15T23:30:00-05:00');
      expect(reloj.getDate()).toBe(15); // control: en el huso local todavía es el 15
      datosNoValidos(await programar(cuerpoConteo({ fecha_programada: '2026-11-15' })), ['fecha_programada']);
      const hoy = await programar(cuerpoConteo({ fecha_programada: '2026-11-16' }));
      expect(hoy.status).toBe(201);
      expect(hoy.body.fecha_programada).toBe('2026-11-16');
    } finally {
      if (zonaOriginal === undefined) delete process.env.TZ;
      else process.env.TZ = zonaOriginal;
    }
  });

  it('el reloj se lee en CADA petición: al avanzar un día, la fecha que antes era hoy pasa a ser pasada', async () => {
    /* Nada del reloj se fija al arrancar. */
    await control(cuerpoConteo({ fecha_programada: '2026-11-15' }));
    reloj = new Date('2026-11-16T00:00:00Z');
    datosNoValidos(await programar(cuerpoConteo({ fecha_programada: '2026-11-15' })), ['fecha_programada']);
  });

  it('una fecha que no existe en el calendario → 422 (la regla es la de validate.fecha)', async () => {
    /* Un caso inválido y su control; la matriz completa está en validate.test.js. */
    await control();
    datosNoValidos(await programar(cuerpoConteo({ fecha_programada: '2026-02-30' })), ['fecha_programada']);
  });
});

describe('POST /conteos: bodega, líneas y validación', () => {
  it('bodega inexistente → 404 NO_EXISTE; inactiva → 409 BODEGA_INACTIVA (D12); nada se escribe', async () => {
    /* Control: la bodega activa. */
    await control();
    await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
    const antes = await foto();
    recursoNoExiste(await programar(cuerpoConteo({ id_bodega: 9999 })));
    esError(await programar(cuerpoConteo({ id_bodega: b2 })), 409, 'BODEGA_INACTIVA');
    expect(await foto()).toEqual(antes);
  });

  it('sin ids_producto en una bodega SIN existencias → 422 sobre "ids_producto" y no queda conteo (ni líneas)', async () => {
    /* D32(f): un conteo sin líneas no sirve. Control: con existencias sí se crea. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    await crearSaldo(db, { idProducto: 6, idBodega: b2, cantidad: 3 });
    expect((await programar({ id_bodega: b2, fecha_programada: '2026-11-20' })).status).toBe(201);
    const antes = await foto();
    datosNoValidos(await programar({ id_bodega: b1, fecha_programada: '2026-11-20' }), ['ids_producto']);
    expect(await foto()).toEqual(antes);
  });

  it('ids_producto vacío → 422 (decisión: una lista vacía explícita no significa «todos»)', async () => {
    /* Control: la lista con un producto. */
    await control();
    datosNoValidos(await programar(cuerpoConteo({ ids_producto: [] })), ['ids_producto']);
  });

  it('ids_producto con un id repetido → 422 sobre la posición repetida; con un id que no es un entero positivo → 422 sobre esa posición', async () => {
    /* D32(f). */
    await control(cuerpoConteo({ ids_producto: [5, 6] }));
    datosNoValidos(await programar(cuerpoConteo({ ids_producto: [5, 6, 5] })), ['ids_producto[2]']);
    datosNoValidos(await programar(cuerpoConteo({ ids_producto: [5, '6'] })), ['ids_producto[1]']);
    datosNoValidos(await programar(cuerpoConteo({ ids_producto: '5' })), ['ids_producto']);
  });

  it('informa a la vez todos los campos inválidos, en el orden del contrato; un cuerpo que no es un objeto → 422 sobre "cuerpo"', async () => {
    /* Nunca un 5xx por un tipo equivocado. */
    datosNoValidos(await programar({ id_bodega: 'b1', fecha_programada: 20261120, ids_producto: [0] }), ['id_bodega', 'fecha_programada', 'ids_producto[0]']);
    datosNoValidos(await programar([cuerpoConteo()]), ['cuerpo']);
    datosNoValidos(await programar({}), ['id_bodega', 'fecha_programada']);
  });

  it('sin X-User-Id → 401 NO_AUTENTICADO y nada se escribe', async () => {
    /* D8, D22: toda escritura guarda su autor. */
    await control();
    const res = await request.post('/conteos').send(cuerpoConteo());
    esError(res, 401, 'NO_AUTENTICADO');
    expect(await db('conteos')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// GET /conteos/{id}
// ---------------------------------------------------------------------------------------------------------------------------

describe('GET /conteos/{id}', () => {
  let creado;
  beforeEach(async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 6 });
    const res = await programar(cuerpoConteo({ id_bodega: b2, ids_producto: [9, 5] }));
    expect(res.status).toBe(201);
    creado = res.body;
  });

  it('200 con el conteo y sus líneas (ordenadas por id_producto), igual a lo que devolvió la programación; nunca clave_aprobacion', async () => {
    /* D32(i). */
    const res = await obtener(creado.id_conteo);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(creado);
    expect(res.body.detalles.map((l) => l.id_producto)).toEqual([5, 9]);
    expect(JSON.stringify(res.body)).not.toMatch(/clave/);
  });

  it.each([['inexistente', '9999'], ['0', '0'], ['-1', '-1'], ['abc', 'abc'], ['fuera del INTEGER', '2147483648']])('id %s → 404 NO_EXISTE', async (_caso, id) => {
    /* idRuta: nunca llega a la base un id inválido. */
    recursoNoExiste(await obtener(id));
  });

  it('OPERADOR de la bodega del conteo → 200; de otra bodega → 403; sin X-User-Bodega → 403', async () => {
    /* D32(h): alcance sobre la bodega DEL CONTEO. */
    expect((await obtener(creado.id_conteo, OPE(b2))).status).toBe(200);
    esError(await obtener(creado.id_conteo, OPE(b1)), 403, 'SIN_PERMISO');
    esError(await obtener(creado.id_conteo, headers('OPERADOR_BODEGA')), 403, 'SIN_PERMISO');
  });

  it('una llamada interna sin X-User-Id (D8) lo ve', async () => {
    /* Las lecturas son válidas sin usuario. */
    const res = await request.get(`/conteos/${creado.id_conteo}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(creado);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// GET /conteos
// ---------------------------------------------------------------------------------------------------------------------------

describe('GET /conteos: listado', () => {
  // Siembra un conteo DIRECTAMENTE en la base (el listado no depende de la programación). Un APROBADO lleva lo que exige el
  // invariante (fecha, usuario y clave) y no tiene líneas, así que no necesita ajustes.
  async function sembrar({ idBodega, estado = 'PROGRAMADO', fecha }) {
    const aprobado = estado === 'APROBADO';
    const [fila] = await db('conteos').insert({
      id_bodega: idBodega, estado, fecha_programada: fecha,
      fecha_aprobacion: aprobado ? '2026-11-10T10:00:00Z' : null, id_usuario_aprueba: aprobado ? 7 : null,
      clave_aprobacion: aprobado ? `7:con:s-${fecha}-${idBodega}` : null,
    }).returning('id_conteo');
    await db('detalles_conteo').insert({ id_conteo: fila.id_conteo, id_producto: 5, cantidad_sistema: 1 });
    return fila.id_conteo;
  }
  const listar = (consulta = '', cabeceras = ADM) => request.get(`/conteos${consulta}`).set(cabeceras);
  const ids = (res) => res.body.datos.map((c) => c.id_conteo);

  let c;
  beforeEach(async () => {
    // c3 y c4 comparten fecha (desempata id_conteo DESC); el orden de inserción no es el de las fechas.
    c = {};
    c.c1 = await sembrar({ idBodega: b1, fecha: '2026-11-20' });
    c.c2 = await sembrar({ idBodega: b2, fecha: '2026-11-18', estado: 'EN_REVISION' });
    c.c3 = await sembrar({ idBodega: b1, fecha: '2026-11-22', estado: 'APROBADO' });
    c.c4 = await sembrar({ idBodega: b3, fecha: '2026-11-22' });
    c.c5 = await sembrar({ idBodega: b2, fecha: '2026-11-25', estado: 'APROBADO' });
    c.c6 = await sembrar({ idBodega: b1, fecha: '2026-11-17', estado: 'EN_REVISION' });
  });

  it('sin filtros: {datos, meta} con todos, por fecha_programada DESC e id_conteo DESC, cada uno SIN detalles (solo el resumen)', async () => {
    /* D32(i): el listado es un resumen; el detalle está en GET /conteos/{id}. */
    const res = await listar();
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([c.c5, c.c4, c.c3, c.c1, c.c2, c.c6]);
    expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 6 });
    for (const fila of res.body.datos) expect(Object.keys(fila).sort()).toEqual([...CLAVES_RESUMEN].sort());
    expect(res.body.datos.find((f) => f.id_conteo === c.c3)).toEqual({
      id_conteo: c.c3, id_bodega: b1, estado: 'APROBADO', fecha_programada: '2026-11-22', fecha_aprobacion: '2026-11-10T10:00:00.000Z', id_usuario_aprueba: 7,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/clave/);
  });

  it('?estado filtra con el total exacto; un estado inválido o en minúsculas → 422', async () => {
    /* Los tres estados del esquema. */
    const revision = await listar('?estado=EN_REVISION');
    expect(ids(revision)).toEqual([c.c2, c.c6]);
    expect(revision.body.meta.total).toBe(2);
    expect(ids(await listar('?estado=APROBADO'))).toEqual([c.c5, c.c3]);
    expect(ids(await listar('?estado=PROGRAMADO'))).toEqual([c.c4, c.c1]);
    datosNoValidos(await listar('?estado=aprobado'), ['estado']);
  });

  it('?id_bodega filtra y se combina con estado (AND), con el total del filtro', async () => {
    /* Control y filtro combinado. */
    expect(ids(await listar(`?id_bodega=${b1}`))).toEqual([c.c3, c.c1, c.c6]);
    const combinado = await listar(`?id_bodega=${b1}&estado=EN_REVISION`);
    expect(ids(combinado)).toEqual([c.c6]);
    expect(combinado.body.meta.total).toBe(1);
    expect((await listar('?id_bodega=9999')).body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
  });

  it('recorrido completo de 4 en 4: sin repetidos ni faltantes y el total de TODAS las filas en cada página; fuera de rango → vacía con el total', async () => {
    /* ms-reportes recorre hasta pagina * por_pagina >= total. */
    const vistos = [];
    for (const pagina of [1, 2]) {
      const res = await listar(`?pagina=${pagina}&por_pagina=4`);
      expect(res.body.meta).toEqual({ pagina, por_pagina: 4, total: 6 });
      vistos.push(...ids(res));
    }
    expect(vistos).toEqual([c.c5, c.c4, c.c3, c.c1, c.c2, c.c6]);
    expect((await listar('?pagina=3&por_pagina=4')).body).toEqual({ datos: [], meta: { pagina: 3, por_pagina: 4, total: 6 } });
    datosNoValidos(await listar('?por_pagina=101'), ['por_pagina']);
  });

  it('OPERADOR: sin id_bodega ve SOLO los de su bodega con el total de ESA bodega; con la suya también; con otra → 403; sin X-User-Bodega → 403', async () => {
    /* D32(h). */
    const propia = await listar('', OPE(b2));
    expect(ids(propia)).toEqual([c.c5, c.c2]);
    expect(propia.body.meta.total).toBe(2);
    expect(ids(await listar(`?id_bodega=${b2}&estado=APROBADO`, OPE(b2)))).toEqual([c.c5]);
    esError(await listar(`?id_bodega=${b1}`, OPE(b2)), 403, 'SIN_PERMISO');
    esError(await listar('', headers('OPERADOR_BODEGA')), 403, 'SIN_PERMISO');
  });

  it('OPERADOR: id_bodega repetido o vacío → 422; ID_BODEGA o id_bodega[] (que Express no reconoce) NO amplían su alcance', async () => {
    /* Un parámetro ignorado deja el filtro por omisión: su bodega. */
    datosNoValidos(await listar(`?id_bodega=${b2}&id_bodega=${b1}`, OPE(b2)), ['id_bodega']);
    datosNoValidos(await listar('?id_bodega=', OPE(b2)), ['id_bodega']);
    for (const consulta of [`?ID_BODEGA=${b1}`, `?id_bodega[]=${b1}`, `?id_bodega%5B%5D=${b1}`]) {
      const res = await listar(consulta, OPE(b2));
      expect({ consulta, estado: res.status, ids: ids(res) }).toEqual({ consulta, estado: 200, ids: [c.c5, c.c2] });
    }
  });

  it('una llamada interna SIN X-User-Id (D8) y el ADMINISTRADOR (también con una X-User-Bodega) ven todos', async () => {
    /* Las lecturas son válidas sin usuario. */
    const interna = await request.get('/conteos');
    expect(interna.status).toBe(200);
    expect(interna.body.meta.total).toBe(6);
    expect((await listar('', headers('ADMINISTRADOR', { idBodega: b1 }))).body.meta.total).toBe(6);
  });

  it('refleja la programación por la API: el conteo nuevo aparece PROGRAMADO con el mismo resumen que su detalle', async () => {
    /* De punta a punta. */
    const { detalles, ...resumen } = (await programar(cuerpoConteo({ fecha_programada: '2026-12-01' }))).body;
    expect(detalles).toHaveLength(1);
    const res = await listar(`?id_bodega=${b1}&estado=PROGRAMADO`);
    expect(res.body.datos[0]).toEqual(resumen);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// PUT /conteos/{id}/detalles
// ---------------------------------------------------------------------------------------------------------------------------

// PUT /conteos/{id}/detalles con las cabeceras dadas.
const registrar = (id, detalles, cabeceras = ADM) => request.put(`/conteos/${id}/detalles`).set(cabeceras).send(detalles === undefined ? {} : { detalles });
const lineas = (conteo) => conteo.detalles.map(({ id_producto: p, cantidad_sistema: s, cantidad_contada: c, diferencia: d }) => [p, s, c, d]);
// Marca un conteo como APROBADO directamente en la base, con lo que exige el invariante (sin líneas contadas: ningún ajuste).
const aprobarEnBase = (id) => db('conteos').where({ id_conteo: id }).update({
  estado: 'APROBADO', fecha_aprobacion: db.fn.now(), id_usuario_aprueba: 7, clave_aprobacion: `7:con:base-${id}`,
});

describe('PUT /conteos/{id}/detalles: registro de lo contado (200)', () => {
  let conteo;
  beforeEach(async () => {
    await crearSaldo(db, { idProducto: 3, idBodega: b1, cantidad: 4 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const res = await programar(cuerpoConteo({ ids_producto: [3, 5, 7] }));
    expect(lineas(res.body)).toEqual([[3, 4, null, null], [5, 10, null, null], [7, 0, null, null]]);
    conteo = res.body;
  });

  it('200 EN_REVISION: las líneas enviadas refrescan cantidad_sistema con el saldo de ESE instante (D11) y diferencia = contada − sistema, con signo; las no enviadas no cambian; ni saldos ni kardex cambian', async () => {
    /* D32(a)(b): el saldo de p5 cambió entre la programación y el conteo. */
    await db('saldos').where({ id_producto: 5, id_bodega: b1 }).update({ cantidad_disponible: 12 });
    const antes = await foto();
    const res = await registrar(conteo.id_conteo, [{ id_producto: 7, cantidad_contada: 2 }, { id_producto: 5, cantidad_contada: 9 }]);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES_CONTEO].sort());
    expect(res.body).toMatchObject({ id_conteo: conteo.id_conteo, estado: 'EN_REVISION', fecha_aprobacion: null, id_usuario_aprueba: null });
    expect(lineas(res.body)).toEqual([[3, 4, null, null], [5, 12, 9, -3], [7, 0, 2, 2]]);
    expect(res.body.detalles.map((l) => l.id_detalle_conteo)).toEqual(conteo.detalles.map((l) => l.id_detalle_conteo));
    expect((await obtener(conteo.id_conteo)).body).toEqual(res.body);
    const despues = await foto();
    expect(despues.saldos).toEqual(antes.saldos);
    expect(despues.movimientos).toEqual([]);
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
  });

  it('repetible mientras no esté APROBADO: la segunda vez vuelve a refrescar cantidad_sistema de las enviadas y recalcula la diferencia; cantidad_contada 0 vale', async () => {
    /* D32(b). */
    expect(lineas((await registrar(conteo.id_conteo, [{ id_producto: 5, cantidad_contada: 8 }])).body)[1]).toEqual([5, 10, 8, -2]);
    await db('saldos').where({ id_producto: 5, id_bodega: b1 }).update({ cantidad_disponible: 6 });
    const segunda = await registrar(conteo.id_conteo, [{ id_producto: 5, cantidad_contada: 8 }, { id_producto: 3, cantidad_contada: 0 }]);
    expect(segunda.status).toBe(200);
    expect(segunda.body.estado).toBe('EN_REVISION');
    expect(lineas(segunda.body)).toEqual([[3, 4, 0, -4], [5, 6, 8, 2], [7, 0, null, null]]);
  });

  it('el techo de cantidad_contada es el INTEGER: 2147483647 vale (diferencia exacta); 2147483648 → 422', async () => {
    /* Nunca un 22003 (500). */
    const res = await registrar(conteo.id_conteo, [{ id_producto: 7, cantidad_contada: 2147483647 }]);
    expect(lineas(res.body)[2]).toEqual([7, 0, 2147483647, 2147483647]);
    datosNoValidos(await registrar(conteo.id_conteo, [{ id_producto: 7, cantidad_contada: 2147483648 }]), ['detalles[0].cantidad_contada']);
  });

  it('el OPERADOR de la bodega del conteo registra; el de otra bodega o sin X-User-Bodega → 403 sin cambios; el ADMINISTRADOR siempre', async () => {
    /* D32(h): alcance sobre la bodega DEL CONTEO. */
    const cuerpo = [{ id_producto: 5, cantidad_contada: 1 }];
    const antes = await foto();
    esError(await registrar(conteo.id_conteo, cuerpo, OPE(b2)), 403, 'SIN_PERMISO');
    esError(await registrar(conteo.id_conteo, cuerpo, headers('OPERADOR_BODEGA')), 403, 'SIN_PERMISO');
    expect(await foto()).toEqual(antes);
    expect((await registrar(conteo.id_conteo, cuerpo, OPE(b1))).status).toBe(200);
    expect((await registrar(conteo.id_conteo, cuerpo, headers('ADMINISTRADOR', { idBodega: b2 }))).status).toBe(200);
  });
});

describe('PUT /conteos/{id}/detalles: rechazos (nada cambia)', () => {
  let conteo;
  beforeEach(async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    conteo = (await programar(cuerpoConteo({ ids_producto: [5, 6] }))).body;
  });
  const valido = [{ id_producto: 5, cantidad_contada: 3 }];
  // Control positivo: el mismo PUT válido da 200; después se devuelve el conteo a PROGRAMADO para que la foto del rechazo parta igual.
  async function controlPut() {
    expect((await registrar(conteo.id_conteo, valido)).status).toBe(200);
    await db('detalles_conteo').where({ id_conteo: conteo.id_conteo }).update({ cantidad_contada: null, diferencia: null });
    await db('conteos').where({ id_conteo: conteo.id_conteo }).update({ estado: 'PROGRAMADO' });
  }

  it('un producto fuera del conteo → 422 sobre esa posición y NINGUNA línea cambia (tampoco las válidas del mismo cuerpo)', async () => {
    /* Contrato: «422 producto fuera del conteo». */
    await controlPut();
    const antes = await foto();
    datosNoValidos(await registrar(conteo.id_conteo, [...valido, { id_producto: 9, cantidad_contada: 1 }]), ['detalles[1].id_producto']);
    expect(await foto()).toEqual(antes);
  });

  it('sobre un conteo APROBADO → 409 CONTEO_ESTADO_INVALIDO y nada cambia', async () => {
    /* D32(c): lo contado de un conteo aprobado es definitivo. */
    await controlPut();
    await aprobarEnBase(conteo.id_conteo);
    const antes = await foto();
    esError(await registrar(conteo.id_conteo, valido), 409, 'CONTEO_ESTADO_INVALIDO');
    expect(await foto()).toEqual(antes);
  });

  it.each([['inexistente', '9999'], ['0', '0'], ['-1', '-1'], ['abc', 'abc'], ['fuera del INTEGER', '2147483648']])('id %s → 404 NO_EXISTE', async (_caso, id) => {
    /* idRuta. */
    recursoNoExiste(await registrar(id, valido));
  });

  it('cuerpo inválido → 422 y nada cambia: detalles ausente o vacío, un elemento que no es un objeto, id_producto repetido, cantidad_contada negativa o de texto', async () => {
    /* D32(b): un caso por regla (la matriz de los validadores está en validate.test.js); nunca un 5xx. */
    await controlPut();
    const antes = await foto();
    datosNoValidos(await registrar(conteo.id_conteo, undefined), ['detalles']);
    datosNoValidos(await registrar(conteo.id_conteo, []), ['detalles']);
    datosNoValidos(await registrar(conteo.id_conteo, [5]), ['detalles[0]']);
    datosNoValidos(await registrar(conteo.id_conteo, [...valido, { id_producto: 5, cantidad_contada: 4 }]), ['detalles[1].id_producto']);
    datosNoValidos(await registrar(conteo.id_conteo, [{ id_producto: 5, cantidad_contada: -1 }]), ['detalles[0].cantidad_contada']);
    datosNoValidos(await registrar(conteo.id_conteo, [{ id_producto: '5', cantidad_contada: '3' }]), ['detalles[0].id_producto', 'detalles[0].cantidad_contada']);
    datosNoValidos(await request.put(`/conteos/${conteo.id_conteo}/detalles`).set(ADM).send([valido]), ['cuerpo']);
    expect(await foto()).toEqual(antes);
  });

  it('sin X-User-Id → 401 NO_AUTENTICADO y nada cambia', async () => {
    /* D8, D22. */
    const antes = await foto();
    esError(await request.put(`/conteos/${conteo.id_conteo}/detalles`).send({ detalles: valido }), 401, 'NO_AUTENTICADO');
    expect(await foto()).toEqual(antes);
  });

  it('bloquea la fila del conteo ANTES de mirar el estado: si otra transacción la tiene y lo APRUEBA, el PUT espera y responde 409', async () => {
    /* D32(c)(d): determinista con esperarBloqueo, sin tiempos fijos. */
    const otra = await db.transaction();
    let pendiente;
    try {
      await otra('conteos').where({ id_conteo: conteo.id_conteo }).forUpdate().first();
      pendiente = registrar(conteo.id_conteo, valido).then((res) => res);
      await esperarBloqueo(db);
      await otra('conteos').where({ id_conteo: conteo.id_conteo }).update({
        estado: 'APROBADO', fecha_aprobacion: db.fn.now(), id_usuario_aprueba: 7, clave_aprobacion: '7:con:otra',
      });
      await otra.commit();
    } catch (error) {
      await otra.rollback().catch(() => {});
      throw error;
    }
    esError(await pendiente, 409, 'CONTEO_ESTADO_INVALIDO');
    expect(lineas(await conteoRepository.findById(db, conteo.id_conteo))).toEqual([[5, 10, null, null], [6, 0, null, null]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// POST /conteos/{id}/aprobacion
// ---------------------------------------------------------------------------------------------------------------------------

const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];

let contadorClaves = 0;
const nuevaClave = () => `kc-${(contadorClaves += 1)}`;
// POST /conteos/{id}/aprobacion; `clave` null no envía la cabecera.
function aprobar(id, { clave = nuevaClave(), cabeceras = ADM, cliente = request } = {}) {
  const peticion = cliente.post(`/conteos/${id}/aprobacion`).set(cabeceras);
  if (clave !== null) peticion.set('Idempotency-Key', clave);
  return peticion.send();
}
// POST /movimientos (un movimiento normal entre el conteo y la aprobación).
const moverStock = (tipo, idProducto, cantidad, idBodega = b1) => request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave())
  .send({ tipo, id_producto: idProducto, id_bodega: idBodega, cantidad });
const saldoDe = async (idProducto, idBodega = b1) => (await db('saldos').where({ id_producto: idProducto, id_bodega: idBodega }).first())?.cantidad_disponible;
const aviso = () => clients.notificaciones.notificarStockBajo;

/**
 * Deja un conteo EN_REVISION por la API: siembra los saldos `{id_producto: cantidad}` de la bodega, programa el conteo con
 * `ids` (por omisión, los de los saldos) y registra lo `contado` `{id_producto: cantidad_contada}`.
 */
async function enRevision({ saldos = {}, ids, contado, idBodega = b1 }) {
  for (const [idProducto, cantidad] of Object.entries(saldos)) await crearSaldo(db, { idProducto: Number(idProducto), idBodega, cantidad });
  const idsProducto = ids ?? Object.keys(saldos).map(Number);
  const programado = await programar({ id_bodega: idBodega, fecha_programada: '2026-11-20', ids_producto: idsProducto });
  expect(programado.status).toBe(201);
  const detalles = Object.entries(contado).map(([idProducto, cantidad]) => ({ id_producto: Number(idProducto), cantidad_contada: cantidad }));
  const res = await registrar(programado.body.id_conteo, detalles);
  expect(res.status).toBe(200);
  return res.body;
}

describe('POST /conteos/{id}/aprobacion: aprobación (200)', () => {
  it('200 APROBADO con exactamente sus campos y un AJUSTE con signo por cada diferencia ≠ 0, con id_conteo, ordenados por id_producto; sin movimientos intermedios el saldo queda IGUAL a lo contado; las líneas sin contar y las de diferencia 0 no se ajustan', async () => {
    /* RF18, D32(a)(b)(i). */
    const conteo = await enRevision({ saldos: { 3: 4, 5: 10, 7: 0, 8: 6 }, contado: { 8: 6, 5: 12, 3: 1 } });
    expect(lineas(conteo)).toEqual([[3, 4, 1, -3], [5, 10, 12, 2], [7, 0, null, null], [8, 6, 6, 0]]);
    const res = await aprobar(conteo.id_conteo, { clave: 'k-aprob' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES_CONTEO, 'movimientos'].sort());
    const { movimientos, ...aprobado } = res.body;
    expect(aprobado).toEqual({ ...conteo, estado: 'APROBADO', fecha_aprobacion: expect.stringMatching(ISO_8601), id_usuario_aprueba: 7 });
    for (const movimiento of movimientos) expect(Object.keys(movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
    expect(movimientos).toEqual([
      expect.objectContaining({ tipo: 'AJUSTE', id_producto: 3, id_bodega: b1, cantidad: -3, saldo_resultante: 1, id_conteo: conteo.id_conteo, id_usuario: 7, id_lote: null, id_traslado: null }),
      expect.objectContaining({ tipo: 'AJUSTE', id_producto: 5, id_bodega: b1, cantidad: 2, saldo_resultante: 12, id_conteo: conteo.id_conteo, id_usuario: 7, id_lote: null }),
    ]);
    expect([await saldoDe(3), await saldoDe(5), await saldoDe(7), await saldoDe(8)]).toEqual([1, 12, 0, 6]);
    expect(JSON.stringify(res.body)).not.toMatch(/clave/);
    // La clave guardada es la de la operación «con» del usuario; cada AJUSTE lleva su derivada por id_producto (D25d, D32(d)).
    expect((await db('conteos').where({ id_conteo: conteo.id_conteo }).first()).clave_aprobacion).toBe(claveAlmacenada(7, OPERACIONES.CONTEO, 'k-aprob'));
    expect(await db('movimientos').orderBy('id_producto').pluck('clave_idempotencia')).toEqual(['7:con:k-aprob#3', '7:con:k-aprob#5']);
    expect((await obtener(conteo.id_conteo)).body).toEqual(aprobado);
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
  });

  it('D32(a): ajusta con la diferencia GUARDADA, no contra el saldo actual: contado 12 con sistema 10 (+2), luego se venden 3 (saldo 7) → la aprobación deja 9, no 12', async () => {
    /* El recuento es una foto del momento del conteo; las ventas posteriores son reales. */
    const conteo = await enRevision({ saldos: { 5: 10 }, contado: { 5: 12 } });
    expect((await moverStock('SALIDA', 5, 3)).status).toBe(201);
    expect(await saldoDe(5)).toBe(7);
    const res = await aprobar(conteo.id_conteo);
    expect(res.status).toBe(200);
    expect(res.body.movimientos).toEqual([expect.objectContaining({ tipo: 'AJUSTE', cantidad: 2, saldo_resultante: 9 })]);
    expect(await saldoDe(5)).toBe(9);
  });

  it('con lotes: el ajuste negativo sale por FEFO (el movimiento lleva el primer lote consumido) y el positivo entra como stock sin lote', async () => {
    /* D27: las reglas de lotes van por el signo del cambio. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const l1 = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 4 });
    const l2 = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L2', fechaVencimiento: '2027-03-31', cantidad: 3 });
    await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 2 });
    const l3 = await crearLote(db, { idBodega: b1, idProducto: 6, codigoLote: 'L3', fechaVencimiento: '2027-02-28', cantidad: 2 });
    const conteo = await enRevision({ ids: [5, 6], contado: { 5: 5, 6: 4 } });
    const res = await aprobar(conteo.id_conteo);
    expect(res.status).toBe(200);
    expect(res.body.movimientos).toEqual([
      expect.objectContaining({ id_producto: 5, cantidad: -5, saldo_resultante: 5, id_lote: l1.id_lote }),
      expect.objectContaining({ id_producto: 6, cantidad: 2, saldo_resultante: 4, id_lote: null }),
    ]);
    const cantidades = Object.fromEntries((await db('lotes').select('id_lote', 'cantidad_disponible')).map((l) => [l.id_lote, l.cantidad_disponible]));
    expect(cantidades).toEqual({ [l1.id_lote]: 0, [l2.id_lote]: 2, [l3.id_lote]: 2 });
  });

  it('sin ninguna diferencia → 200 APROBADO con movimientos [] y la clave guardada; su repetición → 200 igual sin tocar nada', async () => {
    /* D5: clave_aprobacion detecta la repetición aunque no haya ningún movimiento. */
    const conteo = await enRevision({ saldos: { 5: 10, 6: 3 }, contado: { 5: 10 } });
    const primera = await aprobar(conteo.id_conteo, { clave: 'k-cero' });
    expect(primera.status).toBe(200);
    expect(primera.body).toMatchObject({ estado: 'APROBADO', movimientos: [] });
    expect((await db('conteos').first()).clave_aprobacion).toBe('7:con:k-cero');
    const antes = await foto();
    const segunda = await aprobar(conteo.id_conteo, { clave: 'k-cero' });
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual(primera.body);
    expect(await foto()).toEqual(antes);
  });
});

describe('POST /conteos/{id}/aprobacion: Idempotency-Key (RNF17, D32(d))', () => {
  it('la misma clave → 200 con el MISMO conteo y los MISMOS id_movimiento, sin nuevos ajustes y SIN volver a evaluar el umbral', async () => {
    /* La repetición se resuelve por clave_aprobacion. */
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 50 });
    const conteo = await enRevision({ saldos: { 5: 10, 6: 1 }, contado: { 5: 8, 6: 3 } });
    const primera = await aprobar(conteo.id_conteo, { clave: 'k-rep' });
    expect(primera.status).toBe(200);
    expect(aviso()).toHaveBeenCalledTimes(1);
    const antes = await foto();
    const segunda = await aprobar(conteo.id_conteo, { clave: 'k-rep' });
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual(primera.body);
    expect(segunda.body.movimientos.map((m) => m.id_movimiento)).toEqual(primera.body.movimientos.map((m) => m.id_movimiento));
    expect(await foto()).toEqual(antes);
    expect(aviso()).toHaveBeenCalledTimes(1);
  });

  it('aprobar un conteo PROGRAMADO → 409 CONTEO_ESTADO_INVALIDO; uno ya APROBADO con OTRA clave → 409; nada cambia', async () => {
    /* D32(c). */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const programado = (await programar(cuerpoConteo())).body;
    let antes = await foto();
    esError(await aprobar(programado.id_conteo), 409, 'CONTEO_ESTADO_INVALIDO');
    expect(await foto()).toEqual(antes);
    const conteo = (await registrar(programado.id_conteo, [{ id_producto: 5, cantidad_contada: 7 }])).body;
    expect((await aprobar(conteo.id_conteo, { clave: 'k-1' })).status).toBe(200);
    antes = await foto();
    esError(await aprobar(conteo.id_conteo, { clave: 'k-2' }), 409, 'CONTEO_ESTADO_INVALIDO');
    expect(await foto()).toEqual(antes);
    expect(await saldoDe(5)).toBe(7);
  });

  it('D32(d): la misma clave sobre OTRO conteo → 409 CONFLICTO y el otro sigue EN_REVISION; con otra clave sí se aprueba', async () => {
    /* Devolver la aprobación de otro conteo sería un error silencioso. */
    const a = await enRevision({ saldos: { 5: 10 }, contado: { 5: 9 } });
    const b = await enRevision({ saldos: { 6: 10 }, contado: { 6: 8 } });
    expect((await aprobar(a.id_conteo, { clave: 'k-x' })).status).toBe(200);
    const antes = await foto();
    esError(await aprobar(b.id_conteo, { clave: 'k-x' }), 409, 'CONFLICTO');
    expect(await foto()).toEqual(antes);
    expect((await aprobar(b.id_conteo, { clave: 'k-y' })).status).toBe(200);
    expect(await saldoDe(6)).toBe(8);
  });

  it('D25: OTRO usuario con la MISMA clave hace su propia aprobación (otro conteo → 200); sobre el ya aprobado → 409 CONTEO_ESTADO_INVALIDO', async () => {
    /* La clave se acota por usuario. */
    const a = await enRevision({ saldos: { 5: 10 }, contado: { 5: 9 } });
    const b = await enRevision({ saldos: { 6: 10 }, contado: { 6: 8 } });
    expect((await aprobar(a.id_conteo, { clave: 'k-u' })).status).toBe(200);
    const otro = headers('ADMINISTRADOR', { idUsuario: 9 });
    esError(await aprobar(a.id_conteo, { clave: 'k-u', cabeceras: otro }), 409, 'CONTEO_ESTADO_INVALIDO');
    const propia = await aprobar(b.id_conteo, { clave: 'k-u', cabeceras: otro });
    expect(propia.status).toBe(200);
    expect(propia.body).toMatchObject({ id_usuario_aprueba: 9, movimientos: [expect.objectContaining({ id_usuario: 9, cantidad: -2 })] });
    expect((await db('conteos').where({ id_conteo: b.id_conteo }).first()).clave_aprobacion).toBe('9:con:k-u');
  });

  it.each([['ausente', null], ['vacía', ''], ['de 201 caracteres', 'k'.repeat(201)], ['con «#»', 'abc#1']])('cabecera %s → 400 PETICION_MAL_FORMADA y nada cambia (también con un id inválido)', async (_caso, clave) => {
    /* D25, D25c. Control: la clave de 200 caracteres vale. */
    const conteo = await enRevision({ saldos: { 5: 10 }, contado: { 5: 9 } });
    const antes = await foto();
    esError(await aprobar(conteo.id_conteo, { clave }), 400, 'PETICION_MAL_FORMADA');
    esError(await aprobar('abc', { clave }), 400, 'PETICION_MAL_FORMADA');
    expect(await foto()).toEqual(antes);
    expect((await aprobar(conteo.id_conteo, { clave: 'k'.repeat(200) })).status).toBe(200);
  });

  it('sin X-User-Id → 401 (antes que la clave); ids inválidos o inexistentes → 404', async () => {
    /* requireUser → clave → id. */
    const conteo = await enRevision({ saldos: { 5: 10 }, contado: { 5: 9 } });
    const antes = await foto();
    esError(await request.post(`/conteos/${conteo.id_conteo}/aprobacion`).send(), 401, 'NO_AUTENTICADO');
    for (const id of ['9999', '0', '-1', 'abc', '2147483648']) recursoNoExiste(await aprobar(id));
    expect(await foto()).toEqual(antes);
  });

  it('un 409 STOCK_INSUFICIENTE (un ajuste negativo dejaría el saldo negativo) deshace TODO: sin movimientos, el conteo sigue EN_REVISION y sin clave; tras reponer stock la MISMA clave da 200', async () => {
    /* D32(a), D25: los errores no se guardan. El ajuste de p3 (+1, aplicado antes) también se deshace. */
    const conteo = await enRevision({ saldos: { 3: 1, 5: 10 }, contado: { 3: 2, 5: 2 } });
    expect((await moverStock('SALIDA', 5, 5)).status).toBe(201);
    const antes = await foto();
    stockInsuficiente(await aprobar(conteo.id_conteo, { clave: 'k-neg' }), 'cantidad', 5, 8);
    expect(await foto()).toEqual(antes);
    expect((await db('conteos').where({ id_conteo: conteo.id_conteo }).first())).toMatchObject({ estado: 'EN_REVISION', clave_aprobacion: null });
    expect((await moverStock('ENTRADA', 5, 3)).status).toBe(201);
    const res = await aprobar(conteo.id_conteo, { clave: 'k-neg' });
    expect(res.status).toBe(200);
    expect([await saldoDe(3), await saldoDe(5)]).toEqual([2, 0]);
  });

  it('bodega INACTIVA → 409 BODEGA_INACTIVA, sin movimientos ni clave (aunque no haya diferencias); al reactivarla, la misma clave da 200', async () => {
    /* D12, D32(j). */
    const conDiferencias = await enRevision({ saldos: { 5: 10 }, contado: { 5: 9 } });
    const sinDiferencias = await enRevision({ saldos: { 6: 4 }, contado: { 6: 4 } });
    await db('bodegas').where({ id_bodega: b1 }).update({ activa: false });
    const antes = await foto();
    esError(await aprobar(conDiferencias.id_conteo, { clave: 'k-ina' }), 409, 'BODEGA_INACTIVA');
    esError(await aprobar(sinDiferencias.id_conteo, { clave: 'k-ina-0' }), 409, 'BODEGA_INACTIVA');
    expect(await foto()).toEqual(antes);
    await db('bodegas').where({ id_bodega: b1 }).update({ activa: true });
    expect((await aprobar(conDiferencias.id_conteo, { clave: 'k-ina' })).status).toBe(200);
    expect((await aprobar(sinDiferencias.id_conteo, { clave: 'k-ina-0' })).status).toBe(200);
  });

  it('un fallo del motor que no es de negocio en el SEGUNDO ajuste → 500 ERROR_INTERNO genérico y el primero también se deshace (conteo EN_REVISION, sin clave)', async () => {
    /* D18: sin traza ni mensaje; la transacción es una sola. */
    const conteo = await enRevision({ saldos: { 3: 1, 5: 10 }, contado: { 3: 2, 5: 2 } });
    const original = stockService.aplicarMovimiento;
    let llamadas = 0;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      llamadas += 1;
      if (llamadas === 2) throw new Error('fallo interno simulado');
      return original(trx, datos);
    });
    const antes = await foto();
    const res = await aprobar(conteo.id_conteo);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { codigo: 'ERROR_INTERNO', mensaje: expect.any(String), detalles: [] } });
    expect(JSON.stringify(res.body)).not.toMatch(/simulado/);
    expect(llamadas).toBe(2);
    expect(await foto()).toEqual(antes);
  });
});

describe('POST /conteos/{id}/aprobacion: umbral (D13, D32(j))', () => {
  it('un ajuste que deja el total del producto en 4 con mínimo 5 avisa UNA vez; uno que lo deja en 5 no avisa', async () => {
    /* Alerta solo si el total de las bodegas es ESTRICTAMENTE menor que el mínimo. */
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 5 });
    await crearUmbral(db, { idProducto: 6, cantidadMinima: 5 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 1 });
    const conteo = await enRevision({ saldos: { 5: 10, 6: 9 }, contado: { 5: 3, 6: 5 } });
    expect((await aprobar(conteo.id_conteo)).status).toBe(200);
    expect(aviso()).toHaveBeenCalledTimes(1);
    expect(aviso()).toHaveBeenCalledWith(expect.objectContaining({ idProducto: 5, idBodega: b1, cantidadTotal: 4, cantidadMinima: 5 }), expect.any(Object));
  });

  it('un aviso que RECHAZA o que LANZA no cambia la respuesta (200) y el rechazo tiene manejador (ningún unhandledRejection)', async () => {
    /* Como en movimientos.test.js: dentro de Jest se comprueba que la promesa rechazada recibe un manejador. */
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 50 });
    await crearUmbral(db, { idProducto: 6, cantidadMinima: 50 });
    const rechazada = Promise.reject(new Error('ms-notificaciones caído'));
    const then = jest.spyOn(rechazada, 'then');
    aviso().mockReturnValueOnce(rechazada).mockImplementationOnce(() => { throw new Error('fallo síncrono'); });
    const conteo = await enRevision({ saldos: { 5: 10, 6: 10 }, contado: { 5: 9, 6: 9 } });
    const res = await aprobar(conteo.id_conteo);
    expect(res.status).toBe(200);
    expect(res.body.movimientos).toHaveLength(2);
    await new Promise((resolver) => setImmediate(resolver));
    expect(then.mock.calls.some(([, alRechazar]) => typeof alRechazar === 'function')).toBe(true);
    expect(aviso()).toHaveBeenCalledTimes(2);
  });

  it('si evaluarUmbral misma LANZA (un fallo inesperado), la aprobación ya confirmada sigue respondiendo 200 y se evalúan los demás productos', async () => {
    /* try/catch alrededor de cada evaluación (D32(j)). */
    const espia = jest.spyOn(movimientoService, 'evaluarUmbral').mockRejectedValueOnce(new Error('roto'));
    const conteo = await enRevision({ saldos: { 5: 10, 6: 10 }, contado: { 5: 9, 6: 9 } });
    const res = await aprobar(conteo.id_conteo);
    expect(res.status).toBe(200);
    expect(espia).toHaveBeenCalledTimes(2);
    expect(espia.mock.calls.map(([, datos]) => [datos.idProducto, datos.tipo])).toEqual([[5, 'AJUSTE'], [6, 'AJUSTE']]);
  });
});

describe('POST /conteos/{id}/aprobacion: concurrencia (PostgreSQL real)', () => {
  const sinCincoXX = (respuestas) => expect(respuestas.filter((res) => res.status >= 500).map((res) => res.body)).toEqual([]);

  it('la aprobación bloquea la fila del conteo ANTES de mirar el estado: si otra transacción la tiene y lo aprueba, la aprobación espera y responde 409', async () => {
    /* D32(d), determinista con esperarBloqueo. */
    const conteo = await enRevision({ saldos: { 5: 10 }, contado: { 5: 10 } });
    const otra = await db.transaction();
    let pendiente;
    try {
      await otra('conteos').where({ id_conteo: conteo.id_conteo }).forUpdate().first();
      pendiente = aprobar(conteo.id_conteo).then((res) => res);
      await esperarBloqueo(db);
      await otra('conteos').where({ id_conteo: conteo.id_conteo }).update({
        estado: 'APROBADO', fecha_aprobacion: db.fn.now(), id_usuario_aprueba: 99, clave_aprobacion: '99:con:otra',
      });
      await otra.commit();
    } catch (error) {
      await otra.rollback().catch(() => {});
      throw error;
    }
    esError(await pendiente, 409, 'CONTEO_ESTADO_INVALIDO');
  });

  it('6 aprobaciones simultáneas del MISMO conteo con claves distintas → exactamente un 200 y cinco 409 CONTEO_ESTADO_INVALIDO; los ajustes se aplican UNA vez', async () => {
    /* La fila del conteo serializa las aprobaciones. */
    const conteo = await enRevision({ saldos: { 3: 4, 5: 10 }, contado: { 3: 6, 5: 7 } });
    const respuestas = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => aprobar(conteo.id_conteo, { clave: `par-${i}` })));
    sinCincoXX(respuestas);
    expect(respuestas.filter((res) => res.status === 200)).toHaveLength(1);
    expect(respuestas.filter((res) => res.status === 409).map((res) => res.body.error.codigo)).toEqual(Array(5).fill('CONTEO_ESTADO_INVALIDO'));
    expect([await saldoDe(3), await saldoDe(5)]).toEqual([6, 7]);
    expect(await db('movimientos').count({ n: '*' })).toEqual([{ n: 2 }]);
  });

  it('8 aprobaciones simultáneas con la MISMA clave → las 8 responden 200 con los mismos movimientos; los ajustes se aplican UNA vez', async () => {
    /* Las perdedoras releen clave_aprobacion tras su 409 y responden la original. */
    const conteo = await enRevision({ saldos: { 3: 4, 5: 10 }, contado: { 3: 6, 5: 7 } });
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => aprobar(conteo.id_conteo, { clave: 'k-igual' })));
    sinCincoXX(respuestas);
    expect(respuestas.map((res) => res.status)).toEqual(Array(8).fill(200));
    for (const res of respuestas) expect(res.body).toEqual(respuestas[0].body);
    expect(respuestas[0].body.movimientos).toHaveLength(2);
    expect([await saldoDe(3), await saldoDe(5)]).toEqual([6, 7]);
  });

  it('dos aprobaciones simultáneas de DOS conteos de la misma bodega con líneas solapadas (insertadas en orden inverso) → sin interbloqueo: las dos 200', async () => {
    /* D25c, D32(e): las dos toman los saldos por id_producto ascendente. */
    for (const idProducto of [1, 2, 3, 4]) await crearSaldo(db, { idProducto, idBodega: b1, cantidad: 20 });
    const a = await enRevision({ ids: [1, 2, 3, 4], contado: { 1: 21, 2: 19, 3: 22, 4: 18 } });
    const b = await enRevision({ ids: [4, 3, 2, 1], contado: { 4: 23, 3: 17, 2: 24, 1: 16 } });
    const respuestas = await Promise.all([aprobar(a.id_conteo), aprobar(b.id_conteo)]);
    sinCincoXX(respuestas);
    expect(respuestas.map((res) => res.status)).toEqual([200, 200]);
    expect([1, 2, 3, 4].map((p) => (a.detalles[p - 1].diferencia + b.detalles[p - 1].diferencia + 20))).toEqual(
      await Promise.all([1, 2, 3, 4].map((p) => saldoDe(p))),
    );
  });

  it('determinista: A ajusta su primer producto y espera a que B quede bloqueado; como B también empieza por el id_producto MENOR, espera a A (no toma otro saldo antes) y las dos terminan', async () => {
    /* Sin el orden ascendente, B tomaría primero el producto 2 (su primera línea insertada) y A, al pedirlo, cerraría el ciclo (40P01). */
    for (const idProducto of [1, 2]) await crearSaldo(db, { idProducto, idBodega: b1, cantidad: 20 });
    const a = await enRevision({ ids: [1, 2], contado: { 1: 21, 2: 22 } });
    const b = await enRevision({ ids: [2, 1], contado: { 2: 19, 1: 18 } });
    const original = stockService.aplicarMovimiento;
    let avisarPrimero;
    const primeroDeA = new Promise((resolver) => { avisarPrimero = resolver; });
    let pausado = false;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      const movimiento = await original(trx, datos);
      if (datos.idConteo === a.id_conteo && !pausado) {
        pausado = true;
        avisarPrimero();
        await esperarBloqueo(db); // B ya espera un saldo que A tiene
      }
      return movimiento;
    });
    const pedidoA = aprobar(a.id_conteo).then((res) => res);
    await primeroDeA;
    const pedidoB = aprobar(b.id_conteo).then((res) => res);
    const [resA, resB] = await Promise.all([pedidoA, pedidoB]);
    expect([resA.status, resB.status]).toEqual([200, 200]);
    expect(resA.body.movimientos.map((m) => m.id_producto)).toEqual([1, 2]);
    expect(resB.body.movimientos.map((m) => m.id_producto)).toEqual([1, 2]);
    expect([await saldoDe(1), await saldoDe(2)]).toEqual([19, 21]);
  });

  it('control del anterior: dos transacciones que toman los MISMOS dos saldos en orden INVERSO sí se interbloquean (40P01); por eso importa el orden', async () => {
    /* Evidencia de que el interbloqueo es real en PostgreSQL y no un supuesto. Tarda deadlock_timeout (1 s). */
    for (const idProducto of [1, 2]) await crearSaldo(db, { idProducto, idBodega: b1, cantidad: 20 });
    const ajuste = (trx, idProducto, clave) => stockService.aplicarMovimiento(trx, {
      tipo: 'AJUSTE', idProducto, idBodega: b1, cantidad: 1, claveIdempotencia: clave, idUsuario: 7,
    });
    const t1 = await db.transaction();
    const t2 = await db.transaction();
    try {
      await ajuste(t1, 1, 'dl-1a');
      await ajuste(t2, 2, 'dl-2a');
      const espera1 = ajuste(t1, 2, 'dl-1b').then(() => null, (error) => error);
      await esperarBloqueo(db);
      const espera2 = ajuste(t2, 1, 'dl-2b').then(() => null, (error) => error);
      const errores = (await Promise.all([espera1, espera2])).filter(Boolean);
      expect(errores.map((error) => error.code)).toEqual(['40P01']);
    } finally {
      await t1.rollback().catch(() => {});
      await t2.rollback().catch(() => {});
    }
  });

  it('mezcla adversarial: una aprobación de 9 líneas simultánea con salidas, entradas, ajustes y traslados sobre los MISMOS saldos, con un pool de 3 conexiones: sin 5xx, sin 40P01/40001 y kardex encadenado', async () => {
    /* D24, D25c, D32(e): ningún ciclo de bloqueos; cada saldo_resultante es el anterior más su cambio. */
    const configuracion = construirConfigKnex(configDePrueba());
    const dbChico = knex({ ...configuracion, pool: { min: 0, max: 3 } });
    const errores = [];
    const chico = supertest(createApp({
      db: dbChico, clients, logger: { info() {}, error: (linea) => errores.push(linea) }, env: entornoValido(), now: () => reloj,
    }));
    try {
      const productos = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const inicial = {};
      for (const p of productos) {
        inicial[`${p}-${b1}`] = 30;
        inicial[`${p}-${b2}`] = 10;
        await crearSaldo(db, { idProducto: p, idBodega: b1, cantidad: 30 });
        await crearSaldo(db, { idProducto: p, idBodega: b2, cantidad: 10 });
      }
      await crearLote(db, { idBodega: b1, idProducto: 2, codigoLote: 'A', fechaVencimiento: '2027-01-31', cantidad: 8 });
      await crearLote(db, { idBodega: b1, idProducto: 4, codigoLote: 'B', fechaVencimiento: '2027-02-28', cantidad: 6 });
      // Contado: diferencias de los dos signos (y una en 0) sobre los 9 productos.
      const contado = { 1: 25, 2: 20, 3: 33, 4: 22, 5: 30, 6: 36, 7: 24, 8: 31, 9: 27 };
      const conteo = await enRevision({ ids: productos, contado });
      // Traslados ya en tránsito hacia b1 para recibir durante la mezcla.
      const previos = [];
      for (const p of [3, 6]) {
        const res = await request.post('/traslados').set(ADM).set('Idempotency-Key', nuevaClave()).send({ id_producto: p, id_bodega_origen: b2, id_bodega_destino: b1, cantidad: 2 });
        expect(res.status).toBe(201);
        previos.push(res.body.id_traslado);
      }
      const post = (ruta, cuerpo) => chico.post(ruta).set(ADM).set('Idempotency-Key', nuevaClave()).send(cuerpo);
      const mov = (tipo, p, cantidad, idBodega = b1) => post('/movimientos', { tipo, id_producto: p, id_bodega: idBodega, cantidad });
      const pedidos = [
        aprobar(conteo.id_conteo, { clave: 'k-mezcla', cliente: chico }),
        aprobar(conteo.id_conteo, { clave: 'k-mezcla', cliente: chico }),
        ...productos.map((p) => mov('SALIDA', p, 3)),
        ...productos.filter((p) => p % 2 === 0).map((p) => mov('ENTRADA', p, 2)),
        ...productos.filter((p) => p % 3 === 0).map((p) => mov('AJUSTE', p, -1)),
        ...[9, 7, 5, 3, 1].map((p) => post('/traslados', { id_producto: p, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 2 })),
        ...[2, 4].map((p) => post('/traslados', { id_producto: p, id_bodega_origen: b2, id_bodega_destino: b1, cantidad: 1 })),
        ...previos.map((id) => post(`/traslados/${id}/recepcion`, {})),
        ...productos.map((p) => mov('SALIDA', p, 2)),
      ];
      const respuestas = await Promise.all(pedidos);
      sinCincoXX(respuestas);
      expect(errores).toEqual([]);
      for (const res of respuestas) expect([200, 201, 409]).toContain(res.status);
      for (const res of respuestas.filter((r) => r.status === 409)) expect(res.body.error.codigo).toBe('STOCK_INSUFICIENTE');
      expect(respuestas.slice(0, 2).map((res) => res.status)).toEqual([200, 200]);
      expect(respuestas[1].body).toEqual(respuestas[0].body);
      expect(respuestas[0].body.movimientos.map((m) => [m.id_producto, m.cantidad])).toEqual(
        conteo.detalles.filter((l) => l.diferencia !== 0).map((l) => [l.id_producto, l.diferencia]),
      );
      // Kardex encadenado por (producto, bodega): desde el saldo sembrado, cada saldo_resultante es el anterior más su cambio.
      for (const p of productos) {
        for (const idBodega of [b1, b2]) {
          let saldo = inicial[`${p}-${idBodega}`];
          for (const fila of await db('movimientos').where({ id_producto: p, id_bodega: idBodega }).orderBy([{ column: 'fecha' }, { column: 'id_movimiento' }])) {
            saldo += delta(fila.tipo, fila.cantidad);
            expect({ p, idBodega, id: fila.id_movimiento, saldo: fila.saldo_resultante }).toEqual({ p, idBodega, id: fila.id_movimiento, saldo });
          }
          expect(saldo).toBeGreaterThanOrEqual(0);
          expect(await saldoDe(p, idBodega)).toBe(saldo);
        }
      }
    } finally {
      await dbChico.destroy();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// D33: un conteo tiene como máximo MAX_LINEAS_CONTEO (1 000) líneas
// ---------------------------------------------------------------------------------------------------------------------------

describe('D33: tope de líneas por conteo', () => {
  const ids = (desde, cuantos) => Array.from({ length: cuantos }, (_, i) => desde + i);
  // Siembra de una vez `cuantos` saldos de `cantidad` en b1 (productos 1..cuantos).
  const sembrarSaldos = (cuantos, cantidad = 50) => db('saldos').insert(ids(1, cuantos).map((p) => ({ id_producto: p, id_bodega: b1, cantidad_disponible: cantidad })));

  it('la constante es 1 000 y vive en conteoService', () => {
    /* Un único sitio. */
    expect(conteoService.MAX_LINEAS_CONTEO).toBe(1000);
  });

  it('ids_producto con 1 001 elementos → 422 sobre "ids_producto" SIN tocar la base (ni leer la bodega); con 1 000 → 201 con 1 000 líneas', async () => {
    /* D33(a): la longitud se comprueba antes de validar elemento por elemento. */
    const lectura = jest.spyOn(bodegaRepository, 'findById');
    const res = await programar(cuerpoConteo({ ids_producto: [...ids(1, 1000), 'x'] }));
    datosNoValidos(res, ['ids_producto']);
    expect(lectura).not.toHaveBeenCalled();
    expect(await db('conteos')).toEqual([]);
    const control = await programar(cuerpoConteo({ ids_producto: ids(1, 1000) }));
    expect(control.status).toBe(201);
    expect(control.body.detalles).toHaveLength(1000);
  });

  it('sin ids_producto en una bodega con 1 001 productos con existencia → 422 que pide contar por partes, sin conteo ni líneas; con 1 000 → 201', async () => {
    /* D33(b): la consulta de las líneas por omisión se corta en 1 001. */
    await sembrarSaldos(1001);
    const res = await programar({ id_bodega: b1, fecha_programada: '2026-11-20' });
    datosNoValidos(res, ['ids_producto']);
    expect(res.body.error.detalles[0].mensaje).toMatch(/por partes/);
    expect(await db('conteos')).toEqual([]);
    expect(await db('detalles_conteo')).toEqual([]);
    await db('saldos').where({ id_producto: 1001 }).update({ cantidad_disponible: 0 });
    const control = await programar({ id_bodega: b1, fecha_programada: '2026-11-20' });
    expect(control.status).toBe(201);
    expect(control.body.detalles).toHaveLength(1000);
  });

  it('PUT con 1 001 líneas → 422 sobre "detalles" sin leer el conteo ni cambiar nada', async () => {
    /* D33(c): antes de tocar la base. */
    await sembrarSaldos(1000);
    const conteo = (await programar(cuerpoConteo({ ids_producto: ids(1, 1000) }))).body;
    const antes = await foto();
    const lectura = jest.spyOn(conteoRepository, 'findById');
    const detalles = ids(1, 1001).map((p) => ({ id_producto: p, cantidad_contada: 1 }));
    datosNoValidos(await registrar(conteo.id_conteo, detalles), ['detalles']);
    expect(lectura).not.toHaveBeenCalled();
    expect(await foto()).toEqual(antes);
  });

  it('control: un conteo de 1 000 líneas se registra entero y se aprueba (con salidas simultáneas sobre los mismos saldos) sin 5xx ni 40P01', async () => {
    /* D33: 1 000 exactas pasan; el tiempo se mide en el informe. */
    await sembrarSaldos(1000);
    const conteo = (await programar(cuerpoConteo({ ids_producto: ids(1, 1000) }))).body;
    const contado = ids(1, 1000).map((p) => ({ id_producto: p, cantidad_contada: 50 + ((p % 3) - 1) }));
    const enRev = await registrar(conteo.id_conteo, contado);
    expect(enRev.status).toBe(200);
    expect(enRev.body.detalles.filter((l) => l.diferencia !== 0)).toHaveLength(666);
    const salidas = [7, 250, 500, 750, 998].map((p) => moverStock('SALIDA', p, 2));
    const [aprobacion, ...resto] = await Promise.all([aprobar(conteo.id_conteo), ...salidas]);
    expect(aprobacion.status).toBe(200);
    expect(aprobacion.body.movimientos).toHaveLength(666);
    expect(resto.map((r) => r.status)).toEqual(Array(5).fill(201));
    expect(await saldoDe(7)).toBe(50 + 0 - 2);
    expect(await saldoDe(500)).toBe(50 + 1 - 2);
  });
});
