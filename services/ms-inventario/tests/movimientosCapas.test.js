const movimientoRepository = require('../src/repositories/movimientoRepository');
const movimientoService = require('../src/services/movimientoService');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { TIPOS, TIPOS_PERMITIDOS_POR_API } = require('../src/domain/tipos');
const { crearBodega, crearMovimiento, crearSaldo, crearUmbral, fakeCatalogo, fakeNotificaciones } = require('./helpers/fixtures');

// Las capas de movimientos por separado (RNF13): el repositorio contra PostgreSQL real y el servicio llamado sin HTTP. El motor
// está en stock.test.js y el comportamiento de punta a punta en movimientos.test.js.

const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];

let db;
let b1;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(async () => {
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
});
afterAll(() => db.destroy());

const fila = (extra = {}) => ({
  tipo: 'ENTRADA', idProducto: 5, idBodega: b1, cantidad: 3, saldoResultante: 3, idUsuario: 7, claveIdempotencia: '7:k1', ...extra,
});

describe('movimientoRepository', () => {
  describe('insert', () => {
    it('inserta y devuelve el Movimiento con exactamente sus 13 campos (sin clave_idempotencia), con números y la fecha como Date', async () => {
      const movimiento = await movimientoRepository.insert(db, fila({ documentoReferencia: 'FAC-1', observacion: 'nota' }));
      expect(Object.keys(movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
      expect(movimiento).toEqual({
        id_movimiento: 1, tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, id_lote: null, id_traslado: null, id_conteo: null,
        cantidad: 3, saldo_resultante: 3, fecha: expect.any(Date), id_usuario: 7, documento_referencia: 'FAC-1', observacion: 'nota',
      });
      const guardada = await db('movimientos').first();
      expect(guardada.clave_idempotencia).toBe('7:k1');
    });

    it('la fecha es clock_timestamp() (el instante de la escritura) y no now() (el inicio de la transacción, D24)', async () => {
      await db.transaction(async (trx) => {
        await trx.raw('SELECT now()');
        await trx.raw('SELECT pg_sleep(0.01)');
        const movimiento = await movimientoRepository.insert(trx, fila());
        const { rows: [{ posterior }] } = await trx.raw('SELECT fecha > now() AS posterior FROM movimientos WHERE id_movimiento = ?', [movimiento.id_movimiento]);
        expect(posterior).toBe(true);
      });
    });

    it('los valores viajan como parámetros enlazados', async () => {
      const consultas = [];
      const registrar = (consulta) => consultas.push(consulta);
      db.on('query', registrar);
      try {
        await movimientoRepository.insert(db, fila({ idProducto: 54321, cantidad: 98765, saldoResultante: 98765, claveIdempotencia: '7:clave-centinela' }));
      } finally {
        db.removeListener('query', registrar);
      }
      for (const { sql } of consultas) expect(sql).not.toMatch(/54321|98765|centinela/);
    });

    it('una clave repetida lanza el 23505 de movimientos_clave_idempotencia_key', async () => {
      await movimientoRepository.insert(db, fila());
      await expect(movimientoRepository.insert(db, fila({ cantidad: 9 }))).rejects.toMatchObject({ code: '23505', constraint: 'movimientos_clave_idempotencia_key' });
    });
  });

  describe('findByClave', () => {
    it('devuelve el movimiento con la clave ALMACENADA exacta (sin clave_idempotencia), o undefined', async () => {
      const creado = await movimientoRepository.insert(db, fila({ claveIdempotencia: '7:k1' }));
      expect(await movimientoRepository.findByClave(db, '7:k1')).toEqual(creado);
      expect(await movimientoRepository.findByClave(db, 'k1')).toBeUndefined();
      expect(await movimientoRepository.findByClave(db, '8:k1')).toBeUndefined();
      expect(await movimientoRepository.findByClave(db, '7:K1')).toBeUndefined();
    });

    it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado', async () => {
      await db.transaction(async (trx) => {
        await movimientoRepository.insert(trx, fila());
        expect(await movimientoRepository.findByClave(trx, '7:k1')).toMatchObject({ cantidad: 3 });
        expect(await movimientoRepository.findByClave(db, '7:k1')).toBeUndefined();
      });
    });
  });

  describe('listar (el kardex, RF10 y RF15)', () => {
    let b2;
    const claves = (filas) => filas.map((fila) => fila.id_movimiento);
    // Los ids de las filas sembradas, para leerlos en la tabla de abajo.
    //  id  bodega  producto  usuario  tipo       fecha
    //  1   b1      5         7        ENTRADA    2026-11-02T10:00Z
    //  2   b1      6         8        SALIDA     2026-11-01T10:00Z
    //  3   b2      5         7        SALIDA     2026-11-03T10:00Z   (misma fecha que el 4)
    //  4   b2      6         9        AJUSTE     2026-11-03T10:00Z
    //  5   b1      5         8        ENTRADA    2026-11-04T10:00Z
    // Orden esperado, fecha DESC e id DESC: 5, 4, 3, 1, 2.
    beforeEach(async () => {
      b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
      await crearMovimiento(db, { idBodega: b1, idProducto: 5, idUsuario: 7, tipo: 'ENTRADA', fecha: '2026-11-02T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b1, idProducto: 6, idUsuario: 8, tipo: 'SALIDA', fecha: '2026-11-01T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b2, idProducto: 5, idUsuario: 7, tipo: 'SALIDA', fecha: '2026-11-03T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b2, idProducto: 6, idUsuario: 9, tipo: 'AJUSTE', cantidad: -1, fecha: '2026-11-03T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b1, idProducto: 5, idUsuario: 8, tipo: 'ENTRADA', fecha: '2026-11-04T10:00:00Z' });
    });

    it('devuelve { filas, total } ordenado por fecha DESC e id_movimiento DESC (desempate), con exactamente los 13 campos de un Movimiento', async () => {
      const { filas, total } = await movimientoRepository.listar(db, { limit: 10, offset: 0 });
      expect(claves(filas)).toEqual([5, 4, 3, 1, 2]);
      expect(total).toBe(5);
      expect(Object.keys(filas[0]).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
      expect(filas[0].fecha).toBeInstanceOf(Date);
      const { clave_idempotencia: claveIdempotencia, ...guardada } = await db('movimientos').where({ id_movimiento: 5 }).first();
      expect(claveIdempotencia).toEqual(expect.any(String)); // control: la columna existe y la fila no la devuelve
      expect(filas[0]).toEqual(guardada);
    });

    it('total es numérico y cuenta TODAS las filas del filtro, no las de la página; limit y offset recortan solo las filas', async () => {
      const { filas, total } = await movimientoRepository.listar(db, { limit: 2, offset: 2 });
      expect(claves(filas)).toEqual([3, 1]);
      expect(typeof total).toBe('number');
      expect(total).toBe(5);
    });

    it('una página fuera de rango devuelve filas vacías y el total exacto, aun con un desplazamiento mayor que el INTEGER', async () => {
      expect(await movimientoRepository.listar(db, { limit: 10, offset: 100 })).toEqual({ filas: [], total: 5 });
      expect(await movimientoRepository.listar(db, { limit: 100, offset: 214748364600 })).toEqual({ filas: [], total: 5 });
    });

    // Cada filtro es una función porque el id de b2 lo fija el beforeEach.
    it.each([
      ['idProducto', () => ({ idProducto: 5 }), [5, 3, 1]],
      ['idBodega', () => ({ idBodega: b2 }), [4, 3]],
      ['idUsuario', () => ({ idUsuario: 8 }), [5, 2]],
      ['tipo', () => ({ tipo: 'ENTRADA' }), [5, 1]],
      ['fechaDesde', () => ({ fechaDesde: '2026-11-03' }), [5, 4, 3]],
      ['fechaHasta', () => ({ fechaHasta: '2026-11-02' }), [1, 2]],
    ])('%s filtra filas y total con el MISMO criterio (el COUNT y la página comparten el WHERE)', async (_filtro, filtro, esperados) => {
      const pagina = await movimientoRepository.listar(db, { ...filtro(), limit: 1, offset: 0 });
      expect(claves(pagina.filas)).toEqual(esperados.slice(0, 1)); // la página trae solo 1 fila…
      expect(pagina.total).toBe(esperados.length); // …pero el total es el del filtro
      const completa = await movimientoRepository.listar(db, { ...filtro(), limit: 10, offset: 0 });
      expect(claves(completa.filas)).toEqual(esperados);
    });

    it('los filtros se combinan con AND y un filtro undefined no restringe', async () => {
      const lista = (filtro) => movimientoRepository.listar(db, { limit: 10, offset: 0, ...filtro });
      expect(claves((await lista({ idProducto: 5, idBodega: b1 })).filas)).toEqual([5, 1]);
      expect(claves((await lista({ idProducto: 5, idUsuario: 8, tipo: 'ENTRADA' })).filas)).toEqual([5]);
      expect(claves((await lista({ idBodega: b2, tipo: 'AJUSTE', fechaDesde: '2026-11-03', fechaHasta: '2026-11-03' })).filas)).toEqual([4]);
      expect(await lista({ idProducto: 5, idBodega: b2, idUsuario: 9 })).toEqual({ filas: [], total: 0 });
      const sinFiltros = await lista({ idProducto: undefined, idBodega: undefined, idUsuario: undefined, tipo: undefined, fechaDesde: undefined, fechaHasta: undefined });
      expect(sinFiltros.total).toBe(5);
    });

    it('los valores del filtro viajan como parámetros enlazados: ninguno se interpola en el texto de la consulta', async () => {
      const consultas = [];
      const registrar = (consulta) => consultas.push(consulta);
      db.on('query', registrar);
      try {
        await movimientoRepository.listar(db, {
          idProducto: 54321, idBodega: 98765, idUsuario: 13579, tipo: 'ENTRADA', fechaDesde: '2026-11-01', fechaHasta: '2026-11-30', limit: 77, offset: 33,
        });
      } finally {
        db.removeListener('query', registrar);
      }
      expect(consultas.length).toBeGreaterThan(0);
      for (const { sql } of consultas) expect(sql).not.toMatch(/54321|98765|13579|ENTRADA|2026-11|\b77\b|\b33\b/);
      const enlazados = consultas.flatMap(({ bindings }) => bindings);
      expect(enlazados).toEqual(expect.arrayContaining([54321, 98765, 13579, 'ENTRADA', '2026-11-01', '2026-11-30', 77, 33]));
    });

    it('nunca usa SELECT * ni nombra clave_idempotencia', async () => {
      const consultas = [];
      const registrar = (consulta) => consultas.push(consulta.sql);
      db.on('query', registrar);
      try {
        await movimientoRepository.listar(db, { limit: 10, offset: 0 });
      } finally {
        db.removeListener('query', registrar);
      }
      for (const sql of consultas.filter((texto) => /^select/i.test(texto) && !/count\(/i.test(texto))) {
        expect(sql).not.toMatch(/\*|clave_idempotencia/);
      }
    });

    it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado y un rollback no deja nada', async () => {
      await expect(db.transaction(async (trx) => {
        await crearMovimiento(trx, { idBodega: b1, idProducto: 77, fecha: '2026-11-05T10:00:00Z' });
        expect((await movimientoRepository.listar(trx, { idProducto: 77, limit: 10, offset: 0 })).total).toBe(1);
        expect((await movimientoRepository.listar(db, { idProducto: 77, limit: 10, offset: 0 })).total).toBe(0); // desde fuera no se ve
        throw new Error('deshacer');
      })).rejects.toThrow('deshacer');
      expect((await movimientoRepository.listar(db, { idProducto: 77, limit: 10, offset: 0 })).total).toBe(0);
    });
  });

  describe('listar: fecha_desde y fecha_hasta son días UTC, sin importar el huso de la sesión (D29)', () => {
    // Cuatro movimientos pegados a las medianoches UTC, con MICROsegundos (la base guarda microsegundos, JavaScript solo milisegundos):
    //  1  2026-10-31T23:59:59.999999Z   2  2026-11-01T00:00:00Z   3  2026-11-01T23:59:59.999999Z   4  2026-11-02T00:00:00Z
    beforeEach(async () => {
      for (const fecha of ['2026-10-31T23:59:59.999999Z', '2026-11-01T00:00:00Z', '2026-11-01T23:59:59.999999Z', '2026-11-02T00:00:00Z']) {
        await crearMovimiento(db, { idBodega: b1, fecha });
      }
    });
    const CASOS = [
      [{ fechaDesde: '2026-11-01' }, [4, 3, 2]],
      [{ fechaHasta: '2026-11-01' }, [3, 2, 1]],
      [{ fechaDesde: '2026-11-01', fechaHasta: '2026-11-01' }, [3, 2]],
      [{ fechaDesde: '2026-11-02', fechaHasta: '2026-11-02' }, [4]],
      [{ fechaHasta: '2026-10-31' }, [1]],
      [{}, [4, 3, 2, 1]],
    ];

    it.each(['UTC', 'America/Bogota', 'Pacific/Auckland'])('con la zona de la sesión en %s (dentro de una transacción) el resultado es el mismo que en UTC', async (zona) => {
      await db.transaction(async (trx) => {
        await trx.raw("SELECT set_config('TimeZone', ?, true)", [zona]);
        expect((await trx.raw('SHOW TimeZone')).rows[0].TimeZone).toBe(zona); // control: la sesión sí está en esa zona
        for (const [filtro, esperados] of CASOS) {
          const { filas, total } = await movimientoRepository.listar(trx, { ...filtro, limit: 10, offset: 0 });
          expect({ zona, filtro, ids: filas.map((fila) => fila.id_movimiento), total }).toEqual({ zona, filtro, ids: esperados, total: esperados.length });
        }
      });
    });

    it('fecha_hasta incluye hasta el último microsegundo del día y excluye el primero del siguiente', async () => {
      const dia = await movimientoRepository.listar(db, { fechaHasta: '2026-11-01', limit: 10, offset: 0 });
      expect(dia.filas.map((fila) => fila.id_movimiento)).toEqual([3, 2, 1]); // el 3 está a 1 µs de terminar el día
      expect(dia.filas.map((fila) => fila.id_movimiento)).not.toContain(4); // el 4 es el primer instante del día siguiente
    });
  });

  describe('findById', () => {
    it('devuelve el Movimiento con exactamente sus 13 campos (sin clave_idempotencia), o undefined si no existe', async () => {
      const creado = await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T10:00:00Z', documentoReferencia: 'FAC-1', observacion: 'nota', claveIdempotencia: '7:centinela' });
      const movimiento = await movimientoRepository.findById(db, creado.id_movimiento);
      expect(Object.keys(movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
      expect(movimiento).toEqual({
        id_movimiento: creado.id_movimiento, tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, id_lote: null, id_traslado: null, id_conteo: null,
        cantidad: 1, saldo_resultante: 1, fecha: new Date('2026-11-01T10:00:00Z'), id_usuario: 7, documento_referencia: 'FAC-1', observacion: 'nota',
      });
      expect(await movimientoRepository.findById(db, creado.id_movimiento + 1)).toBeUndefined();
    });

    it('el id viaja como parámetro enlazado y solo toca esa fila', async () => {
      await crearMovimiento(db, { idBodega: b1 });
      // Un id fácil de reconocer en el texto de la consulta (los marcadores $1 y $2 ya contienen dígitos pequeños).
      await db.raw("SELECT setval(pg_get_serial_sequence('movimientos', 'id_movimiento'), 54320)");
      const otro = await crearMovimiento(db, { idBodega: b1, idProducto: 9 });
      expect(otro.id_movimiento).toBe(54321);
      const consultas = [];
      const registrar = (consulta) => consultas.push(consulta);
      db.on('query', registrar);
      try {
        expect((await movimientoRepository.findById(db, otro.id_movimiento)).id_producto).toBe(9);
      } finally {
        db.removeListener('query', registrar);
      }
      expect(consultas).toHaveLength(1);
      expect(consultas[0].bindings).toContain(otro.id_movimiento);
      expect(consultas[0].sql).not.toMatch(new RegExp(`\\b${otro.id_movimiento}\\b`));
    });

    it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado', async () => {
      await db.transaction(async (trx) => {
        const { id_movimiento: id } = await crearMovimiento(trx, { idBodega: b1 });
        expect(await movimientoRepository.findById(trx, id)).toMatchObject({ id_movimiento: id });
        expect(await movimientoRepository.findById(db, id)).toBeUndefined();
      });
    });
  });
});

