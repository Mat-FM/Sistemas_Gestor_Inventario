const conteoRepository = require('../src/repositories/conteoRepository');
const conteoService = require('../src/services/conteoService');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo } = require('./helpers/fixtures');

// Las capas de conteos por separado (RNF13): el repositorio contra PostgreSQL real y el servicio llamado sin HTTP. El
// comportamiento de punta a punta está en conteos.test.js.

const CLAVES_CABECERA = ['id_conteo', 'id_bodega', 'estado', 'fecha_programada', 'fecha_aprobacion', 'id_usuario_aprueba'];

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

// Registra el SQL (y sus parámetros) que ejecuta `cuerpo` con la conexión `conexion`.
async function conSql(conexion, cuerpo) {
  const sql = [];
  const registrar = (consulta) => sql.push(consulta.sql);
  conexion.on('query', registrar);
  try {
    await cuerpo();
  } finally {
    conexion.removeListener('query', registrar);
  }
  return sql;
}

const nuevoConteo = (extra = {}) => conteoRepository.insertarConteo(db, { idBodega: b1, fechaProgramada: '2026-11-20', ...extra });

describe('conteoRepository: programación', () => {
  it('insertarConteo inserta PROGRAMADO y devuelve la cabecera con exactamente sus 6 campos (fecha_programada como texto YYYY-MM-DD), sin clave_aprobacion', async () => {
    /* La cabecera de un Conteo de la API. */
    const conteo = await nuevoConteo();
    expect(Object.keys(conteo).sort()).toEqual([...CLAVES_CABECERA].sort());
    expect(conteo).toEqual({ id_conteo: 1, id_bodega: b1, estado: 'PROGRAMADO', fecha_programada: '2026-11-20', fecha_aprobacion: null, id_usuario_aprueba: null });
  });

  it('insertarDetalles sin idsProducto toma SOLO los saldos > 0 de ESA bodega, con cantidad_sistema = saldo, y devuelve cuántas líneas creó', async () => {
    /* D32(f). */
    await crearSaldo(db, { idProducto: 8, idBodega: b1, cantidad: 2 });
    await crearSaldo(db, { idProducto: 3, idBodega: b1, cantidad: 4 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
    await crearSaldo(db, { idProducto: 9, idBodega: b2, cantidad: 5 });
    const { id_conteo: idConteo } = await nuevoConteo();
    expect(await conteoRepository.insertarDetalles(db, { idConteo, idBodega: b1, idsProducto: null })).toBe(2);
    expect(await conteoRepository.listarDetalles(db, idConteo)).toEqual([
      { id_detalle_conteo: expect.any(Number), id_producto: 3, cantidad_sistema: 4, cantidad_contada: null, diferencia: null },
      { id_detalle_conteo: expect.any(Number), id_producto: 8, cantidad_sistema: 2, cantidad_contada: null, diferencia: null },
    ]);
    const vacio = await nuevoConteo({ idBodega: b2, fechaProgramada: '2026-11-21' });
    await db('saldos').where({ id_bodega: b2 }).update({ cantidad_disponible: 0 });
    expect(await conteoRepository.insertarDetalles(db, { idConteo: vacio.id_conteo, idBodega: b2, idsProducto: null })).toBe(0);
  });

  it('insertarDetalles con idsProducto crea una línea por id EN EL ORDEN recibido (id_detalle_conteo creciente), con 0 si no hay saldo; listarDetalles las ordena por id_producto', async () => {
    /* El orden de inserción es el de la lista: la prueba de interbloqueo de la aprobación depende de que NO sea el de id_producto. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 7, idBodega: b2, cantidad: 4 });
    const { id_conteo: idConteo } = await nuevoConteo();
    expect(await conteoRepository.insertarDetalles(db, { idConteo, idBodega: b1, idsProducto: [7, 5, 2] })).toBe(3);
    const porInsercion = await db('detalles_conteo').where({ id_conteo: idConteo }).orderBy('id_detalle_conteo').pluck('id_producto');
    expect(porInsercion).toEqual([7, 5, 2]);
    expect((await conteoRepository.listarDetalles(db, idConteo)).map((l) => [l.id_producto, l.cantidad_sistema])).toEqual([[2, 0], [5, 10], [7, 0]]);
  });

  it('los valores viajan como parámetros enlazados (también los ids de la lista)', async () => {
    /* Nada del cliente se pega al SQL. */
    const sql = await conSql(db, async () => {
      const { id_conteo: idConteo } = await conteoRepository.insertarConteo(db, { idBodega: b1, fechaProgramada: '2031-07-19' });
      await conteoRepository.insertarDetalles(db, { idConteo, idBodega: b1, idsProducto: [54321, 98765] });
      await conteoRepository.insertarDetalles(db, { idConteo, idBodega: 4242, idsProducto: null });
    });
    for (const texto of sql) expect(texto).not.toMatch(/54321|98765|4242|2031-07-19/);
  });

  it('findById devuelve el Conteo con sus detalles (por id_producto), o undefined; nunca usa SELECT * ni devuelve clave_aprobacion', async () => {
    /* D32(i). */
    const cabecera = await nuevoConteo();
    await conteoRepository.insertarDetalles(db, { idConteo: cabecera.id_conteo, idBodega: b1, idsProducto: [9, 4] });
    await db('conteos').update({ clave_aprobacion: '7:con:secreta' });
    const sql = await conSql(db, async () => {
      const conteo = await conteoRepository.findById(db, cabecera.id_conteo);
      expect(conteo).toEqual({ ...cabecera, detalles: [expect.objectContaining({ id_producto: 4 }), expect.objectContaining({ id_producto: 9 })] });
      expect(await conteoRepository.findById(db, 9999)).toBeUndefined();
    });
    for (const texto of sql) expect(texto).not.toMatch(/\*/);
  });
});

describe('conteoRepository.listar', () => {
  beforeEach(async () => {
    await nuevoConteo({ fechaProgramada: '2026-11-20' });
    await nuevoConteo({ idBodega: b2, fechaProgramada: '2026-11-25' });
    await nuevoConteo({ fechaProgramada: '2026-11-25' });
    await db('conteos').where({ id_conteo: 2 }).update({ estado: 'EN_REVISION' });
  });

  it('total numérico de TODAS las filas del filtro; limit y offset recortan solo las filas; cada fila es la cabecera (sin detalles)', async () => {
    /* `total` exacto aunque la página esté vacía. */
    const pagina = await conteoRepository.listar(db, { limit: 1, offset: 1 });
    expect(pagina).toEqual({ filas: [expect.objectContaining({ id_conteo: 2 })], total: 3 });
    expect(Object.keys(pagina.filas[0]).sort()).toEqual([...CLAVES_CABECERA].sort());
    expect(await conteoRepository.listar(db, { limit: 10, offset: 50 })).toEqual({ filas: [], total: 3 });
  });

  it('ordena por fecha_programada DESC e id_conteo DESC; filtra por estado e idBodega (AND)', async () => {
    /* Orden total y estable. */
    const ids = async (filtro) => (await conteoRepository.listar(db, { ...filtro, limit: 10, offset: 0 })).filas.map((f) => f.id_conteo);
    expect(await ids({})).toEqual([3, 2, 1]);
    expect(await ids({ idBodega: b1 })).toEqual([3, 1]);
    expect(await ids({ idBodega: b2, estado: 'EN_REVISION' })).toEqual([2]);
    expect(await ids({ idBodega: b1, estado: 'EN_REVISION' })).toEqual([]);
  });

  it('los valores del filtro viajan como parámetros enlazados y nunca usa SELECT *', async () => {
    /* Nada del cliente se pega al SQL. */
    const sql = await conSql(db, () => conteoRepository.listar(db, { estado: 'EN_REVISION', idBodega: 54321, limit: 7, offset: 9876 }));
    expect(sql).toHaveLength(2);
    for (const texto of sql) expect(texto).not.toMatch(/54321|9876|EN_REVISION|select \*/i);
  });
});

promesasReales(conteoRepository, {
  insertarConteo: [{ idBodega: 1, fechaProgramada: '2026-11-20' }],
  insertarDetalles: [{ idConteo: 1, idBodega: 1, idsProducto: null }], // sin saldos no inserta nada (el conteo 1 no existe)
  listarDetalles: [1],
  findById: [1],
  listar: [{ limit: 10, offset: 0 }],
}, { titulo: 'conteoRepository', db: () => db });

describe('conteoService: programar, obtener y listar', () => {
  const ADMIN = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const OPERADOR = { idUsuario: 8, rol: 'OPERADOR_BODEGA', idBodega: 2, requestId: 'r1' };
  const INTERNA = { idUsuario: null, rol: null, idBodega: null, requestId: 'r1' };
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);
  const cuerpo = (extra = {}) => ({ id_bodega: b1, fecha_programada: '2026-11-20', ids_producto: [5], ...extra });
  afterEach(() => jest.restoreAllMocks());

  it('programar devuelve el Conteo con detalles y usa el reloj de sus dependencias (`now`), leído en cada llamada', async () => {
    /* D32(g): el reloj es inyectable. */
    let ahora = new Date('2026-11-20T10:00:00Z');
    const deps = { db, now: () => ahora };
    const conteo = await conteoService.programar(deps, { body: cuerpo(), identity: ADMIN });
    expect(conteo).toMatchObject({ estado: 'PROGRAMADO', fecha_programada: '2026-11-20', detalles: [{ id_producto: 5, cantidad_sistema: 0 }] });
    ahora = new Date('2026-11-21T00:00:00Z');
    expect(await atrapar(conteoService.programar(deps, { body: cuerpo(), identity: ADMIN }))).toMatchObject({ status: 422, detalles: [{ campo: 'fecha_programada' }] });
  });

  it('sin `now` usa la hora real: una fecha muy lejana se acepta y una muy pasada no', async () => {
    /* Por omisión () => new Date(). */
    expect((await conteoService.programar({ db }, { body: cuerpo({ fecha_programada: '9999-12-31' }), identity: ADMIN })).estado).toBe('PROGRAMADO');
    expect(await atrapar(conteoService.programar({ db }, { body: cuerpo({ fecha_programada: '2000-01-01' }), identity: ADMIN }))).toMatchObject({ status: 422 });
  });

  it('un reloj que no devuelve una fecha válida es un error de programación (TypeError, un 500), nunca un 422 inventado', async () => {
    /* Falla cerrado. */
    for (const now of [() => new Date('x'), () => '2026-11-20', () => undefined]) {
      expect(await atrapar(conteoService.programar({ db, now }, { body: cuerpo(), identity: ADMIN }))).toBeInstanceOf(TypeError);
    }
    expect(await db('conteos')).toEqual([]);
  });

  it('programar: sin X-User-Id → 401 antes de validar el cuerpo', async () => {
    /* D8, D22. */
    expect(await atrapar(conteoService.programar({ db }, { body: [], identity: INTERNA }))).toMatchObject({ status: 401, codigo: 'NO_AUTENTICADO' });
  });

  it('obtener: un operador sin bodega → 403 SIN consultar el repositorio; el id admite el número ya convertido', async () => {
    /* Como obtenerMovimiento. */
    const creado = await conteoService.programar({ db }, { body: cuerpo({ fecha_programada: '9999-12-31' }), identity: ADMIN });
    const espia = jest.spyOn(conteoRepository, 'findById');
    expect(await atrapar(conteoService.obtener({ db }, { idConteo: '1', identity: { ...OPERADOR, idBodega: null } }))).toMatchObject({ status: 403 });
    expect(espia).not.toHaveBeenCalled();
    expect(await conteoService.obtener({ db }, { idConteo: creado.id_conteo, identity: INTERNA })).toEqual(creado);
    for (const idConteo of ['x', 0, 1.5, -1, '2147483648']) {
      expect(await atrapar(conteoService.obtener({ db }, { idConteo, identity: ADMIN }))).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
    }
  });

  it('listar: un operador sin id_bodega recibe el filtro de SU bodega; con otra → 403 sin consultar; una llamada interna pasa el filtro tal cual', async () => {
    /* El alcance se decide en el servicio. */
    const FILTROS = { estado: 'APROBADO', limit: 5, offset: 10 };
    const espia = jest.spyOn(conteoRepository, 'listar').mockResolvedValue({ filas: [], total: 0 });
    await conteoService.listar({ db }, { ...FILTROS, identity: OPERADOR });
    expect(espia).toHaveBeenLastCalledWith(db, { ...FILTROS, idBodega: 2 });
    expect(await atrapar(conteoService.listar({ db }, { ...FILTROS, idBodega: 3, identity: OPERADOR }))).toMatchObject({ status: 403 });
    await conteoService.listar({ db }, { ...FILTROS, idBodega: 4, identity: INTERNA });
    expect(espia).toHaveBeenLastCalledWith(db, { ...FILTROS, idBodega: 4 });
    expect(espia).toHaveBeenCalledTimes(2);
  });

  it('crearConteoService se construye sin dependencias y las lee en cada llamada', async () => {
    /* rutasDeclaradas() se llama sin dependencias. */
    expect(() => conteoService.crearConteoService()).not.toThrow();
    const tardias = {};
    const servicio = conteoService.crearConteoService(tardias);
    Object.assign(tardias, { db, now: () => new Date('2026-11-01T00:00:00Z') });
    expect((await servicio.programar({ body: cuerpo(), identity: ADMIN })).estado).toBe('PROGRAMADO');
    expect((await servicio.listar({ limit: 5, offset: 0, identity: ADMIN })).total).toBe(1);
  });
});
