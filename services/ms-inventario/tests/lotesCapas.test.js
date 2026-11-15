const loteRepository = require('../src/repositories/loteRepository');
const loteService = require('../src/services/loteService');
const { planificarFefo } = require('../src/services/stockService');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearLote } = require('./helpers/fixtures');

// Las capas de lotes por separado (RNF13): el repositorio contra PostgreSQL real (el SQL de las entradas a un lote (upsert), de
// los bloqueos (FOR UPDATE), de las restas y de la consulta) y el servicio llamado sin HTTP. Las reglas (D27) están en el motor
// (stock.test.js), la ruta de movimientos en movimientosLotes.test.js y las rutas de consulta en lotes.test.js.

const CLAVES_LOTE = ['id_lote', 'id_producto', 'id_bodega', 'codigo_lote', 'fecha_vencimiento', 'cantidad_disponible'];

let db;
let b1;
let b2;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(async () => {
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
  b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
});
afterAll(() => db.destroy());

const entrada = (extra = {}) => ({ idBodega: b1, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 4, ...extra });
const upsert = (extra) => db.transaction((trx) => loteRepository.upsertEntrada(trx, entrada(extra)));
const lotes = () => db('lotes').select(CLAVES_LOTE).orderBy('id_lote');

// ¿Está bloqueada la fila del lote? Otra transacción intenta tomarla con un lock_timeout corto: 55P03 si alguien la tiene.
async function estaBloqueado(idLote) {
  try {
    await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '150ms'");
      await trx('lotes').where({ id_lote: idLote }).forUpdate().first();
    });
    return false;
  } catch (error) {
    if (error.code === '55P03') return true;
    throw error;
  }
}

// Ejecuta `tomar(trx)` en una transacción abierta, comprueba qué filas quedaron bloqueadas mientras sigue abierta y la deshace.
async function conTransaccionAbierta(tomar, comprobar) {
  const trx = await db.transaction();
  try {
    const resultado = await tomar(trx);
    await comprobar(resultado);
  } finally {
    await trx.rollback();
  }
}

describe('loteRepository.upsertEntrada', () => {
  it('crea el lote y devuelve el Lote con exactamente sus campos: números y la fecha como TEXTO', async () => {
    /* Un lote nuevo nace con la cantidad de la entrada. */
    const creado = await upsert();
    expect(Object.keys(creado).sort()).toEqual([...CLAVES_LOTE].sort());
    expect(creado).toEqual({ id_lote: 1, id_producto: 5, id_bodega: b1, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad_disponible: 4 });
  });

  it('el mismo código con la MISMA fecha suma al mismo lote (no crea otro)', async () => {
    /* ON CONFLICT … DO UPDATE suma la cantidad nueva a la guardada. */
    await upsert({ cantidad: 4 });
    expect(await upsert({ cantidad: 6 })).toMatchObject({ id_lote: 1, cantidad_disponible: 10, fecha_vencimiento: '2027-01-31' });
    expect(await lotes()).toHaveLength(1);
  });

  it('el mismo código SIN fecha (null) suma sin tocar la fecha guardada', async () => {
    /* D27(d): sin fecha en la petición no hay nada que contradecir. */
    await upsert();
    expect(await upsert({ fechaVencimiento: null, cantidad: 1 })).toMatchObject({ id_lote: 1, cantidad_disponible: 5, fecha_vencimiento: '2027-01-31' });
  });

  it('un lote nuevo sin fecha se crea con fecha null; otra entrada sin fecha le suma', async () => {
    /* Lote sin vencimiento: FEFO lo deja al final. */
    expect(await upsert({ fechaVencimiento: null })).toMatchObject({ fecha_vencimiento: null, cantidad_disponible: 4 });
    expect(await upsert({ fechaVencimiento: null, cantidad: 2 })).toMatchObject({ id_lote: 1, cantidad_disponible: 6, fecha_vencimiento: null });
  });

  it.each([
    ['guardada 2027-01-31, pedida 2027-02-01', '2027-01-31', '2027-02-01'],
    ['guardada null, pedida 2027-02-01', null, '2027-02-01'],
  ])('mismo código con OTRA fecha (%s) → undefined y el lote NO cambia', async (_caso, guardada, pedida) => {
    /* D27(d): la decisión (409 CONFLICTO) es del motor; el repositorio solo no suma. Control: con la fecha guardada sí suma. */
    await upsert({ fechaVencimiento: guardada, cantidad: 4 });
    expect(await upsert({ fechaVencimiento: guardada, cantidad: 1 })).toMatchObject({ cantidad_disponible: 5 });
    expect(await upsert({ fechaVencimiento: pedida, cantidad: 3 })).toBeUndefined();
    expect(await lotes()).toEqual([expect.objectContaining({ cantidad_disponible: 5, fecha_vencimiento: guardada })]);
  });

  it('el código es por bodega y producto, y distingue mayúsculas: L1 en otra bodega, de otro producto o «l1» son otros lotes', async () => {
    /* La unicidad es (id_bodega, id_producto, codigo_lote), exacta. */
    await upsert();
    await upsert({ idBodega: b2 });
    await upsert({ idProducto: 6 });
    await upsert({ codigoLote: 'l1' });
    expect((await lotes()).map((l) => [l.id_bodega, l.id_producto, l.codigo_lote, l.cantidad_disponible])).toEqual([
      [b1, 5, 'L1', 4], [b2, 5, 'L1', 4], [b1, 6, 'L1', 4], [b1, 5, 'l1', 4],
    ]);
  });

  it('los valores viajan como parámetros enlazados (nada del cliente se pega al SQL)', async () => {
    /* El código del lote lo escribe el cliente. */
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta.sql);
    db.on('query', registrar);
    try {
      await upsert({ codigoLote: "centinela'); DROP TABLE lotes;--", idProducto: 54321, cantidad: 98765 });
    } finally {
      db.removeListener('query', registrar);
    }
    for (const sql of consultas) expect(sql).not.toMatch(/centinela|54321|98765/);
    expect(await lotes()).toEqual([expect.objectContaining({ codigo_lote: "centinela'); DROP TABLE lotes;--" })]);
  });

  it('seis entradas SIMULTÁNEAS con el mismo código nuevo → un solo lote con la suma, sin 23505', async () => {
    /* La sentencia es atómica: la unicidad hace esperar a las demás, que suman en vez de chocar. */
    const resultados = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => upsert({ cantidad: n })));
    expect(resultados.every((l) => l.id_lote === 1)).toBe(true);
    expect(resultados.map((l) => l.cantidad_disponible).sort((a, b) => a - b).at(-1)).toBe(21);
    expect(await lotes()).toEqual([expect.objectContaining({ id_lote: 1, cantidad_disponible: 21 })]);
  });

  it('carrera de fechas: B espera a que A confirme el lote con otra fecha y entonces NO suma (sin ventana entre leer y escribir)', async () => {
    /* La condición de la fecha se evalúa sobre la fila ya confirmada, dentro de la misma sentencia que suma. */
    const a = await db.transaction();
    let b;
    try {
      await loteRepository.upsertEntrada(a, entrada({ fechaVencimiento: '2027-01-31', cantidad: 4 }));
      b = upsert({ fechaVencimiento: '2027-06-30', cantidad: 9 });
      await esperarBloqueo(db); // B ya espera en la unicidad a que A confirme
      await a.commit();
    } finally {
      if (!a.isCompleted()) await a.rollback();
    }
    expect(await b).toBeUndefined();
    expect(await lotes()).toEqual([expect.objectContaining({ cantidad_disponible: 4, fecha_vencimiento: '2027-01-31' })]);
  });
});