// Cada función que exporta el repositorio con sus argumentos: todas son asíncronas.
promesasReales(movimientoRepository, {
  insert: [{ tipo: 'ENTRADA', idProducto: 5, idBodega: 1, cantidad: 3, saldoResultante: 3, idUsuario: 7, claveIdempotencia: '7:promesa' }],
  findByClave: ['7:k1'],
  listar: [{ limit: 10, offset: 0 }],
  findById: [1],
}, { titulo: 'movimientoRepository', db: () => db });

describe('movimientoService', () => {
  const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);

  // claveAlmacenada, derivada y leerClaveIdempotencia se prueban en idempotencia.test.js.

  describe('registrarMovimiento', () => {
    const peticion = (extra = {}) => ({
      body: { tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, cantidad: 2 }, claveIdempotencia: 'k1', identity: IDENTIDAD, ...extra,
    });
    const deps = (catalogo = fakeCatalogo()) => ({ db, clients: { catalogo }, logger: { info() {}, error() {} } });

    it('devuelve { movimiento, replayed: false } y luego { movimiento, replayed: true } con el mismo movimiento', async () => {
      const primera = await movimientoService.registrarMovimiento(deps(), peticion());
      const segunda = await movimientoService.registrarMovimiento(deps(), peticion());
      expect(primera.replayed).toBe(false);
      expect(segunda).toEqual({ movimiento: primera.movimiento, replayed: true });
    });

    it('no toma una conexión de la base mientras espera al catálogo (la transacción se abre después)', async () => {
      let tomadas;
      const catalogo = { obtenerProducto: jest.fn(async (id) => { tomadas = db.client.pool.numUsed(); return { id_producto: id }; }) };
      await movimientoService.registrarMovimiento(deps(catalogo), peticion());
      expect(catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
      expect(tomadas).toBe(0);
    });

    it('sin X-User-Id → 401 antes que la clave (una clave ausente no cambia el código)', async () => {
      const error = await atrapar(movimientoService.registrarMovimiento(deps(), peticion({ identity: { ...IDENTIDAD, idUsuario: null }, claveIdempotencia: undefined })));
      expect(error).toMatchObject({ status: 401, codigo: 'NO_AUTENTICADO' });
    });

    it('un resultado vacío del catálogo (undefined) no confirma el producto: 404 y nada escrito (falla cerrado)', async () => {
      const catalogo = { obtenerProducto: jest.fn(async () => undefined) };
      const error = await atrapar(movimientoService.registrarMovimiento(deps(catalogo), peticion()));
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      expect(await db('movimientos')).toEqual([]);
    });

    it('lee las dependencias en cada llamada: el servicio se puede construir sin ellas (rutasDeclaradas())', async () => {
      expect(() => movimientoService.crearMovimientoService()).not.toThrow();
      const tardias = {};
      const servicio = movimientoService.crearMovimientoService(tardias);
      Object.assign(tardias, deps());
      expect((await servicio.registrar(peticion())).replayed).toBe(false);
    });

    it('un fallo síncrono del catálogo llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      let resultado;
      expect(() => { resultado = movimientoService.registrarMovimiento(deps({ obtenerProducto: () => { throw falla; } }), peticion()); }).not.toThrow();
      await expect(resultado).rejects.toBe(falla);
    });
  });

  const OPERADOR = { idUsuario: 7, rol: 'OPERADOR_BODEGA', idBodega: 2, requestId: 'r1' };
  const INTERNA = { idUsuario: null, rol: null, idBodega: null, requestId: 'r1' };

  // El kardex (RF10, RF15): el alcance del operador de bodega se decide aquí, en el servicio, y no en el controlador. El
  // repositorio real se vigila con un espía (movimientoRepository es un módulo, y el servicio lo lee en cada llamada).
  describe('listarMovimientos', () => {
    const consulta = (extra = {}) => ({ identity: IDENTIDAD, limit: 20, offset: 0, ...extra });
    const deps = () => ({ db });
    afterEach(() => jest.restoreAllMocks());
    const espiar = () => jest.spyOn(movimientoRepository, 'listar').mockResolvedValue({ filas: [], total: 0 });

    it('un operador con otra bodega → 403 SIN_PERMISO y NO consulta el repositorio', async () => {
      const listar = espiar();
      const error = await atrapar(movimientoService.listarMovimientos(deps(), consulta({ identity: OPERADOR, idBodega: 3 })));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(listar).not.toHaveBeenCalled();
    });

    it('un operador sin bodega asignada → 403 SIN_PERMISO, con y sin id_bodega, y NO consulta el repositorio', async () => {
      const listar = espiar();
      for (const idBodega of [undefined, 2]) {
        const error = await atrapar(movimientoService.listarMovimientos(deps(), consulta({ identity: { ...OPERADOR, idBodega: null }, idBodega })));
        expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      }
      expect(listar).not.toHaveBeenCalled();
    });

    it('un operador sin id_bodega recibe el filtro de SU bodega; con la propia también; el resto del filtro pasa intacto', async () => {
      const listar = espiar();
      const resto = { idProducto: 5, idUsuario: 9, tipo: 'SALIDA', fechaDesde: '2026-11-01', fechaHasta: '2026-11-02', limit: 20, offset: 40 };
      await movimientoService.listarMovimientos(deps(), consulta({ identity: OPERADOR, ...resto }));
      await movimientoService.listarMovimientos(deps(), consulta({ identity: OPERADOR, idBodega: 2, ...resto }));
      expect(listar).toHaveBeenNthCalledWith(1, db, { ...resto, idBodega: 2 });
      expect(listar).toHaveBeenNthCalledWith(2, db, { ...resto, idBodega: 2 });
    });

    it.each([['un administrador', IDENTIDAD], ['una llamada interna', INTERNA]])('%s: el filtro pasa tal cual, con o sin id_bodega', async (_nombre, identity) => {
      const listar = espiar();
      const filtro = { idProducto: 5, idBodega: 3, idUsuario: 9, tipo: 'AJUSTE', fechaDesde: '2026-11-01', fechaHasta: '2026-11-02', limit: 100, offset: 200 };
      await movimientoService.listarMovimientos(deps(), consulta({ identity, ...filtro }));
      await movimientoService.listarMovimientos(deps(), consulta({ identity, limit: 20, offset: 0 }));
      expect(listar).toHaveBeenNthCalledWith(1, db, filtro);
      expect(listar).toHaveBeenNthCalledWith(2, db, {
        idProducto: undefined, idBodega: undefined, idUsuario: undefined, tipo: undefined, fechaDesde: undefined, fechaHasta: undefined, limit: 20, offset: 0,
      });
    });

    it('devuelve { filas, total } tal como los entrega el repositorio', async () => {
      const filas = [{ id_movimiento: 3 }, { id_movimiento: 1 }];
      jest.spyOn(movimientoRepository, 'listar').mockResolvedValue({ filas, total: 9 });
      expect(await movimientoService.listarMovimientos(deps(), consulta())).toEqual({ filas, total: 9 });
    });

    it('con la base real: un operador recibe solo los movimientos de su bodega y el total de ESA bodega', async () => {
      const b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
      await crearMovimiento(db, { idBodega: b1, fecha: '2026-11-01T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b2, fecha: '2026-11-02T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b2, fecha: '2026-11-03T10:00:00Z' });
      const { filas, total } = await movimientoService.listarMovimientos(deps(), consulta({ identity: { ...OPERADOR, idBodega: b2 } }));
      expect(filas.map((fila) => fila.id_movimiento)).toEqual([3, 2]);
      expect(total).toBe(2);
      expect((await movimientoService.listarMovimientos(deps(), consulta())).total).toBe(3); // control: el administrador ve las tres
    });

    it('un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      jest.spyOn(movimientoRepository, 'listar').mockImplementation(() => { throw falla; });
      let resultado;
      expect(() => { resultado = movimientoService.listarMovimientos(deps(), consulta()); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });
  });

  describe('obtenerMovimiento', () => {
    const deps = () => ({ db });
    const delB2 = { id_movimiento: 5, id_bodega: 2 };
    afterEach(() => jest.restoreAllMocks());
    const espiar = (movimiento) => jest.spyOn(movimientoRepository, 'findById').mockResolvedValue(movimiento);

    it('devuelve el movimiento que entrega el repositorio, tal cual, a cualquier rol y a la llamada interna', async () => {
      const findById = espiar(delB2);
      for (const identity of [IDENTIDAD, INTERNA, { ...IDENTIDAD, rol: 'CONTADOR' }, { ...IDENTIDAD, rol: 'VENDEDOR' }]) {
        expect(await movimientoService.obtenerMovimiento(deps(), { identity, id: 5 })).toBe(delB2);
      }
      expect(findById).toHaveBeenCalledWith(db, 5);
    });

    it('sin movimiento → 404 NO_EXISTE (y para un undefined del repositorio, nada más)', async () => {
      espiar(undefined);
      const error = await atrapar(movimientoService.obtenerMovimiento(deps(), { identity: IDENTIDAD, id: 5 }));
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
    });

    it('un operador ve el de SU bodega; el de OTRA bodega → 403 SIN_PERMISO', async () => {
      espiar(delB2);
      expect(await movimientoService.obtenerMovimiento(deps(), { identity: OPERADOR, id: 5 })).toBe(delB2);
      const error = await atrapar(movimientoService.obtenerMovimiento(deps(), { identity: { ...OPERADOR, idBodega: 3 }, id: 5 }));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
    });

    it('un operador sin bodega asignada → 403 SIN_PERMISO SIN consultar la base (exista o no el movimiento)', async () => {
      const findById = espiar(delB2);
      const error = await atrapar(movimientoService.obtenerMovimiento(deps(), { identity: { ...OPERADOR, idBodega: null }, id: 5 }));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(findById).not.toHaveBeenCalled();
    });

    it('un operador que pide uno inexistente recibe 404 (no 403)', async () => {
      espiar(undefined);
      expect(await atrapar(movimientoService.obtenerMovimiento(deps(), { identity: OPERADOR, id: 5 }))).toMatchObject({ status: 404 });
    });

    it('con la base real devuelve el movimiento sin clave_idempotencia', async () => {
      const { id_movimiento: id } = await crearMovimiento(db, { idBodega: b1, claveIdempotencia: 'centinela' });
      const movimiento = await movimientoService.obtenerMovimiento(deps(), { identity: IDENTIDAD, id });
      expect(movimiento).toMatchObject({ id_movimiento: id, id_bodega: b1 });
      expect(Object.keys(movimiento)).not.toContain('clave_idempotencia');
    });

    it('un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      jest.spyOn(movimientoRepository, 'findById').mockImplementation(() => { throw falla; });
      let resultado;
      expect(() => { resultado = movimientoService.obtenerMovimiento(deps(), { identity: IDENTIDAD, id: 5 }); }).not.toThrow();
      await expect(resultado).rejects.toBe(falla);
    });
  });

  describe('crearMovimientoService: listar y obtener', () => {
    it('leen las dependencias en cada llamada, como registrar: el servicio se puede construir sin ellas', async () => {
      const tardias = {};
      const servicio = movimientoService.crearMovimientoService(tardias);
      Object.assign(tardias, { db });
      await crearMovimiento(db, { idBodega: b1 });
      expect((await servicio.listar({ identity: IDENTIDAD, limit: 20, offset: 0 })).total).toBe(1);
      expect((await servicio.obtener({ identity: IDENTIDAD, id: 1 })).id_movimiento).toBe(1);
    });
  });
});

