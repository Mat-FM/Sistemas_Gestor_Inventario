const conteoRepository = require('../src/repositories/conteoRepository');
const { buildTestApp } = require('./helpers/app');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, headers } = require('./helpers/fixtures');
const { esError, datosNoValidos, recursoNoExiste } = require('./helpers/respuestas');

// Conteos físicos (RF18) de punta a punta, contra PostgreSQL real y con clientes falsos: POST /conteos (programar), GET /conteos
// (listado), GET /conteos/{id} y PUT /conteos/{id}/detalles (registrar lo contado). Las capas por separado están en
// conteosCapas.test.js.
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