describe('loteRepository.buscarPorCodigo', () => {
  it('devuelve el lote de esa bodega, producto y código exactos, o undefined', async () => {
    /* La usa el motor para informar la fecha guardada en el 409 CONFLICTO. */
    const creado = await upsert();
    expect(await loteRepository.buscarPorCodigo(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1' })).toEqual(creado);
    expect(await loteRepository.buscarPorCodigo(db, { idBodega: b2, idProducto: 5, codigoLote: 'L1' })).toBeUndefined();
    expect(await loteRepository.buscarPorCodigo(db, { idBodega: b1, idProducto: 6, codigoLote: 'L1' })).toBeUndefined();
    expect(await loteRepository.buscarPorCodigo(db, { idBodega: b1, idProducto: 5, codigoLote: 'l1' })).toBeUndefined();
  });
});

describe('loteRepository.bloquearPorId', () => {
  it('devuelve el Lote (fecha como texto) o undefined si no existe', async () => {
    /* El motor comprueba después que sea de la misma bodega y producto. */
    const { id_lote: id } = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 3 });
    await db.transaction(async (trx) => {
      expect(await loteRepository.bloquearPorId(trx, id, { idBodega: b1, idProducto: 5 })).toEqual({
        id_lote: id, id_producto: 5, id_bodega: b1, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad_disponible: 3,
      });
      expect(await loteRepository.bloquearPorId(trx, 9999, { idBodega: b1, idProducto: 5 })).toBeUndefined();
    });
  });

  it.each([
    ['sin el par', undefined],
    ['sin idProducto', { idBodega: 1 }],
    ['sin idBodega', { idProducto: 5 }],
    ['con idBodega de texto', { idBodega: '1', idProducto: 5 }],
    ['con idProducto 0', { idBodega: 1, idProducto: 0 }],
  ])('%s → TypeError (rechazo) sin consultar la base: el par es OBLIGATORIO (Ruling 44)', async (_caso, par) => {
    /* Sin el par podría bloquearse un lote ajeno (riesgo de interbloqueo con un traslado). Control: con el par sí consulta. */
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta.sql);
    db.on('query', registrar);
    try {
      await db.transaction(async (trx) => {
        await expect(loteRepository.bloquearPorId(trx, 1, { idBodega: 1, idProducto: 5 })).resolves.toBeUndefined();
        const antes = consultas.length;
        await expect(loteRepository.bloquearPorId(trx, 1, par)).rejects.toBeInstanceOf(TypeError);
        expect(consultas.length).toBe(antes);
      });
    } finally {
      db.removeListener('query', registrar);
    }
  });

  it('con { idBodega, idProducto } solo encuentra el lote si es de ese par, y uno ajeno NO queda bloqueado', async () => {
    /* El motor nunca toma un lote cuyo saldo no tiene (evita un ciclo de esperas con un traslado). Control: el par correcto. */
    const { id_lote: id } = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', cantidad: 3 });
    await conTransaccionAbierta(async (trx) => [
      await loteRepository.bloquearPorId(trx, id, { idBodega: b2, idProducto: 5 }),
      await loteRepository.bloquearPorId(trx, id, { idBodega: b1, idProducto: 6 }),
    ], async (ajenos) => {
      expect(ajenos).toEqual([undefined, undefined]);
      expect(await estaBloqueado(id)).toBe(false);
    });
    await conTransaccionAbierta((trx) => loteRepository.bloquearPorId(trx, id, { idBodega: b1, idProducto: 5 }), async (propio) => {
      expect(propio).toMatchObject({ id_lote: id, cantidad_disponible: 3 });
      expect(await estaBloqueado(id)).toBe(true);
    });
  });

  it('bloquea la fila (FOR UPDATE) hasta el fin de la transacción, y solo esa', async () => {
    /* Control: sin transacción abierta la fila está libre. */
    const uno = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', cantidad: 3 });
    const otro = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L2', cantidad: 3 });
    expect(await estaBloqueado(uno.id_lote)).toBe(false);
    await conTransaccionAbierta((trx) => loteRepository.bloquearPorId(trx, uno.id_lote, { idBodega: b1, idProducto: 5 }), async () => {
      expect(await estaBloqueado(uno.id_lote)).toBe(true);
      expect(await estaBloqueado(otro.id_lote)).toBe(false);
    });
    expect(await estaBloqueado(uno.id_lote)).toBe(false);
  });
});

