const trasladoRepository = require('../src/repositories/trasladoRepository');
const trasladoService = require('../src/services/trasladoService');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, fakeCatalogo } = require('./helpers/fixtures');

// Las capas de traslados por separado (RNF13): el repositorio contra PostgreSQL real y el servicio llamado sin HTTP. El
// comportamiento de punta a punta está en traslados.test.js.

const CLAVES_TRASLADO = [
  'id_traslado', 'id_producto', 'id_bodega_origen', 'id_bodega_destino', 'id_lote', 'cantidad', 'estado', 'fecha_envio',
  'fecha_recepcion', 'id_usuario_envia', 'id_usuario_recibe',
];

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

const datos = (extra = {}) => ({ idProducto: 5, idBodegaOrigen: b1, idBodegaDestino: b2, idLote: null, cantidad: 3, idUsuarioEnvia: 7, ...extra });

// Registra el SQL que ejecuta `cuerpo` con la conexión `conexion`.
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

describe('trasladoRepository', () => {
  describe('insert', () => {
    it('inserta EN_TRANSITO y devuelve el Traslado con exactamente sus 11 campos: números, fecha_envio como Date y los de la recepción en null', async () => {
      /* Traslado de la API: los campos de la recepción nacen vacíos. */
      const traslado = await trasladoRepository.insert(db, datos());
      expect(Object.keys(traslado).sort()).toEqual([...CLAVES_TRASLADO].sort());
      expect(traslado).toEqual({
        id_traslado: 1, id_producto: 5, id_bodega_origen: b1, id_bodega_destino: b2, id_lote: null, cantidad: 3, estado: 'EN_TRANSITO',
        fecha_envio: expect.any(Date), fecha_recepcion: null, id_usuario_envia: 7, id_usuario_recibe: null,
      });
    });

    it('fecha_envio es clock_timestamp() (el instante de la escritura) y no now() (el inicio de la transacción, D24)', async () => {
      /* El traslado se inserta con el saldo de origen ya bloqueado. */
      await db.transaction(async (trx) => {
        const { rows: [{ inicio }] } = await trx.raw('SELECT now() AS inicio');
        await trx.raw('SELECT pg_sleep(0.05)');
        const traslado = await trasladoRepository.insert(trx, datos());
        expect(traslado.fecha_envio.getTime()).toBeGreaterThan(inicio.getTime());
      });
    });

    it('los valores viajan como parámetros enlazados', async () => {
      /* Nada del cliente se pega al SQL. */
      const sql = await conSql(db, () => trasladoRepository.insert(db, datos({ idProducto: 54321, cantidad: 98765, idUsuarioEnvia: 4242 })));
      for (const texto of sql) expect(texto).not.toMatch(/54321|98765|4242/);
    });
  });

  describe('findById', () => {
    it('devuelve el Traslado con exactamente sus campos, o undefined si no existe; nunca usa SELECT *', async () => {
      /* Lectura sin bloqueo. */
      const creado = await trasladoRepository.insert(db, datos());
      const sql = await conSql(db, async () => {
        expect(await trasladoRepository.findById(db, creado.id_traslado)).toEqual(creado);
        expect(await trasladoRepository.findById(db, 9999)).toBeUndefined();
      });
      for (const texto of sql) expect(texto).not.toMatch(/\*/);
    });
  });
});

