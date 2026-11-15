const loteRepository = require('../src/repositories/loteRepository');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearLote } = require('./helpers/fixtures');

// El repositorio de lotes (RNF13) contra PostgreSQL real: el SQL de las entradas a un lote (upsert), de los bloqueos (FOR UPDATE)
// y de las restas. Las reglas (D27) están en el motor (stock.test.js) y la ruta en movimientosLotes.test.js.

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

// Cada función que exporta el repositorio con sus argumentos: todas son asíncronas (Ruling 21).
promesasReales(loteRepository, {
  upsertEntrada: [{ idBodega: 1, idProducto: 5, codigoLote: 'P', fechaVencimiento: null, cantidad: 1 }],
  buscarPorCodigo: [{ idBodega: 1, idProducto: 5, codigoLote: 'P' }],
  bloquearPorId: [1, { idBodega: 1, idProducto: 5 }],
  listarParaFefo: [{ idBodega: 1, idProducto: 5 }],
  ajustar: [1, 0],
  sumarDelPar: [{ idBodega: 1, idProducto: 5 }],
}, { titulo: 'loteRepository', db: () => db });