describe('loteRepository.listarParaFefo', () => {
  it('solo los lotes de esa bodega y producto CON existencia, por fecha ascendente, sin fecha al final y desempate por id_lote', async () => {
    /* El mismo orden que planificarFefo: así la lista bloqueada y el plan coinciden. */
    const sembrar = (codigo, fecha, cantidad, extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad, ...extra });
    const sinFecha = await sembrar('SF', null, 2);
    const tarde = await sembrar('T', '2027-10-01', 2);
    const tempranoB = await sembrar('E2', '2027-01-31', 2);
    await sembrar('VACIO', '2026-01-01', 0);
    const tempranoA = await sembrar('E1', '2027-01-31', 2);
    const septiembre = await sembrar('S', '2027-09-30', 2);
    await sembrar('OTRA-BODEGA', '2026-01-01', 9, { idBodega: b2 });
    await sembrar('OTRO-PRODUCTO', '2026-01-01', 9, { idProducto: 6 });
    await db.transaction(async (trx) => {
      const lista = await loteRepository.listarParaFefo(trx, { idBodega: b1, idProducto: 5 });
      expect(lista.map((l) => l.id_lote)).toEqual([tempranoB, tempranoA, septiembre, tarde, sinFecha].map((l) => l.id_lote));
      expect(lista[0]).toEqual({ id_lote: tempranoB.id_lote, id_producto: 5, id_bodega: b1, codigo_lote: 'E2', fecha_vencimiento: '2027-01-31', cantidad_disponible: 2 });
    });
  });

  it('sin lotes → []', async () => {
    /* El motor saca entonces todo del stock sin lote. */
    await db.transaction(async (trx) => expect(await loteRepository.listarParaFefo(trx, { idBodega: b1, idProducto: 5 })).toEqual([]));
  });

  it('bloquea (FOR UPDATE) los lotes que devuelve, no los de otro producto', async () => {
    /* Dos salidas FEFO del mismo par se serializan por el saldo; el bloqueo de los lotes protege a quien los toque por id. */
    const uno = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', cantidad: 3 });
    const ajeno = await crearLote(db, { idBodega: b1, idProducto: 6, codigoLote: 'L1', cantidad: 3 });
    await conTransaccionAbierta((trx) => loteRepository.listarParaFefo(trx, { idBodega: b1, idProducto: 5 }), async (lista) => {
      expect(lista).toHaveLength(1);
      expect(await estaBloqueado(uno.id_lote)).toBe(true);
      expect(await estaBloqueado(ajeno.id_lote)).toBe(false);
    });
  });
});

