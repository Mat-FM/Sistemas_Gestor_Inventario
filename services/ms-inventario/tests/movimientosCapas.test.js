const { AppError } = require('../src/errors');
const movimientoRepository = require('../src/repositories/movimientoRepository');
const movimientoService = require('../src/services/movimientoService');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, fakeCatalogo } = require('./helpers/fixtures');

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

  describe('esClaveDuplicada', () => {
    it('reconoce el 23505 real de la clave de idempotencia', async () => {
      await movimientoRepository.insert(db, fila());
      let error;
      try {
        await movimientoRepository.insert(db, fila());
      } catch (capturado) {
        error = capturado;
      }
      expect(movimientoRepository.esClaveDuplicada(error)).toBe(true);
    });

    it.each([
      ['un 23505 de otra restricción', { code: '23505', constraint: 'saldos_id_producto_id_bodega_key' }],
      ['otro código con el mismo nombre de restricción', { code: '23514', constraint: 'movimientos_clave_idempotencia_key' }],
      ['un error sin código', new Error('movimientos_clave_idempotencia_key')],
      ['null', null],
      ['undefined', undefined],
    ])('no confunde %s con una clave repetida (se decide por el NOMBRE de la restricción, no por el mensaje)', (_caso, error) => {
      expect(movimientoRepository.esClaveDuplicada(error)).toBe(false);
    });
  });
});

// Cada función que exporta el repositorio con sus argumentos: todas son asíncronas salvo el predicado.
promesasReales(movimientoRepository, {
  insert: [{ tipo: 'ENTRADA', idProducto: 5, idBodega: 1, cantidad: 3, saldoResultante: 3, idUsuario: 7, claveIdempotencia: '7:promesa' }],
  findByClave: ['7:k1'],
}, { titulo: 'movimientoRepository', db: () => db, sincronas: { esClaveDuplicada: [null] } });

describe('movimientoService', () => {
  const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);

  describe('claveAlmacenada (D25)', () => {
    it('es `<id_usuario>:<clave>`, sin transformar la clave', () => {
      expect(movimientoService.claveAlmacenada(7, 'k1')).toBe('7:k1');
      expect(movimientoService.claveAlmacenada(12, ' A b ')).toBe('12: A b ');
    });

    it('es inyectiva: el primer ":" separa siempre el usuario (solo dígitos) de su clave', () => {
      const pares = [[1, '2:x'], [12, 'x'], [1, '2x'], [12, ':x'], [121, 'x']];
      const claves = pares.map(([usuario, clave]) => movimientoService.claveAlmacenada(usuario, clave));
      expect(new Set(claves).size).toBe(pares.length);
      for (const [indice, [usuario, clave]] of pares.entries()) {
        const almacenada = claves[indice];
        const corte = almacenada.indexOf(':');
        expect([Number(almacenada.slice(0, corte)), almacenada.slice(corte + 1)]).toEqual([usuario, clave]);
      }
    });

    it('con la clave más larga (200) y el id más alto cabe en varchar(255) y deja sitio a un sufijo `#<n>` de D5', () => {
      const almacenada = movimientoService.claveAlmacenada(2147483647, 'k'.repeat(movimientoService.LARGO_MAXIMO_CLAVE));
      expect(`${almacenada}#2147483647`.length).toBeLessThanOrEqual(255);
    });

    it.each([
      [null, 'k'], [0, 'k'], [1.5, 'k'], ['7', 'k'], [7, ''], [7, null], [7, 5],
    ])('claveAlmacenada(%p, %p) → TypeError (error de programación)', (usuario, clave) => {
      expect(() => movimientoService.claveAlmacenada(usuario, clave)).toThrow(TypeError);
    });
  });

  describe('leerClaveIdempotencia', () => {
    it('devuelve la clave sin espacios en los extremos, hasta 200 caracteres', () => {
      expect(movimientoService.leerClaveIdempotencia('  k1 ')).toBe('k1');
      expect(movimientoService.leerClaveIdempotencia('k'.repeat(200))).toBe('k'.repeat(200));
    });

    it.each([[undefined], [''], ['   '], ['k'.repeat(201)], [['a', 'b']], [5]])('%p → 400 PETICION_MAL_FORMADA', (valor) => {
      let error;
      try {
        movimientoService.leerClaveIdempotencia(valor);
      } catch (capturado) {
        error = capturado;
      }
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 400, codigo: 'PETICION_MAL_FORMADA' });
    });
  });

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
});
