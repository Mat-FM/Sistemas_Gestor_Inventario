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

promesasReales(trasladoRepository, {
  insert: [{ idProducto: 5, idBodegaOrigen: 1, idBodegaDestino: 2, idLote: null, cantidad: 1, idUsuarioEnvia: 7 }],
  findById: [1],
}, { titulo: 'trasladoRepository', db: () => db });

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