describe('loteRepository.listar (la consulta de lotes, RF17)', () => {
  const claves = (filas) => filas.map((fila) => fila.id_lote);
  // Los ids de las filas sembradas, para leerlos en la tabla de abajo.
  //  id  bodega  producto  vence        existencia
  //  1   b1      5         2027-01-31   5
  //  2   b1      5         (sin fecha)  3
  //  3   b1      6         2027-01-15   0
  //  4   b2      5         2027-01-31   2     (misma fecha que el 1)
  //  5   b1      5         2027-03-01   1
  // Orden esperado, fecha ASC (sin fecha al final) e id_lote ASC: 3, 1, 4, 5, 2.
  beforeEach(async () => {
    const sembrar = (codigo, fecha, cantidad, extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad, ...extra });
    await sembrar('A', '2027-01-31', 5);
    await sembrar('B', null, 3);
    await sembrar('C', '2027-01-15', 0, { idProducto: 6 });
    await sembrar('D', '2027-01-31', 2, { idBodega: b2 });
    await sembrar('E', '2027-03-01', 1);
  });
  const todos = { limit: 10, offset: 0 };

  it('devuelve { filas, total } en orden FEFO (fecha ascendente, sin fecha al final, desempate por id_lote), con exactamente los 6 campos de un Lote', async () => {
    /* Una SOLA lista ordenada: el consumidor recorre las páginas y necesita que el orden sea estable. */
    const { filas, total } = await loteRepository.listar(db, todos);
    expect(claves(filas)).toEqual([3, 1, 4, 5, 2]);
    expect(total).toBe(5);
    expect(Object.keys(filas[0]).sort()).toEqual([...CLAVES_LOTE].sort());
    expect(filas[1]).toEqual({ id_lote: 1, id_producto: 5, id_bodega: b1, codigo_lote: 'A', fecha_vencimiento: '2027-01-31', cantidad_disponible: 5 });
    expect(filas[4].fecha_vencimiento).toBeNull();
    expect(filas[0]).toEqual({ id_lote: 3, id_producto: 6, id_bodega: b1, codigo_lote: 'C', fecha_vencimiento: '2027-01-15', cantidad_disponible: 0 });
  });

  it('el desempate por id_lote ordena las filas con la misma fecha aunque la fila física se haya movido (UPDATE)', async () => {
    /* El UPDATE del lote 1 crea su nueva versión al final del montón: sin ORDER BY id_lote, el 4 saldría antes que el 1. */
    await db('lotes').where({ id_lote: 1 }).update({ cantidad_disponible: 6 });
    expect(claves((await loteRepository.listar(db, todos)).filas)).toEqual([3, 1, 4, 5, 2]);
  });

  it('total es numérico y cuenta TODAS las filas del filtro, no las de la página; limit y offset recortan solo las filas', async () => {
    const { filas, total } = await loteRepository.listar(db, { limit: 2, offset: 2 });
    expect(claves(filas)).toEqual([4, 5]);
    expect(typeof total).toBe('number');
    expect(total).toBe(5);
  });

  it('una página fuera de rango devuelve filas vacías y el total exacto, aun con un desplazamiento mayor que el INTEGER', async () => {
    expect(await loteRepository.listar(db, { limit: 10, offset: 100 })).toEqual({ filas: [], total: 5 });
    expect(await loteRepository.listar(db, { limit: 100, offset: 214748364600 })).toEqual({ filas: [], total: 5 });
  });

  // Cada filtro es una función porque el id de b2 lo fija el beforeEach de la suite.
  it.each([
    ['idProducto', () => ({ idProducto: 6 }), [3]],
    ['idBodega', () => ({ idBodega: b2 }), [4]],
    ['venceAntesDe (estricto: el 31 de enero no entra con el 31, y el lote sin fecha nunca entra)', () => ({ venceAntesDe: '2027-01-31' }), [3]],
    ['venceAntesDe un día después (entran los del 31)', () => ({ venceAntesDe: '2027-02-01' }), [3, 1, 4]],
    ['conExistencia: true', () => ({ conExistencia: true }), [1, 4, 5, 2]],
  ])('%s filtra filas y total con el MISMO criterio (el COUNT y la página comparten el WHERE)', async (_filtro, filtro, esperados) => {
    const pagina = await loteRepository.listar(db, { ...filtro(), limit: 1, offset: 0 });
    expect(claves(pagina.filas)).toEqual(esperados.slice(0, 1)); // la página trae solo 1 fila…
    expect(pagina.total).toBe(esperados.length); // …pero el total es el del filtro
    expect(claves((await loteRepository.listar(db, { ...filtro(), ...todos })).filas)).toEqual(esperados);
  });

  it('conExistencia: false y conExistencia: undefined NO filtran (incluyen los lotes en 0)', async () => {
    expect(claves((await loteRepository.listar(db, { conExistencia: true, ...todos })).filas)).not.toContain(3); // control: true sí lo omite
    for (const conExistencia of [false, undefined]) {
      const { filas, total } = await loteRepository.listar(db, { conExistencia, ...todos });
      expect({ conExistencia, ids: claves(filas), total }).toEqual({ conExistencia, ids: [3, 1, 4, 5, 2], total: 5 });
    }
  });

  it('los filtros se combinan con AND y un filtro undefined no restringe', async () => {
    const lista = (filtro) => loteRepository.listar(db, { ...todos, ...filtro });
    expect(claves((await lista({ idProducto: 5, idBodega: b1 })).filas)).toEqual([1, 5, 2]);
    expect(claves((await lista({ idProducto: 5, venceAntesDe: '2027-02-01', conExistencia: true })).filas)).toEqual([1, 4]);
    expect(await lista({ idProducto: 6, idBodega: b2 })).toEqual({ filas: [], total: 0 });
    const sinFiltros = await lista({ idProducto: undefined, idBodega: undefined, venceAntesDe: undefined, conExistencia: undefined });
    expect(sinFiltros.total).toBe(5);
  });

  it('los valores del filtro viajan como parámetros enlazados: ninguno se interpola en el texto de la consulta', async () => {
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta);
    db.on('query', registrar);
    try {
      await loteRepository.listar(db, { idProducto: 54321, idBodega: 98765, venceAntesDe: '2031-11-30', conExistencia: true, limit: 77, offset: 33 });
    } finally {
      db.removeListener('query', registrar);
    }
    expect(consultas.length).toBeGreaterThan(0);
    for (const { sql } of consultas) expect(sql).not.toMatch(/54321|98765|2031-11|\b77\b|\b33\b/);
    const enlazados = consultas.flatMap(({ bindings }) => bindings);
    expect(enlazados).toEqual(expect.arrayContaining([54321, 98765, '2031-11-30', 77, 33]));
  });

  it('nunca usa SELECT *, y es una lectura: ni FOR UPDATE ni FOR SHARE', async () => {
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta.sql);
    db.on('query', registrar);
    try {
      await loteRepository.listar(db, todos);
    } finally {
      db.removeListener('query', registrar);
    }
    expect(consultas.length).toBeGreaterThan(0);
    for (const sql of consultas) expect(sql).not.toMatch(/\bfor\s+(update|share|no key update|key share)\b/i);
    for (const sql of consultas.filter((texto) => /^select/i.test(texto) && !/count\(/i.test(texto))) expect(sql).not.toMatch(/\*/);
  });

  it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado y un rollback no deja nada', async () => {
    await expect(db.transaction(async (trx) => {
      await crearLote(trx, { idBodega: b1, idProducto: 77, codigoLote: 'NUEVO', cantidad: 1 });
      expect((await loteRepository.listar(trx, { idProducto: 77, ...todos })).total).toBe(1);
      expect((await loteRepository.listar(db, { idProducto: 77, ...todos })).total).toBe(0); // desde fuera no se ve
      throw new Error('deshacer');
    })).rejects.toThrow('deshacer');
    expect((await loteRepository.listar(db, { idProducto: 77, ...todos })).total).toBe(0);
  });

  it('no toma bloqueos de fila: tras leer dentro de una transacción abierta, ningún lote queda bloqueado', async () => {
    await conTransaccionAbierta((trx) => loteRepository.listar(trx, todos), async ({ filas }) => {
      expect(filas).toHaveLength(5);
      for (const { id_lote: idLote } of filas) expect(await estaBloqueado(idLote)).toBe(false);
    });
    // Control del arnés: con FOR UPDATE (listarParaFefo) sí quedarían bloqueados.
    await conTransaccionAbierta((trx) => loteRepository.listarParaFefo(trx, { idBodega: b1, idProducto: 5 }), async () => {
      expect(await estaBloqueado(1)).toBe(true);
    });
  });
});