describe('trasladoRepository: recepción', () => {
  // ¿Está bloqueada la fila del traslado? Otra transacción intenta tomarla con un lock_timeout corto: 55P03 si alguien la tiene.
  async function estaBloqueado(id) {
    try {
      await db.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '150ms'");
        await trx('traslados').where({ id_traslado: id }).forUpdate().first();
      });
      return false;
    } catch (error) {
      if (error.code === '55P03') return true;
      throw error;
    }
  }

  it('bloquearPorId devuelve el Traslado (o undefined) y bloquea SU fila (FOR UPDATE) hasta el fin de la transacción, y solo esa', async () => {
    /* D31(d): el primer bloqueo de la recepción. Control: sin transacción abierta la fila está libre. */
    const uno = await trasladoRepository.insert(db, datos());
    const otro = await trasladoRepository.insert(db, datos());
    expect(await estaBloqueado(uno.id_traslado)).toBe(false);
    const trx = await db.transaction();
    try {
      expect(await trasladoRepository.bloquearPorId(trx, uno.id_traslado)).toEqual(uno);
      expect(await trasladoRepository.bloquearPorId(trx, 9999)).toBeUndefined();
      expect(await estaBloqueado(uno.id_traslado)).toBe(true);
      expect(await estaBloqueado(otro.id_traslado)).toBe(false);
    } finally {
      await trx.rollback();
    }
    expect(await estaBloqueado(uno.id_traslado)).toBe(false);
  });

  it('marcarRecibido pasa a RECIBIDO con fecha_recepcion = clock_timestamp() e id_usuario_recibe; sobre uno ya RECIBIDO (o inexistente) no hace nada', async () => {
    /* La condición EN_TRANSITO va en el WHERE. */
    const creado = await trasladoRepository.insert(db, datos());
    await db.transaction(async (trx) => {
      const { rows: [{ inicio }] } = await trx.raw('SELECT now() AS inicio');
      await trx.raw('SELECT pg_sleep(0.05)');
      const recibido = await trasladoRepository.marcarRecibido(trx, creado.id_traslado, { idUsuarioRecibe: 9 });
      expect(recibido).toEqual({ ...creado, estado: 'RECIBIDO', fecha_recepcion: expect.any(Date), id_usuario_recibe: 9 });
      expect(recibido.fecha_recepcion.getTime()).toBeGreaterThan(inicio.getTime());
    });
    expect(await trasladoRepository.marcarRecibido(db, creado.id_traslado, { idUsuarioRecibe: 10 })).toBeUndefined();
    expect(await trasladoRepository.marcarRecibido(db, 9999, { idUsuarioRecibe: 10 })).toBeUndefined();
    expect(await trasladoRepository.findById(db, creado.id_traslado)).toMatchObject({ estado: 'RECIBIDO', id_usuario_recibe: 9 });
  });
});

promesasReales(trasladoRepository, {
  insert: [{ idProducto: 5, idBodegaOrigen: 1, idBodegaDestino: 2, idLote: null, cantidad: 1, idUsuarioEnvia: 7 }],
  findById: [1],
  bloquearPorId: [1],
  marcarRecibido: [1, { idUsuarioRecibe: 9 }],
  listar: [{ limit: 10, offset: 0 }],
}, { titulo: 'trasladoRepository', db: () => db });

describe('trasladoRepository.listar', () => {
  let b3;
  beforeEach(async () => {
    b3 = (await crearBodega(db, { codigo: 'B3' })).id_bodega;
    await trasladoRepository.insert(db, datos());
    await trasladoRepository.insert(db, datos({ idBodegaOrigen: b2, idBodegaDestino: b3 }));
    await trasladoRepository.insert(db, datos({ idBodegaOrigen: b3, idBodegaDestino: b1 }));
    await trasladoRepository.marcarRecibido(db, 2, { idUsuarioRecibe: 9 });
  });

  it('total es numérico y cuenta TODAS las filas del filtro, no las de la página; limit y offset recortan solo las filas', async () => {
    /* `total` exacto aunque la página esté vacía. */
    expect(await trasladoRepository.listar(db, { limit: 1, offset: 1 })).toEqual({ filas: [expect.objectContaining({ id_traslado: 2 })], total: 3 });
    expect(await trasladoRepository.listar(db, { limit: 10, offset: 50 })).toEqual({ filas: [], total: 3 });
  });

  it('idBodega es origen O destino y se combina con estado con AND (el OR va entre paréntesis)', async () => {
    /* Sin paréntesis, `estado = X AND origen = B OR destino = B` dejaría pasar traslados de otro estado. */
    const ids = async (filtro) => (await trasladoRepository.listar(db, { ...filtro, limit: 10, offset: 0 })).filas.map((f) => f.id_traslado);
    expect(await ids({ idBodega: b2 })).toEqual([2, 1]);
    expect(await ids({ idBodega: b1, estado: 'RECIBIDO' })).toEqual([]);
    expect(await ids({ idBodega: b2, estado: 'RECIBIDO' })).toEqual([2]);
    expect(await ids({ estado: 'EN_TRANSITO' })).toEqual([3, 1]);
  });

  it('los valores del filtro viajan como parámetros enlazados y nunca usa SELECT *', async () => {
    /* Nada del cliente se pega al SQL. */
    const sql = await conSql(db, () => trasladoRepository.listar(db, { estado: 'EN_TRANSITO', idBodega: 54321, limit: 7, offset: 9876 }));
    expect(sql).toHaveLength(2);
    for (const texto of sql) expect(texto).not.toMatch(/54321|9876|EN_TRANSITO|select \*/i);
  });
});