describe('movimientoService.evaluarUmbral (D13)', () => {
  const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  let notificaciones;
  let logger;
  const deps = () => ({ db, clients: { notificaciones }, logger });
  const evaluar = (tipo, extra = {}) => movimientoService.evaluarUmbral(deps(), { tipo, idProducto: 5, idBodega: b1, identity: IDENTIDAD, ...extra });

  beforeEach(async () => {
    notificaciones = fakeNotificaciones();
    logger = { info: jest.fn(), error: jest.fn() };
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 4 });
  });

  it.each(TIPOS_PERMITIDOS_POR_API)('tras un %s con el total bajo el mínimo avisa con los datos exactos', async (tipo) => {
    await expect(evaluar(tipo)).resolves.toBeUndefined();
    expect(notificaciones.notificarStockBajo).toHaveBeenCalledWith(
      { idProducto: 5, idBodega: b1, cantidadTotal: 4, cantidadMinima: 10 },
      { 'X-Request-Id': 'r1', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' },
    );
  });

  it.each(['TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL'])('tras un %s NO se evalúa: ni lee la base ni avisa (mercancía en tránsito o solo suma)', async (tipo) => {
    const consultas = [];
    const registrar = (consulta) => consultas.push(consulta.sql);
    db.on('query', registrar);
    try {
      await evaluar(tipo);
    } finally {
      db.removeListener('query', registrar);
    }
    expect(consultas).toEqual([]);
    expect(notificaciones.notificarStockBajo).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('cubre los nueve tipos: los tres excluidos y los seis de la API', () => {
    expect([...TIPOS_PERMITIDOS_POR_API, 'TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL'].sort()).toEqual([...TIPOS].sort());
  });

  it('un tipo desconocido no avisa', async () => {
    await evaluar('REGALO');
    expect(notificaciones.notificarStockBajo).not.toHaveBeenCalled();
  });

  it('compara con < estricto: total igual al mínimo no avisa', async () => {
    await db('umbrales_producto').update({ cantidad_minima: 4 });
    await evaluar('SALIDA');
    expect(notificaciones.notificarStockBajo).not.toHaveBeenCalled();
  });

  it('usa el total de TODAS las bodegas, no el de la bodega del movimiento', async () => {
    const b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 5 });
    await evaluar('SALIDA');
    expect(notificaciones.notificarStockBajo.mock.calls[0][0]).toMatchObject({ idBodega: b1, cantidadTotal: 9 });
    await crearSaldo(db, { idProducto: 5, idBodega: (await crearBodega(db, { codigo: 'B3' })).id_bodega, cantidad: 1 });
    notificaciones.notificarStockBajo.mockClear();
    await evaluar('SALIDA');
    expect(notificaciones.notificarStockBajo).not.toHaveBeenCalled(); // 4 + 5 + 1 = 10
  });

  it('no espera el aviso: resuelve aunque la promesa del aviso no termine nunca', async () => {
    notificaciones.notificarStockBajo.mockReturnValue(new Promise(() => {}));
    await expect(evaluar('SALIDA')).resolves.toBeUndefined();
    expect(notificaciones.notificarStockBajo).toHaveBeenCalledTimes(1);
  });

  it('nunca rechaza: un fallo de la lectura se registra con { nombre, mensaje, pila }', async () => {
    const roto = Object.assign(() => { throw new TypeError('db roto'); }, { raw: () => {} });
    await expect(movimientoService.evaluarUmbral({ db: roto, clients: { notificaciones }, logger }, { tipo: 'SALIDA', idProducto: 5, idBodega: b1, identity: IDENTIDAD })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      mensaje: expect.any(String), id_producto: 5, id_bodega: b1, error: { nombre: 'TypeError', mensaje: 'db roto', pila: expect.any(String) },
    }));
    expect(notificaciones.notificarStockBajo).not.toHaveBeenCalled();
  });

  it('nunca rechaza: ni con un logger que también lanza', async () => {
    const lanzador = { info() {}, error() { throw new Error('logger roto'); } };
    notificaciones.notificarStockBajo.mockImplementation(() => { throw new Error('aviso roto'); });
    await expect(movimientoService.evaluarUmbral({ db, clients: { notificaciones }, logger: lanzador }, { tipo: 'SALIDA', idProducto: 5, idBodega: b1, identity: IDENTIDAD })).resolves.toBeUndefined();
  });

  it('un aviso que rechaza se registra (sin unhandledRejection)', async () => {
    notificaciones.notificarStockBajo.mockRejectedValue('texto rechazado');
    await evaluar('SALIDA');
    await new Promise((resolver) => setImmediate(resolver));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ id_producto: 5, error: { nombre: 'string', mensaje: 'texto rechazado' } }));
  });

  it('lee después del commit con la conexión normal: ve el saldo confirmado', async () => {
    await db('saldos').update({ cantidad_disponible: 2 });
    await evaluar('SALIDA');
    expect(notificaciones.notificarStockBajo.mock.calls[0][0].cantidadTotal).toBe(2);
  });
});