describe('loteRepository.listarConExistencia (la lectura de la sugerencia: FEFO sin bloqueo)', () => {
  const sembrar = (codigo, fecha, cantidad, extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad, ...extra });
  const par = () => ({ idBodega: b1, idProducto: 5 });

  it('solo los lotes de esa bodega y producto CON existencia, en el MISMO orden FEFO que listarParaFefo (fecha ascendente, sin fecha al final, desempate por id_lote)', async () => {
    /* Que ambas funciones coincidan es lo que impide que la sugerencia y la salida del motor se separen. */
    const sinFecha = await sembrar('SF', null, 2);
    const tarde = await sembrar('T', '2027-10-01', 2);
    const tempranoB = await sembrar('E2', '2027-01-31', 2);
    await sembrar('VACIO', '2026-01-01', 0);
    const tempranoA = await sembrar('E1', '2027-01-31', 2);
    await sembrar('OTRA-BODEGA', '2026-01-01', 9, { idBodega: b2 });
    await sembrar('OTRO-PRODUCTO', '2026-01-01', 9, { idProducto: 6 });
    await db('lotes').where({ id_lote: tempranoB.id_lote }).update({ cantidad_disponible: 2 }); // la fila física del primero se mueve
    const lista = await loteRepository.listarConExistencia(db, par());
    expect(lista.map((l) => l.id_lote)).toEqual([tempranoB, tempranoA, tarde, sinFecha].map((l) => l.id_lote));
    expect(lista[0]).toEqual({ id_lote: tempranoB.id_lote, id_producto: 5, id_bodega: b1, codigo_lote: 'E2', fecha_vencimiento: '2027-01-31', cantidad_disponible: 2 });
    expect(Object.keys(lista[0]).sort()).toEqual([...CLAVES_LOTE].sort());
    expect(await db.transaction((trx) => loteRepository.listarParaFefo(trx, par()))).toEqual(lista);
  });

  it('sin lotes → []', async () => {
    expect(await loteRepository.listarConExistencia(db, par())).toEqual([]);
    await sembrar('VACIO', '2027-01-31', 0);
    expect(await loteRepository.listarConExistencia(db, par())).toEqual([]);
  });

  it('NO bloquea: ni el texto de la consulta lleva FOR UPDATE/SHARE, ni queda fila alguna bloqueada tras leer en una transacción abierta', async () => {
    const uno = await sembrar('L1', '2027-01-31', 3);
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta.sql);
    db.on('query', registrar);
    try {
      await loteRepository.listarConExistencia(db, par());
    } finally {
      db.removeListener('query', registrar);
    }
    expect(consultas.length).toBeGreaterThan(0);
    for (const sql of consultas) expect(sql).not.toMatch(/\bfor\s+(update|share|no key update|key share)\b/i);
    await conTransaccionAbierta((trx) => loteRepository.listarConExistencia(trx, par()), async (lista) => {
      expect(lista).toHaveLength(1);
      expect(await estaBloqueado(uno.id_lote)).toBe(false);
    });
  });

  it('no espera a quien tiene los lotes bloqueados con FOR UPDATE: responde al instante mientras otra transacción los retiene', async () => {
    const uno = await sembrar('L1', '2027-01-31', 3);
    await conTransaccionAbierta((trx) => loteRepository.listarParaFefo(trx, par()), async () => {
      expect(await estaBloqueado(uno.id_lote)).toBe(true); // control: de verdad están bloqueados
      const lista = await Promise.race([loteRepository.listarConExistencia(db, par()), new Promise((resolver) => { setTimeout(() => resolver('esperó'), 2000); })]);
      expect(lista).not.toBe('esperó');
      expect(lista.map((l) => l.id_lote)).toEqual([uno.id_lote]);
    });
  });

  it('los valores viajan como parámetros enlazados y nunca usa SELECT *', async () => {
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta);
    db.on('query', registrar);
    try {
      await loteRepository.listarConExistencia(db, { idBodega: 98765, idProducto: 54321 });
    } finally {
      db.removeListener('query', registrar);
    }
    expect(consultas.length).toBeGreaterThan(0);
    for (const { sql } of consultas) expect(sql).not.toMatch(/54321|98765|\*/);
    expect(consultas.flatMap(({ bindings }) => bindings)).toEqual(expect.arrayContaining([54321, 98765]));
  });

  it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado y un rollback no deja nada', async () => {
    await expect(db.transaction(async (trx) => {
      const nuevo = await crearLote(trx, { idBodega: b1, idProducto: 77, codigoLote: 'NUEVO', cantidad: 1 });
      expect((await loteRepository.listarConExistencia(trx, { idBodega: b1, idProducto: 77 })).map((l) => l.id_lote)).toEqual([nuevo.id_lote]);
      expect(await loteRepository.listarConExistencia(db, { idBodega: b1, idProducto: 77 })).toEqual([]); // desde fuera no se ve
      throw new Error('deshacer');
    })).rejects.toThrow('deshacer');
    expect(await loteRepository.listarConExistencia(db, { idBodega: b1, idProducto: 77 })).toEqual([]);
  });
});