describe('trasladoService.listar', () => {
  const OPERADOR = { idUsuario: 7, rol: 'OPERADOR_BODEGA', idBodega: 2, requestId: 'r1' };
  const INTERNA = { idUsuario: null, rol: null, idBodega: null, requestId: 'r1' };
  const FILTROS = { estado: 'RECIBIDO', limit: 5, offset: 10 };
  afterEach(() => jest.restoreAllMocks());

  it('un operador sin id_bodega recibe el filtro de SU bodega; con otra → 403 SIN consultar el repositorio', async () => {
    /* El alcance se decide en el servicio. */
    const espia = jest.spyOn(trasladoRepository, 'listar').mockResolvedValue({ filas: [], total: 0 });
    await trasladoService.listar(db, FILTROS, OPERADOR);
    expect(espia).toHaveBeenCalledWith(db, { ...FILTROS, idBodega: 2 });
    await expect(trasladoService.listar(db, { ...FILTROS, idBodega: 3 }, OPERADOR)).rejects.toMatchObject({ status: 403 });
    await expect(trasladoService.listar(db, FILTROS, { ...OPERADOR, idBodega: null })).rejects.toMatchObject({ status: 403 });
    expect(espia).toHaveBeenCalledTimes(1);
  });

  it('una llamada interna pasa el filtro tal cual; crearTrasladoService.listar usa la db de sus dependencias', async () => {
    /* D8. */
    const espia = jest.spyOn(trasladoRepository, 'listar').mockResolvedValue({ filas: [], total: 0 });
    expect(await trasladoService.crearTrasladoService({ db }).listar(FILTROS, INTERNA)).toEqual({ filas: [], total: 0 });
    expect(espia).toHaveBeenCalledWith(db, { ...FILTROS, idBodega: undefined });
  });
});

describe('trasladoService', () => {
  const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);
  const deps = (catalogo = fakeCatalogo()) => ({ db, clients: { catalogo }, logger: { info() {}, error() {} } });

  describe('crear', () => {
    const peticion = (extra = {}) => ({
      body: { id_producto: 5, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 2 }, claveIdempotencia: 'k1', identity: IDENTIDAD, ...extra,
    });
    beforeEach(() => crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 }));

    it('devuelve { traslado, movimiento, replayed: false } y luego el mismo con replayed: true', async () => {
      /* El controlador decide 201 o 200 con `replayed`. */
      const primera = await trasladoService.crear(deps(), peticion());
      expect(primera.replayed).toBe(false);
      expect(primera.movimiento).toMatchObject({ tipo: 'TRASLADO_SALIDA', id_traslado: primera.traslado.id_traslado });
      expect(await trasladoService.crear(deps(), peticion())).toEqual({ ...primera, replayed: true });
    });

    it('no toma una conexión de la base mientras espera al catálogo (la transacción se abre después)', async () => {
      /* Un catálogo lento no debe agotar el pool. */
      let tomadas;
      const catalogo = { obtenerProducto: jest.fn(async (id) => { tomadas = db.client.pool.numUsed(); return { id_producto: id }; }) };
      await trasladoService.crear(deps(catalogo), peticion());
      expect(catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
      expect(tomadas).toBe(0);
    });

    it('sin X-User-Id → 401 antes que la clave (una clave ausente no cambia el código)', async () => {
      /* D8, D22. */
      const error = await atrapar(trasladoService.crear(deps(), peticion({ identity: { ...IDENTIDAD, idUsuario: null }, claveIdempotencia: undefined })));
      expect(error).toMatchObject({ status: 401, codigo: 'NO_AUTENTICADO' });
    });

    it('un resultado vacío del catálogo (undefined) no confirma el producto: 404 y nada escrito (falla cerrado)', async () => {
      /* Solo un objeto confirma el producto. */
      const error = await atrapar(trasladoService.crear(deps({ obtenerProducto: jest.fn(async () => undefined) }), peticion()));
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      expect(await db('traslados')).toEqual([]);
    });

    it('lee las dependencias en cada llamada: el servicio se puede construir sin ellas (rutasDeclaradas())', async () => {
      /* Como el resto de servicios. */
      expect(() => trasladoService.crearTrasladoService()).not.toThrow();
      const tardias = {};
      const servicio = trasladoService.crearTrasladoService(tardias);
      Object.assign(tardias, deps());
      expect((await servicio.crear(peticion())).replayed).toBe(false);
    });

    it('un movimiento de traslado SIN traslado (estado imposible) → Error (500), nunca una respuesta inventada', async () => {
      /* La repetición resuelve el traslado por movimiento.id_traslado. */
      await db('movimientos').insert({
        tipo: 'TRASLADO_SALIDA', id_producto: 5, id_bodega: b1, cantidad: 1, saldo_resultante: 9, id_usuario: 7, clave_idempotencia: '7:tras:k-roto#salida',
      });
      const error = await atrapar(trasladoService.crear(deps(), peticion({ claveIdempotencia: 'k-roto' })));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('status');
    });
  });
});

