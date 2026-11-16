const { crearCargaInicialController } = require('../src/controllers/cargaInicialController');
const { RUTA_CARGA_INICIAL, rutasInternas } = require('../src/routes/internas');
const { MAX_FILAS_CARGA_INICIAL, cargar, crearCargaInicialService } = require('../src/services/cargaInicialService');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega } = require('./helpers/fixtures');

// Las capas de la carga inicial por separado (RNF13): el servicio llamado SIN HTTP (con `db: null` donde no debe tocar la base),
// el controlador con una petición y una respuesta falsas y la declaración de la ruta. El comportamiento de punta a punta, contra
// PostgreSQL, está en cargaInicial.test.js.

const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
const FILA = { id_producto: 5, id_bodega: 1, cantidad: 10 };
const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);

describe('cargaInicialService', () => {
  describe('orden de las comprobaciones (cada una decide antes que la siguiente y NINGUNA toca la base: db es null)', () => {
    it('sin X-User-Id → 401 antes que la clave y las filas', async () => {
      const sinUsuario = { ...IDENTIDAD, idUsuario: null };
      const error = await atrapar(cargar({ db: null }, { filas: [], claveIdempotencia: undefined, identity: sinUsuario }));
      expect(error).toMatchObject({ name: 'AppError', status: 401, codigo: 'NO_AUTENTICADO' });
    });

    it('una clave inválida → 400 antes que las filas (falta, vacía, solo espacios, más de 200 caracteres o con #)', async () => {
      for (const clave of [undefined, '', '   ', 'k'.repeat(201), 'a#1']) {
        const error = await atrapar(cargar({ db: null }, { filas: [], claveIdempotencia: clave, identity: IDENTIDAD }));
        expect(error).toMatchObject({ status: 400, codigo: 'PETICION_MAL_FORMADA' });
      }
    });

    it('filas vacía, ausente o que no es una lista → 422 con un detalle sobre "filas"', async () => {
      for (const filas of [undefined, null, [], {}, 'x', 5, { length: 3 }]) {
        const error = await atrapar(cargar({ db: null }, { filas, claveIdempotencia: 'k', identity: IDENTIDAD }));
        expect(error).toMatchObject({ status: 422, codigo: 'DATOS_NO_VALIDOS', detalles: [{ campo: 'filas', mensaje: expect.any(String) }] });
      }
    });

    it('más de MAX_FILAS_CARGA_INICIAL → 422 mirando solo la longitud: una lista dispersa de 1 001 posiciones (sin elementos) no se recorre', async () => {
      expect(MAX_FILAS_CARGA_INICIAL).toBe(1000);
      const error = await atrapar(cargar({ db: null }, { filas: new Array(MAX_FILAS_CARGA_INICIAL + 1), claveIdempotencia: 'k', identity: IDENTIDAD }));
      expect(error).toMatchObject({ status: 422, detalles: [{ campo: 'filas', mensaje: expect.stringContaining(String(MAX_FILAS_CARGA_INICIAL)) }] });
    });
  });

  describe('con la base (sin HTTP)', () => {
    let db;
    beforeAll(() => {
      db = createTestDb();
    });
    beforeEach(async () => {
      await truncateAll(db);
      await crearBodega(db, { codigo: 'B1' });
    });
    afterAll(() => db.destroy());

    it('devuelve exactamente { creados, rechazados } con `fila` base 1 y rechazados ordenados; no modifica las filas que recibe', async () => {
      const filas = [FILA, null, { ...FILA, id_producto: 6, cantidad: 0 }, { ...FILA, id_producto: 7 }];
      const copia = structuredClone(filas);
      const resultado = await cargar({ db }, { filas, claveIdempotencia: 'k-capas', identity: IDENTIDAD });
      expect(Object.keys(resultado).sort()).toEqual(['creados', 'rechazados']);
      expect(resultado).toEqual({ creados: 2, rechazados: [{ fila: 2, motivo: expect.any(String) }, { fila: 3, motivo: expect.any(String) }] });
      expect(filas).toEqual(copia);
      expect((await db('movimientos').orderBy('id_movimiento').pluck('clave_idempotencia'))).toEqual(['7:ini:k-capas#1', '7:ini:k-capas#4']);
    });

    it('lee las dependencias en CADA llamada: crearCargaInicialService se construye sin ellas y usa las que se le dan', async () => {
      expect(() => crearCargaInicialService()).not.toThrow();
      const servicio = crearCargaInicialService({ db });
      expect(await servicio.cargar({ filas: [FILA], claveIdempotencia: 'k-deps', identity: IDENTIDAD })).toEqual({ creados: 1, rechazados: [] });
      expect(Object.keys(servicio)).toEqual(['cargar']);
    });

    it('un motivo de rechazo es texto legible: nunca el mensaje de PostgreSQL, el objeto del error ni una traza', async () => {
      const resultado = await cargar({ db }, { filas: [{ ...FILA, id_bodega: 404 }, { ...FILA, cantidad: 2147483648 }, 'x'], claveIdempotencia: 'k-motivos', identity: IDENTIDAD });
      expect(resultado.rechazados).toHaveLength(3);
      for (const { motivo } of resultado.rechazados) {
        expect(typeof motivo).toBe('string');
        expect(motivo).not.toMatch(/\[object|violates|constraint|Error:|\n/);
        expect(motivo.length).toBeLessThan(200);
      }
    });
  });
});

describe('cargaInicialController', () => {
  function respuestaFalsa() {
    const res = { json: jest.fn(() => res), status: jest.fn(() => res) };
    return res;
  }
  const peticion = (extra = {}) => ({ body: { filas: [FILA] }, headers: { 'idempotency-key': 'k1' }, identity: IDENTIDAD, ...extra });

  it('pasa al servicio las filas del cuerpo, la cabecera Idempotency-Key y la identidad, y responde 200 con lo que devuelve (sin fijar otro estado)', async () => {
    const resultado = { creados: 1, rechazados: [] };
    const servicio = { cargar: jest.fn().mockResolvedValue(resultado) };
    const res = respuestaFalsa();
    await crearCargaInicialController({ cargaInicialService: servicio }).cargar(peticion(), res);
    expect(servicio.cargar).toHaveBeenCalledWith({ filas: [FILA], claveIdempotencia: 'k1', identity: IDENTIDAD });
    expect(res.json).toHaveBeenCalledWith(resultado);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['sin cuerpo', undefined],
    ['con un arreglo como cuerpo', [FILA]],
    ['con null', null],
    ['con un texto', 'filas'],
    ['con un objeto sin filas', {}],
  ])('%s: pasa filas undefined y deja que el servicio responda su 422 (no valida el cuerpo antes de la clave)', async (_descripcion, body) => {
    const servicio = { cargar: jest.fn().mockResolvedValue({ creados: 0, rechazados: [] }) };
    await crearCargaInicialController({ cargaInicialService: servicio }).cargar(peticion({ body, headers: {} }), respuestaFalsa());
    expect(servicio.cargar).toHaveBeenCalledWith({ filas: undefined, claveIdempotencia: undefined, identity: IDENTIDAD });
  });

  it('un error del servicio se propaga (Express 5 lo lleva al manejador de errores)', async () => {
    const error = new Error('x');
    const servicio = { cargar: jest.fn().mockRejectedValue(error) };
    await expect(crearCargaInicialController({ cargaInicialService: servicio }).cargar(peticion(), respuestaFalsa())).rejects.toBe(error);
  });
});

describe('rutasInternas', () => {
  it('declara solo POST /internas/saldos/carga-inicial, sin necesitar dependencias, y no abre conexiones al construirse', () => {
    expect(RUTA_CARGA_INICIAL).toBe('/internas/saldos/carga-inicial');
    for (const rutas of [rutasInternas(), rutasInternas({}), rutasInternas({ db: null, logger: null })]) {
      expect(rutas).toEqual([{ metodo: 'post', ruta: RUTA_CARGA_INICIAL, handler: expect.any(Function) }]);
    }
  });
});