describe('loteRepository.sumarDelPar', () => {
  it('suma la existencia de los lotes de ESE par (también los que están en 0), o 0 si no hay; e informa el aislamiento', async () => {
    /* El motor la usa para el stock sin lote de un traslado (D28(a)). */
    await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', cantidad: 4 });
    await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'B', cantidad: 0 });
    await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'C', fechaVencimiento: '2027-01-31', cantidad: 3 });
    await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'A', cantidad: 50 });
    await crearLote(db, { idBodega: b1, idProducto: 6, codigoLote: 'A', cantidad: 60 });
    await db.transaction(async (trx) => {
      expect(await loteRepository.sumarDelPar(trx, { idBodega: b1, idProducto: 5 })).toEqual({ enLotes: 7, aislamiento: 'read committed' });
      expect(await loteRepository.sumarDelPar(trx, { idBodega: b2, idProducto: 6 })).toEqual({ enLotes: 0, aislamiento: 'read committed' });
    });
  });

  it('informa el aislamiento REAL de la transacción', async () => {
    /* Así el motor puede negarse a calcular con una instantánea anterior al candado. */
    await db.transaction(async (trx) => {
      expect((await loteRepository.sumarDelPar(trx, { idBodega: b1, idProducto: 5 })).aislamiento).toBe('repeatable read');
    }, { isolationLevel: 'repeatable read' });
  });
});

describe('loteRepository.ajustar', () => {
  it('suma y resta a la existencia y devuelve el Lote; puede dejarlo exactamente en 0', async () => {
    /* La cantidad ya la decidió el motor con el lote bloqueado. */
    const { id_lote: id } = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', cantidad: 5 });
    expect(await loteRepository.ajustar(db, id, 3)).toMatchObject({ id_lote: id, cantidad_disponible: 8 });
    expect(await loteRepository.ajustar(db, id, -8)).toMatchObject({ id_lote: id, cantidad_disponible: 0 });
  });

  it('una resta que lo dejaría negativo → undefined y la existencia NO cambia (nunca el 23514 del CHECK)', async () => {
    /* Control: -5 cabe; -6 no. */
    const { id_lote: id } = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', cantidad: 5 });
    expect(await loteRepository.ajustar(db, id, -6)).toBeUndefined();
    expect((await lotes())[0].cantidad_disponible).toBe(5);
    expect(await loteRepository.ajustar(db, id, -5)).toMatchObject({ cantidad_disponible: 0 });
  });

  it('un lote inexistente → undefined', async () => {
    /* Nada que actualizar. */
    expect(await loteRepository.ajustar(db, 9999, 1)).toBeUndefined();
  });
});