describe('trasladoService.recibir', () => {
  const IDENTIDAD = { idUsuario: 8, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);
  const deps = () => ({ db, clients: { catalogo: { obtenerProducto: jest.fn() } }, logger: { info() {}, error() {} } });
  let creado;
  beforeEach(async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    creado = await trasladoService.crear({ ...deps(), clients: { catalogo: fakeCatalogo() } }, {
      body: { id_producto: 5, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 2 }, claveIdempotencia: 'k-c', identity: { ...IDENTIDAD, idUsuario: 7 },
    });
  });
  const peticion = (extra = {}) => ({ idTraslado: String(creado.traslado.id_traslado), body: {}, claveIdempotencia: 'k1', identity: IDENTIDAD, ...extra });

  it('devuelve { traslado RECIBIDO, movimiento TRASLADO_ENTRADA, replayed: false } y luego el mismo con replayed: true; no llama al catálogo', async () => {
    /* El producto se confirmó al crear. */
    const dependencias = deps();
    const primera = await trasladoService.recibir(dependencias, peticion());
    expect(primera).toMatchObject({ replayed: false, traslado: { estado: 'RECIBIDO', id_usuario_recibe: 8 }, movimiento: { tipo: 'TRASLADO_ENTRADA', id_bodega: b2 } });
    expect(await trasladoService.recibir(dependencias, peticion())).toEqual({ ...primera, replayed: true });
    expect(dependencias.clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
  });

  it('acepta el id ya convertido a número (llamada sin HTTP)', async () => {
    /* leerIdTraslado. */
    expect((await trasladoService.recibir(deps(), peticion({ idTraslado: creado.traslado.id_traslado }))).replayed).toBe(false);
  });

  it('orden: sin X-User-Id → 401 antes que la clave; sin clave → 400 antes que el id; id inválido → 404', async () => {
    /* requireUser → clave → id. */
    expect(await atrapar(trasladoService.recibir(deps(), peticion({ identity: { ...IDENTIDAD, idUsuario: null }, claveIdempotencia: undefined, idTraslado: 'x' })))).toMatchObject({ status: 401 });
    expect(await atrapar(trasladoService.recibir(deps(), peticion({ claveIdempotencia: undefined, idTraslado: 'x' })))).toMatchObject({ status: 400 });
    for (const idTraslado of ['x', 0, 1.5, -1, '2147483648']) {
      expect(await atrapar(trasladoService.recibir(deps(), peticion({ idTraslado })))).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
    }
  });

  it('crearTrasladoService expone recibir y lee las dependencias en cada llamada', async () => {
    /* Como crear. */
    const tardias = {};
    const servicio = trasladoService.crearTrasladoService(tardias);
    Object.assign(tardias, deps());
    expect((await servicio.recibir(peticion())).traslado.estado).toBe('RECIBIDO');
  });
});