describe('loteService', () => {
  const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const OPERADOR = { idUsuario: 7, rol: 'OPERADOR_BODEGA', idBodega: 2, requestId: 'r1' };
  const INTERNA = { idUsuario: null, rol: null, idBodega: null, requestId: 'r1' };
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);
  afterEach(() => jest.restoreAllMocks());

  describe('listarLotes', () => {
    const consulta = (extra = {}) => ({ identity: IDENTIDAD, limit: 20, offset: 0, ...extra });
    const deps = () => ({ db });
    const espiar = () => jest.spyOn(loteRepository, 'listar').mockResolvedValue({ filas: [], total: 0 });

    it('un operador con otra bodega → 403 SIN_PERMISO y NO consulta el repositorio', async () => {
      const listar = espiar();
      const error = await atrapar(loteService.listarLotes(deps(), consulta({ identity: OPERADOR, idBodega: 3 })));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(listar).not.toHaveBeenCalled();
    });

    it('un operador sin bodega asignada → 403 SIN_PERMISO, con y sin id_bodega, y NO consulta el repositorio', async () => {
      const listar = espiar();
      for (const idBodega of [undefined, 2]) {
        const error = await atrapar(loteService.listarLotes(deps(), consulta({ identity: { ...OPERADOR, idBodega: null }, idBodega })));
        expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      }
      expect(listar).not.toHaveBeenCalled();
    });

    it('un operador sin id_bodega recibe el filtro de SU bodega; con la propia también; el resto del filtro pasa intacto', async () => {
      const listar = espiar();
      const resto = { idProducto: 5, venceAntesDe: '2027-01-31', conExistencia: true, limit: 20, offset: 40 };
      await loteService.listarLotes(deps(), consulta({ identity: OPERADOR, ...resto }));
      await loteService.listarLotes(deps(), consulta({ identity: OPERADOR, idBodega: 2, ...resto }));
      expect(listar).toHaveBeenNthCalledWith(1, db, { ...resto, idBodega: 2 });
      expect(listar).toHaveBeenNthCalledWith(2, db, { ...resto, idBodega: 2 });
    });

    it.each([['un administrador', IDENTIDAD], ['una llamada interna', INTERNA]])('%s: el filtro pasa tal cual, con o sin id_bodega', async (_nombre, identity) => {
      const listar = espiar();
      const filtro = { idProducto: 5, idBodega: 3, venceAntesDe: '2027-01-31', conExistencia: false, limit: 100, offset: 200 };
      await loteService.listarLotes(deps(), consulta({ identity, ...filtro }));
      await loteService.listarLotes(deps(), consulta({ identity, limit: 20, offset: 0 }));
      expect(listar).toHaveBeenNthCalledWith(1, db, filtro);
      expect(listar).toHaveBeenNthCalledWith(2, db, { idProducto: undefined, idBodega: undefined, venceAntesDe: undefined, conExistencia: undefined, limit: 20, offset: 0 });
    });

    it('devuelve { filas, total } tal como los entrega el repositorio', async () => {
      const filas = [{ id_lote: 3 }, { id_lote: 1 }];
      jest.spyOn(loteRepository, 'listar').mockResolvedValue({ filas, total: 9 });
      expect(await loteService.listarLotes(deps(), consulta())).toEqual({ filas, total: 9 });
    });

    it('con la base real: un operador recibe solo los lotes de su bodega y el total de ESA bodega', async () => {
      await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', fechaVencimiento: '2027-01-31', cantidad: 1 });
      await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'B', fechaVencimiento: '2027-02-01', cantidad: 2 });
      await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'C', fechaVencimiento: '2027-01-15', cantidad: 3 });
      const { filas, total } = await loteService.listarLotes(deps(), consulta({ identity: { ...OPERADOR, idBodega: b2 } }));
      expect(filas.map((fila) => fila.id_lote)).toEqual([3, 2]);
      expect(total).toBe(2);
      expect((await loteService.listarLotes(deps(), consulta())).total).toBe(3); // control: el administrador ve los tres
    });

    it('un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      jest.spyOn(loteRepository, 'listar').mockImplementation(() => { throw falla; });
      let resultado;
      expect(() => { resultado = loteService.listarLotes(deps(), consulta()); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });
  });

  describe('sugerirSalida', () => {
    const peticion = (extra = {}) => ({ identity: IDENTIDAD, idProducto: 5, idBodega: 2, cantidad: 7, ...extra });
    const deps = () => ({ db });
    const lote = (id, codigo, fecha, cantidad) => ({ id_lote: id, id_producto: 5, id_bodega: 2, codigo_lote: codigo, fecha_vencimiento: fecha, cantidad_disponible: cantidad });
    const espiar = (lista = []) => jest.spyOn(loteRepository, 'listarConExistencia').mockResolvedValue(lista);

    it('un operador con otra bodega → 403 SIN_PERMISO y NO consulta el repositorio', async () => {
      const leer = espiar();
      const error = await atrapar(loteService.sugerirSalida(deps(), peticion({ identity: OPERADOR, idBodega: 3 })));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(leer).not.toHaveBeenCalled();
    });

    it('un operador sin bodega asignada → 403 SIN_PERMISO y NO consulta el repositorio', async () => {
      const leer = espiar();
      const error = await atrapar(loteService.sugerirSalida(deps(), peticion({ identity: { ...OPERADOR, idBodega: null } })));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(leer).not.toHaveBeenCalled();
    });

    it.each([['un operador con su bodega', OPERADOR], ['un administrador', IDENTIDAD], ['una llamada interna', INTERNA]])('%s: lee los lotes de ESE (producto, bodega) y de ningún otro', async (_nombre, identity) => {
      const leer = espiar([lote(1, 'A', '2027-01-31', 9)]);
      await loteService.sugerirSalida(deps(), peticion({ identity }));
      expect(leer).toHaveBeenCalledTimes(1);
      expect(leer).toHaveBeenCalledWith(db, { idBodega: 2, idProducto: 5 });
    });

    it('nunca toma el bloqueo FOR UPDATE de listarParaFefo: es una consulta, no una reserva', async () => {
      espiar([lote(1, 'A', '2027-01-31', 9)]);
      const bloqueante = jest.spyOn(loteRepository, 'listarParaFefo');
      await loteService.sugerirSalida(deps(), peticion());
      expect(bloqueante).not.toHaveBeenCalled();
    });

    it('arma [{ id_lote, codigo_lote, fecha_vencimiento, cantidad_sugerida }] con lo que asigna planificarFefo, en su orden', async () => {
      espiar([lote(2, 'B', '2027-02-15', 5), lote(1, 'A', '2027-01-31', 5)]);
      expect(await loteService.sugerirSalida(deps(), peticion({ cantidad: 7 }))).toEqual([
        { id_lote: 1, codigo_lote: 'A', fecha_vencimiento: '2027-01-31', cantidad_sugerida: 5 },
        { id_lote: 2, codigo_lote: 'B', fecha_vencimiento: '2027-02-15', cantidad_sugerida: 2 },
      ]);
    });

    it('coincide, para cada cantidad, con planificarFefo (la regla del motor): mismos lotes, mismas cantidades, misma suma', async () => {
      const lista = [lote(3, 'C', null, 2), lote(1, 'A', '2027-01-31', 3), lote(2, 'B', '2027-01-31', 4)];
      espiar(lista);
      for (let cantidad = 1; cantidad <= 9; cantidad += 1) {
        const sugerida = await loteService.sugerirSalida(deps(), peticion({ cantidad }));
        const { asignaciones, restante } = planificarFefo(lista, cantidad);
        expect(restante).toBe(0);
        expect(sugerida.map(({ id_lote: id, cantidad_sugerida: toma }) => ({ id_lote: id, cantidad: toma }))).toEqual(asignaciones);
        expect(sugerida.reduce((total, item) => total + item.cantidad_sugerida, 0)).toBe(cantidad);
      }
    });

    it('si los lotes no alcanzan → 409 STOCK_INSUFICIENTE con disponible = la suma de lo que hay en lotes y solicitado = lo pedido (números)', async () => {
      espiar([lote(1, 'A', '2027-01-31', 5), lote(2, 'B', '2027-02-15', 3)]);
      const error = await atrapar(loteService.sugerirSalida(deps(), peticion({ cantidad: 9 })));
      expect(error).toMatchObject({
        status: 409,
        codigo: 'STOCK_INSUFICIENTE',
        detalles: [{ campo: 'cantidad', mensaje: expect.stringMatching(/\S/), disponible: 8, solicitado: 9 }],
      });
      expect(error.message).toMatch(/lotes/i);
      // Control: pedir exactamente lo que hay sí se sugiere.
      expect(await loteService.sugerirSalida(deps(), peticion({ cantidad: 8 }))).toHaveLength(2);
    });

    it('sin lotes → 409 con disponible 0', async () => {
      espiar([]);
      const error = await atrapar(loteService.sugerirSalida(deps(), peticion({ cantidad: 1 })));
      expect(error).toMatchObject({ status: 409, codigo: 'STOCK_INSUFICIENTE', detalles: [{ campo: 'cantidad', disponible: 0, solicitado: 1 }] });
    });

    it('con la base real: un operador recibe sugerencia solo de los lotes de su bodega', async () => {
      await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', fechaVencimiento: '2027-01-31', cantidad: 4 });
      await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'B', fechaVencimiento: '2027-01-01', cantidad: 4 });
      const operador = { ...OPERADOR, idBodega: b1 };
      expect(await loteService.sugerirSalida(deps(), peticion({ identity: operador, idBodega: b1, cantidad: 4 }))).toEqual([{ id_lote: 1, codigo_lote: 'A', fecha_vencimiento: '2027-01-31', cantidad_sugerida: 4 }]);
      expect(await atrapar(loteService.sugerirSalida(deps(), peticion({ identity: operador, idBodega: b2, cantidad: 4 })))).toMatchObject({ status: 403 });
    });

    it('un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      jest.spyOn(loteRepository, 'listarConExistencia').mockImplementation(() => { throw falla; });
      let resultado;
      expect(() => { resultado = loteService.sugerirSalida(deps(), peticion()); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });
  });

  describe('crearLoteService', () => {
    it('lee las dependencias en cada llamada: el servicio se puede construir sin ellas', async () => {
      const tardias = {};
      const servicio = loteService.crearLoteService(tardias);
      Object.assign(tardias, { db });
      await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', cantidad: 1 });
      expect((await servicio.listar({ identity: IDENTIDAD, limit: 20, offset: 0 })).total).toBe(1);
      expect(await servicio.sugerirSalida({ identity: IDENTIDAD, idProducto: 5, idBodega: b1, cantidad: 1 })).toHaveLength(1);
    });
  });
});

// Cada función que exporta el repositorio con sus argumentos: todas son asíncronas (Ruling 21).
promesasReales(loteRepository, {
  upsertEntrada: [{ idBodega: 1, idProducto: 5, codigoLote: 'P', fechaVencimiento: null, cantidad: 1 }],
  buscarPorCodigo: [{ idBodega: 1, idProducto: 5, codigoLote: 'P' }],
  bloquearPorId: [1, { idBodega: 1, idProducto: 5 }],
  listarParaFefo: [{ idBodega: 1, idProducto: 5 }],
  listarConExistencia: [{ idBodega: 1, idProducto: 5 }],
  listar: [{ limit: 10, offset: 0 }],
  ajustar: [1, 0],
  sumarDelPar: [{ idBodega: 1, idProducto: 5 }],
}, { titulo: 'loteRepository', db: () => db });
