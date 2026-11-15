const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../src/errors');
const tipos = require('../src/domain/tipos');
const stockService = require('../src/services/stockService');
const { createTestDb, truncateAll } = require('./helpers/db');
const loteRepository = require('../src/repositories/loteRepository');
const saldoRepository = require('../src/repositories/saldoRepository');
const { crearBodega, crearLote, crearSaldo } = require('./helpers/fixtures');

// El motor de movimientos (stockService.aplicarMovimiento) y los tipos de movimiento (D3), contra PostgreSQL real y con
// transacciones reales: es la pieza que reutilizan las Tareas 8–13, así que aquí se prueban el bloqueo del saldo, el signo de
// cada tipo, el saldo negativo, el desbordamiento del INTEGER, la bodega y el orden del kardex (D24). La ruta HTTP
// (POST /movimientos) está en movimientos.test.js y el repositorio en movimientosCapas.test.js.

const MAXIMO = 2147483647;
const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
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

// Cada llamada lleva una clave distinta: la unicidad de la clave es de la base, no del motor.
let siguiente = 0;
const clave = () => `7:k${(siguiente += 1)}`;
const datos = (extra = {}) => ({ tipo: 'ENTRADA', idProducto: 5, idBodega: b1, cantidad: 1, claveIdempotencia: clave(), idUsuario: 7, ...extra });
// Aplica un movimiento en su propia transacción, como lo hace el servicio.
const aplicar = (extra) => db.transaction((trx) => stockService.aplicarMovimiento(trx, datos(extra)));
const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);

const saldoDe = async (idProducto = 5, idBodega = b1) => (await db('saldos').where({ id_producto: idProducto, id_bodega: idBodega }).first())?.cantidad_disponible;
const filasSaldo = () => db('saldos').select('*').orderBy('id_saldo');
const kardex = () => db('movimientos').select('*').orderBy([{ column: 'fecha' }, { column: 'id_movimiento' }]);

describe('tipos (D3, D4)', () => {
  it('TIPOS son los nueve de la restricción movimientos_tipo_valido, congelados', () => {
    expect(tipos.TIPOS).toEqual([
      'ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA',
      'DEVOLUCION_PROVEEDOR', 'TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL',
    ]);
    expect(Object.isFrozen(tipos.TIPOS)).toBe(true);
  });

  it('cada tipo de TIPOS es aceptado por la base (la lista coincide con la restricción de la migración)', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 100 });
    for (const tipo of tipos.TIPOS) await aplicar({ tipo, cantidad: 1 });
    expect((await kardex()).map((fila) => fila.tipo).sort()).toEqual([...tipos.TIPOS].sort());
  });

  it('TIPOS_PERMITIDOS_POR_API son los seis que acepta POST /movimientos (D4), congelados', () => {
    expect(tipos.TIPOS_PERMITIDOS_POR_API).toEqual(['ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA', 'DEVOLUCION_PROVEEDOR']);
    expect(Object.isFrozen(tipos.TIPOS_PERMITIDOS_POR_API)).toBe(true);
    for (const tipo of tipos.TIPOS_PERMITIDOS_POR_API) expect(tipos.TIPOS).toContain(tipo);
  });

  it.each([
    ['ENTRADA', 3, 3], ['DEVOLUCION_CLIENTE', 3, 3], ['ENTRADA_COMPRA', 3, 3], ['TRASLADO_ENTRADA', 3, 3], ['CARGA_INICIAL', 3, 3],
    ['SALIDA', 3, -3], ['DEVOLUCION_PROVEEDOR', 3, -3], ['TRASLADO_SALIDA', 3, -3],
    ['AJUSTE', 3, 3], ['AJUSTE', -3, -3],
  ])('delta(%s, %p) = %p', (tipo, cantidad, esperado) => {
    expect(tipos.delta(tipo, cantidad)).toBe(esperado);
  });

  it('cubre los nueve tipos: cada uno suma, resta o es AJUSTE (ninguno queda sin signo)', () => {
    for (const tipo of tipos.TIPOS) expect(Math.abs(tipos.delta(tipo, 2))).toBe(2);
  });

  it.each([
    ['un tipo inventado', 'REGALO', 1],
    ['un tipo en minúsculas', 'entrada', 1],
    ['cantidad 0 en un tipo sin signo', 'ENTRADA', 0],
    ['cantidad negativa en un tipo sin signo', 'SALIDA', -1],
    ['AJUSTE de 0', 'AJUSTE', 0],
    ['una cantidad decimal', 'ENTRADA', 1.5],
    ['una cantidad de texto', 'ENTRADA', '5'],
    ['una cantidad fuera del INTEGER', 'ENTRADA', MAXIMO + 1],
    ['un AJUSTE fuera del INTEGER', 'AJUSTE', -MAXIMO - 2],
  ])('delta con %s lanza TypeError (error de programación: la entrada ya llega validada)', (_caso, tipo, cantidad) => {
    expect(() => tipos.delta(tipo, cantidad)).toThrow(TypeError);
  });

  it('tipos.js no depende de Express ni de ningún otro módulo (es dominio puro)', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'tipos.js'), 'utf8');
    expect(fuente).not.toMatch(/require\(/);
  });
});

describe('stockService.aplicarMovimiento', () => {
  describe('saldo y movimiento', () => {
    it('ENTRADA 10 sobre un producto sin saldo crea el saldo en 10 y devuelve el Movimiento con exactamente sus campos', async () => {
      const movimiento = await aplicar({ cantidad: 10, documentoReferencia: 'FAC-1', observacion: 'Compra de contado' });
      expect(Object.keys(movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
      expect(movimiento).toEqual({
        id_movimiento: expect.any(Number),
        tipo: 'ENTRADA',
        id_producto: 5,
        id_bodega: b1,
        id_lote: null,
        id_traslado: null,
        id_conteo: null,
        cantidad: 10,
        saldo_resultante: 10,
        fecha: expect.any(Date),
        id_usuario: 7,
        documento_referencia: 'FAC-1',
        observacion: 'Compra de contado',
      });
      expect(await saldoDe()).toBe(10);
      const [fila] = await kardex();
      expect(fila.clave_idempotencia).toMatch(/^7:k\d+$/);
    });

    it('ENTRADA 10 y SALIDA 4 → saldo_resultante 10 y 6, y el saldo queda en 6', async () => {
      expect((await aplicar({ cantidad: 10 })).saldo_resultante).toBe(10);
      const salida = await aplicar({ tipo: 'SALIDA', cantidad: 4 });
      expect(salida).toMatchObject({ tipo: 'SALIDA', cantidad: 4, saldo_resultante: 6 });
      expect(await saldoDe()).toBe(6);
      expect((await kardex()).map((fila) => [fila.tipo, fila.cantidad, fila.saldo_resultante])).toEqual([['ENTRADA', 10, 10], ['SALIDA', 4, 6]]);
    });

    it.each([
      ['ENTRADA', 3, 13], ['DEVOLUCION_CLIENTE', 3, 13], ['ENTRADA_COMPRA', 3, 13], ['TRASLADO_ENTRADA', 3, 13], ['CARGA_INICIAL', 3, 13],
      ['SALIDA', 3, 7], ['DEVOLUCION_PROVEEDOR', 3, 7], ['TRASLADO_SALIDA', 3, 7], ['AJUSTE', 3, 13], ['AJUSTE', -3, 7],
    ])('%s de %p sobre un saldo de 10 → saldo y saldo_resultante %p; la cantidad se guarda como llegó', async (tipo, cantidad, esperado) => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
      const movimiento = await aplicar({ tipo, cantidad });
      expect(movimiento).toMatchObject({ tipo, cantidad, saldo_resultante: esperado });
      expect(await saldoDe()).toBe(esperado);
    });

    it('cantidad y saldo_resultante son NÚMEROS, no texto', async () => {
      const movimiento = await aplicar({ cantidad: 3 });
      expect(typeof movimiento.cantidad).toBe('number');
      expect(typeof movimiento.saldo_resultante).toBe('number');
    });

    it('solo toca el saldo de ESE producto en ESA bodega', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 50 });
      await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 60 });
      await aplicar({ cantidad: 4 });
      expect(await saldoDe(5, b2)).toBe(50);
      expect(await saldoDe(6, b1)).toBe(60);
      expect(await saldoDe(5, b1)).toBe(4);
    });

    it('guarda idTraslado e idConteo (los usarán las Tareas 9 y 11) y los opcionales nulos por defecto', async () => {
      const [{ id_traslado: idTraslado }] = await db('traslados').insert({
        id_producto: 5, id_bodega_origen: b2, id_bodega_destino: b1, cantidad: 2, estado: 'EN_TRANSITO', id_usuario_envia: 7,
      }).returning('id_traslado');
      const [{ id_conteo: idConteo }] = await db('conteos').insert({ id_bodega: b1, estado: 'EN_REVISION', fecha_programada: '2026-11-15' }).returning('id_conteo');
      expect(await aplicar({ tipo: 'TRASLADO_ENTRADA', cantidad: 2, idTraslado })).toMatchObject({ id_traslado: idTraslado, id_conteo: null, documento_referencia: null, observacion: null });
      expect(await aplicar({ tipo: 'AJUSTE', cantidad: -1, idConteo })).toMatchObject({ id_traslado: null, id_conteo: idConteo, saldo_resultante: 1 });
    });

    it('SALIDA que deja el saldo exactamente en 0 es válida', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
      expect(await aplicar({ tipo: 'SALIDA', cantidad: 6 })).toMatchObject({ saldo_resultante: 0 });
      expect(await saldoDe()).toBe(0);
    });
  });

  describe('rechazos (nada cambia)', () => {
    it('SALIDA 7 con saldo 6 → 409 STOCK_INSUFICIENTE con disponible y solicitado; ni el saldo ni el kardex cambian', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
      const error = await atrapar(aplicar({ tipo: 'SALIDA', cantidad: 7 }));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, codigo: 'STOCK_INSUFICIENTE' });
      expect(error.detalles).toEqual([{ campo: 'cantidad', mensaje: expect.stringMatching(/6.*7/), disponible: 6, solicitado: 7 }]);
      expect(await saldoDe()).toBe(6);
      expect(await kardex()).toEqual([]);
    });

    it('AJUSTE -11 con saldo 10 → 409 STOCK_INSUFICIENTE (solicitado 11); AJUSTE -10 sí se aplica', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
      const error = await atrapar(aplicar({ tipo: 'AJUSTE', cantidad: -11 }));
      expect(error).toMatchObject({ status: 409, codigo: 'STOCK_INSUFICIENTE' });
      expect(error.detalles[0]).toMatchObject({ disponible: 10, solicitado: 11 });
      expect(await aplicar({ tipo: 'AJUSTE', cantidad: -10 })).toMatchObject({ saldo_resultante: 0 });
    });

    it('SALIDA sobre un producto SIN fila de saldo → 409 y el rollback no deja ninguna fila de saldo ni de kardex', async () => {
      const error = await atrapar(aplicar({ tipo: 'SALIDA', cantidad: 1 }));
      expect(error).toMatchObject({ status: 409, codigo: 'STOCK_INSUFICIENTE' });
      expect(error.detalles[0]).toMatchObject({ disponible: 0, solicitado: 1 });
      expect(await filasSaldo()).toEqual([]);
      expect(await kardex()).toEqual([]);
    });

    it('bodega inexistente → 404 NO_EXISTE sin crear saldo ni movimiento', async () => {
      const error = await atrapar(aplicar({ idBodega: 9999 }));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      expect(await filasSaldo()).toEqual([]);
      expect(await kardex()).toEqual([]);
    });

    it('bodega inactiva → 409 BODEGA_INACTIVA (D12) aunque sea una ENTRADA; el saldo no cambia', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 4 });
      expect((await aplicar({ cantidad: 1 })).saldo_resultante).toBe(5); // control: activa
      await db('bodegas').where({ id_bodega: b1 }).update({ activa: false });
      const error = await atrapar(aplicar({ cantidad: 1 }));
      expect(error).toMatchObject({ status: 409, codigo: 'BODEGA_INACTIVA' });
      expect(await saldoDe()).toBe(5);
      expect(await kardex()).toHaveLength(1);
    });

    it('un saldo que superaría el INTEGER (1 + 2147483647) → 422 DATOS_NO_VALIDOS sobre "cantidad" (nunca el 22003 de PostgreSQL); el saldo queda intacto', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 1 });
      const error = await atrapar(aplicar({ cantidad: MAXIMO }));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 422, codigo: 'DATOS_NO_VALIDOS' });
      expect(error.detalles).toEqual([{ campo: 'cantidad', mensaje: expect.stringContaining(String(MAXIMO)) }]);
      expect(await saldoDe()).toBe(1);
      expect(await kardex()).toEqual([]);
    });

    it('el saldo puede llegar exactamente al máximo del INTEGER (0 + 2147483647)', async () => {
      expect(await aplicar({ cantidad: MAXIMO })).toMatchObject({ saldo_resultante: MAXIMO });
      expect(await saldoDe()).toBe(MAXIMO);
    });

    it('una clave ya usada hace fallar el INSERT (23505 movimientos_clave_idempotencia_key) y la transacción deshace TAMBIÉN el saldo', async () => {
      const repetida = '7:repetida';
      await aplicar({ cantidad: 10, claveIdempotencia: repetida });
      const error = await atrapar(aplicar({ cantidad: 5, claveIdempotencia: repetida }));
      expect(error).toMatchObject({ code: '23505', constraint: 'movimientos_clave_idempotencia_key' });
      expect(await saldoDe()).toBe(10);
      expect(await kardex()).toHaveLength(1);
    });
  });

  describe('errores de programación (TypeError, sin escribir nada)', () => {
    it('fuera de una transacción: sin ella el FOR UPDATE se soltaría al terminar cada sentencia', async () => {
      await expect(stockService.aplicarMovimiento(db, datos())).rejects.toBeInstanceOf(TypeError);
      await expect(stockService.aplicarMovimiento(null, datos())).rejects.toBeInstanceOf(TypeError);
      expect(await filasSaldo()).toEqual([]);
    });

    it.each([
      ['un tipo inventado', { tipo: 'REGALO' }],
      ['una cantidad 0', { cantidad: 0 }],
      ['una cantidad decimal', { cantidad: 1.5 }],
      ['sin claveIdempotencia', { claveIdempotencia: undefined }],
      ['una claveIdempotencia vacía', { claveIdempotencia: '' }],
      ['una claveIdempotencia de 256 caracteres (la columna es varchar(255))', { claveIdempotencia: 'k'.repeat(256) }],
      ['sin idUsuario', { idUsuario: undefined }],
      ['un idUsuario 0', { idUsuario: 0 }],
      ['un idProducto de texto', { idProducto: '5' }],
      ['un idBodega fuera del INTEGER', { idBodega: MAXIMO + 1 }],
      // Lotes (D27): las combinaciones imposibles las rechaza quien llama con 422; aquí son errores de programación.
      ['un idLote 0', { idLote: 0 }],
      ['un idLote de texto', { idLote: '3' }],
      ['idLote y lote a la vez', { idLote: 1, lote: { codigoLote: 'L1', fechaVencimiento: null } }],
      ['un lote en un movimiento que BAJA el saldo (SALIDA)', { tipo: 'SALIDA', lote: { codigoLote: 'L1', fechaVencimiento: null } }],
      ['un lote en un AJUSTE negativo', { tipo: 'AJUSTE', cantidad: -1, lote: { codigoLote: 'L1', fechaVencimiento: null } }],
      ['un lote que no es un objeto', { lote: 'L1' }],
      ['un lote con el código en snake_case (la forma del cuerpo HTTP, no la del motor)', { lote: { codigo_lote: 'L1' } }],
      ['un lote con el código vacío', { lote: { codigoLote: '', fechaVencimiento: null } }],
      ['un lote con el código sin recortar (sería otro lote distinto de «L1»)', { lote: { codigoLote: 'L1 ', fechaVencimiento: null } }],
      ['un lote con el código con NUL', { lote: { codigoLote: 'L\u00001', fechaVencimiento: null } }],
      ['un lote con un código de 51 caracteres (la columna es varchar(50))', { lote: { codigoLote: 'x'.repeat(51), fechaVencimiento: null } }],
      ['un lote con la fecha como Date (Ruling 15)', { lote: { codigoLote: 'L1', fechaVencimiento: new Date('2027-01-31') } }],
      ['un lote con la fecha en otro formato', { lote: { codigoLote: 'L1', fechaVencimiento: '2027-1-31' } }],
      // Ruling 44: la fecha debe EXISTIR (si no, PostgreSQL lanzaría 22008 y sería un 500 sin causa clara).
      ['un lote con el 30 de febrero', { lote: { codigoLote: 'L1', fechaVencimiento: '2027-02-30' } }],
      ['un lote con el mes 13', { lote: { codigoLote: 'L1', fechaVencimiento: '2027-13-01' } }],
      ['un lote con el año 0000', { lote: { codigoLote: 'L1', fechaVencimiento: '0000-01-01' } }],
      ['un lote con la fecha sin ceros a la izquierda', { lote: { codigoLote: 'L1', fechaVencimiento: '2027-2-3' } }],
    ])('%s → TypeError y nada escrito', async (_caso, extra) => {
      await expect(aplicar(extra)).rejects.toBeInstanceOf(TypeError);
      expect(await filasSaldo()).toEqual([]);
      expect(await kardex()).toEqual([]);
    });

    it.each([['2027-02-28'], ['2028-02-29'], [null]])('un lote con fechaVencimiento %p sí se acepta (control de las fechas imposibles)', async (fechaVencimiento) => {
      /* Una fecha real o null (la carga inicial la deja opcional). */
      expect(await aplicar({ lote: { codigoLote: 'L1', fechaVencimiento } })).toMatchObject({ saldo_resultante: 1 });
      expect((await db('lotes').first()).fecha_vencimiento).toBe(fechaVencimiento);
    });

    it('una claveIdempotencia de 255 caracteres sí cabe', async () => {
      expect(await aplicar({ claveIdempotencia: 'k'.repeat(255) })).toMatchObject({ saldo_resultante: 1 });
    });
  });

  describe('concurrencia (bloqueo del saldo con SELECT … FOR UPDATE)', () => {
    it('cinco SALIDA de 3 a la vez con saldo 10 → exactamente tres confirmadas y dos 409; saldo final 1 y tres filas en el kardex', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
      const resultados = await Promise.allSettled([1, 2, 3, 4, 5].map(() => aplicar({ tipo: 'SALIDA', cantidad: 3 })));
      const confirmados = resultados.filter((r) => r.status === 'fulfilled');
      const rechazados = resultados.filter((r) => r.status === 'rejected');
      expect(confirmados).toHaveLength(3);
      expect(rechazados.map((r) => [r.reason.status, r.reason.codigo])).toEqual([[409, 'STOCK_INSUFICIENTE'], [409, 'STOCK_INSUFICIENTE']]);
      expect(confirmados.map((r) => r.value.saldo_resultante).sort((a, b) => b - a)).toEqual([7, 4, 1]);
      expect(await saldoDe()).toBe(1);
      expect(await kardex()).toHaveLength(3);
    });

    it('diez ENTRADA a la vez sobre un producto SIN saldo crean UNA sola fila de saldo con la suma (INSERT … ON CONFLICT DO NOTHING)', async () => {
      const resultados = await Promise.all(Array.from({ length: 10 }, () => aplicar({ cantidad: 2 })));
      expect(resultados.map((m) => m.saldo_resultante).sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
      expect(await filasSaldo()).toHaveLength(1);
      expect(await saldoDe()).toBe(20);
    });

    it('D24: doce movimientos concurrentes (entradas, salidas y ajustes) ordenados por (fecha, id_movimiento) encadenan sus saldo_resultante desde el saldo inicial', async () => {
      const INICIAL = 20;
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: INICIAL });
      const pedidos = [
        { tipo: 'ENTRADA', cantidad: 5 }, { tipo: 'SALIDA', cantidad: 3 }, { tipo: 'AJUSTE', cantidad: -2 },
        { tipo: 'DEVOLUCION_CLIENTE', cantidad: 4 }, { tipo: 'SALIDA', cantidad: 1 }, { tipo: 'ENTRADA_COMPRA', cantidad: 7 },
        { tipo: 'DEVOLUCION_PROVEEDOR', cantidad: 2 }, { tipo: 'AJUSTE', cantidad: 3 }, { tipo: 'SALIDA', cantidad: 6 },
        { tipo: 'ENTRADA', cantidad: 1 }, { tipo: 'SALIDA', cantidad: 4 }, { tipo: 'TRASLADO_ENTRADA', cantidad: 2 },
      ];
      await Promise.all(pedidos.map((pedido) => aplicar(pedido)));
      const filas = await kardex();
      expect(filas).toHaveLength(12);
      let esperado = INICIAL;
      for (const fila of filas) {
        esperado += tipos.delta(fila.tipo, fila.cantidad);
        expect({ id: fila.id_movimiento, saldo_resultante: fila.saldo_resultante }).toEqual({ id: fila.id_movimiento, saldo_resultante: esperado });
      }
      const suma = pedidos.reduce((total, { tipo, cantidad }) => total + tipos.delta(tipo, cantidad), INICIAL);
      expect(esperado).toBe(suma);
      expect(await saldoDe()).toBe(suma);
      // El id de serie también sigue el orden de aplicación: ordenar solo por id da el mismo kardex.
      expect(filas.map((fila) => fila.id_movimiento)).toEqual([...filas.map((fila) => fila.id_movimiento)].sort((a, b) => a - b));
    });

    it('D24 (determinista): una transacción que EMPEZÓ antes pero tomó el bloqueo después lleva la fecha posterior, no la de su inicio', async () => {
      const temprana = await db.transaction();
      try {
        // Fija el inicio de la transacción (now()) antes de que la otra confirme. Como texto: un Date de JS pierde los
        // microsegundos, así que las comparaciones se hacen en SQL.
        const { rows: [{ inicio }] } = await temprana.raw('SELECT now()::text AS inicio');
        const tardia = await aplicar({ cantidad: 5 }); // empieza después, bloquea y confirma primero
        const ultima = await stockService.aplicarMovimiento(temprana, datos({ cantidad: 2 }));
        await temprana.commit();

        expect(ultima.saldo_resultante).toBe(7);
        expect((await kardex()).map((fila) => fila.saldo_resultante)).toEqual([5, 7]);
        const { rows: [orden] } = await db.raw(`
          SELECT u.fecha > ?::timestamptz AS movimiento_tras_inicio,
                 u.fecha > t.fecha AS movimiento_tras_el_otro,
                 s.fecha_actualizacion > ?::timestamptz AS saldo_tras_inicio,
                 s.fecha_actualizacion > t.fecha AS saldo_tras_el_otro
          FROM movimientos u, movimientos t, saldos s
          WHERE u.id_movimiento = ? AND t.id_movimiento = ? AND s.id_producto = 5 AND s.id_bodega = ?`,
        [inicio, inicio, ultima.id_movimiento, tardia.id_movimiento, b1]);
        // El movimiento Y el saldo se fechan después de tomar el bloqueo, no con el inicio de su transacción.
        expect(orden).toEqual({ movimiento_tras_inicio: true, movimiento_tras_el_otro: true, saldo_tras_inicio: true, saldo_tras_el_otro: true });
      } finally {
        if (!temprana.isCompleted()) await temprana.rollback();
      }
    });
  });
});

describe('stockService.aplicarMovimiento: lotes (D27)', () => {
  // Las reglas por el SIGNO del delta, con los tipos que POST /movimientos no admite (los heredan las Tareas 9, 11 y 12) y las
  // garantías internas del motor: orden de bloqueo, rollback total y que nunca bloquea un lote de otro par. La matriz por tipo
  // de la API y la validación del cuerpo están en movimientosLotes.test.js.
  afterEach(() => jest.restoreAllMocks());

  const sembrarLote = (codigo, fecha, cantidad, extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad, ...extra });
  const lotesDe = async () => Object.fromEntries((await db('lotes').select('codigo_lote', 'cantidad_disponible').orderBy('id_lote')).map((l) => [l.codigo_lote, l.cantidad_disponible]));

  it('contraste (D28(a)): en el MISMO estado, TRASLADO_SALIDA sin idLote no hace FEFO (409 con el stock sin lote) y SALIDA sí', async () => {
    /* Saldo 10 = A 3 (vence antes) + B 3 + 4 sin lote. Un traslado de 5 no cabe en el stock sin lote; una salida de 5 agota A y toma 2 de B. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const b = await sembrarLote('B', '2027-06-30', 3);
    const a = await sembrarLote('A', '2027-01-31', 3);
    const error = await atrapar(aplicar({ tipo: 'TRASLADO_SALIDA', cantidad: 5 }));
    expect(error).toMatchObject({ status: 409, codigo: 'STOCK_INSUFICIENTE' });
    expect(error.detalles).toEqual([{ campo: 'cantidad', mensaje: expect.any(String), disponible: 4, solicitado: 5 }]);
    expect(await lotesDe()).toEqual({ B: 3, A: 3 });
    const movimiento = await aplicar({ tipo: 'SALIDA', cantidad: 5 });
    expect(movimiento).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 5 });
    expect(await lotesDe()).toEqual({ B: 1, A: 0 });
    expect(b.id_lote).toBeLessThan(a.id_lote); // control: el orden FEFO es por fecha, no por id
  });

  it('TRASLADO_SALIDA con idLote resta de ESE lote y TRASLADO_ENTRADA con lote lo crea en el destino con su fecha (Tarea 9)', async () => {
    /* Así un traslado mueve un lote concreto: sale por id en el origen y entra por código y fecha en el destino. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
    const a = await sembrarLote('A', '2027-01-31', 6);
    expect(await aplicar({ tipo: 'TRASLADO_SALIDA', cantidad: 4, idLote: a.id_lote })).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 2 });
    const entrada = await aplicar({ tipo: 'TRASLADO_ENTRADA', idBodega: b2, cantidad: 4, lote: { codigoLote: 'A', fechaVencimiento: '2027-01-31' } });
    const destino = await db('lotes').where({ id_bodega: b2 }).first();
    expect(destino).toMatchObject({ codigo_lote: 'A', fecha_vencimiento: '2027-01-31', cantidad_disponible: 4, id_producto: 5 });
    expect(entrada).toMatchObject({ id_lote: destino.id_lote, saldo_resultante: 4, id_bodega: b2 });
    expect(await saldoDe(5, b1)).toBe(2);
  });

  it('CARGA_INICIAL con lote crea el lote y una segunda fila con el mismo código y fecha suma (Tarea 12); con fecha omitida también suma', async () => {
    /* La carga inicial es una entrada como cualquier otra. */
    await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 3, lote: { codigoLote: 'L1', fechaVencimiento: '2027-01-31' } });
    await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 2, lote: { codigoLote: 'L1', fechaVencimiento: '2027-01-31' } });
    const ultimo = await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 1, lote: { codigoLote: 'L1' } });
    expect(ultimo.saldo_resultante).toBe(6);
    expect(await db('lotes').select('codigo_lote', 'fecha_vencimiento', 'cantidad_disponible')).toEqual([{ codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad_disponible: 6 }]);
  });

  it('AJUSTE negativo con idConteo y sin idLote sale por FEFO (Tarea 11)', async () => {
    /* Un faltante de conteo baja los lotes que vencen primero, no solo el saldo. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 4 });
    const a = await sembrarLote('A', '2027-01-31', 4);
    const [{ id_conteo: idConteo }] = await db('conteos').insert({ id_bodega: b1, estado: 'EN_REVISION', fecha_programada: '2026-11-15' }).returning('id_conteo');
    expect(await aplicar({ tipo: 'AJUSTE', cantidad: -3, idConteo })).toMatchObject({ id_lote: a.id_lote, id_conteo: idConteo, saldo_resultante: 1 });
    expect(await lotesDe()).toEqual({ A: 1 });
  });

  it('409 CONFLICTO (mismo código, otra fecha) informa la fecha guardada en lote.fecha_vencimiento y no cambia nada', async () => {
    /* D27(d): una fecha ignorada en silencio podría sacar mercancía vencida antes de tiempo. */
    await aplicar({ cantidad: 2, lote: { codigoLote: 'L1', fechaVencimiento: '2027-01-31' } });
    const error = await atrapar(aplicar({ cantidad: 5, lote: { codigoLote: 'L1', fechaVencimiento: '2027-02-01' } }));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, codigo: 'CONFLICTO' });
    expect(error.detalles).toEqual([{ campo: 'lote.fecha_vencimiento', mensaje: expect.stringContaining('2027-01-31') }]);
    expect(await saldoDe()).toBe(2);
    expect(await lotesDe()).toEqual({ L1: 2 });
    expect(await kardex()).toHaveLength(1);
  });

  // Movidas desde movimientosLotes.test.js (ronda de corrección 1, D28(b)): POST /movimientos ya exige la fecha con `lote`, así
  // que estos caminos solo son alcanzables desde la carga inicial (Tarea 12), que llama al motor con fechaVencimiento nula.
  it('lote sin fecha (fechaVencimiento null u omitida) sobre un lote existente con fecha → suma sin tocar la fecha guardada', async () => {
    /* Sin fecha no hay nada que contradecir. */
    await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 4, lote: { codigoLote: 'L1', fechaVencimiento: '2027-01-31' } });
    await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 1, lote: { codigoLote: 'L1' } });
    expect(await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 1, lote: { codigoLote: 'L1', fechaVencimiento: null } })).toMatchObject({ saldo_resultante: 6 });
    expect(await db('lotes').select('codigo_lote', 'fecha_vencimiento', 'cantidad_disponible')).toEqual([{ codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad_disponible: 6 }]);
  });

  it('lote guardado SIN fecha y llega una → 409 CONFLICTO sin cambios (control: sin fecha suma)', async () => {
    /* D27(d): una fecha nueva sobre un lote sin fecha también contradice lo guardado. */
    await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 1, lote: { codigoLote: 'SF', fechaVencimiento: null } });
    expect(await aplicar({ tipo: 'CARGA_INICIAL', cantidad: 1, lote: { codigoLote: 'SF' } })).toMatchObject({ saldo_resultante: 2 });
    const error = await atrapar(aplicar({ cantidad: 1, lote: { codigoLote: 'SF', fechaVencimiento: '2027-01-31' } }));
    expect(error).toMatchObject({ status: 409, codigo: 'CONFLICTO' });
    expect(error.detalles).toEqual([{ campo: 'lote.fecha_vencimiento', mensaje: expect.stringContaining('sin fecha') }]);
    expect(await saldoDe()).toBe(2);
    expect(await lotesDe()).toEqual({ SF: 2 });
    expect(await kardex()).toHaveLength(2);
  });

  it('orden de bloqueo: el saldo SIEMPRE antes que cualquier lote (por id, por FEFO o por código)', async () => {
    /* D27(c): el saldo es el candado maestro; tomar un lote antes abriría un interbloqueo con otra operación del mismo par. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const a = await sembrarLote('A', '2027-01-31', 5);
    const orden = [];
    const espiar = (modulo, nombre) => {
      const real = modulo[nombre];
      jest.spyOn(modulo, nombre).mockImplementation(async (...args) => { orden.push(nombre); return real(...args); });
    };
    espiar(saldoRepository, 'bloquear');
    for (const nombre of ['bloquearPorId', 'listarParaFefo', 'upsertEntrada']) espiar(loteRepository, nombre);
    await aplicar({ tipo: 'SALIDA', cantidad: 1 });
    await aplicar({ tipo: 'SALIDA', cantidad: 1, idLote: a.id_lote });
    await aplicar({ cantidad: 1, idLote: a.id_lote });
    await aplicar({ cantidad: 1, lote: { codigoLote: 'N', fechaVencimiento: null } });
    expect(orden).toEqual(['bloquear', 'listarParaFefo', 'bloquear', 'bloquearPorId', 'bloquear', 'bloquearPorId', 'bloquear', 'upsertEntrada']);
  });

  it('un idLote de OTRO par (otra bodega) → 404 sin llegar a bloquear ese lote (no se toma un lote cuyo saldo no se tiene)', async () => {
    /* Si lo bloqueara, un traslado que tuviera ese par y esperara el nuestro cerraría un ciclo (40P01). */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 5 });
    const ajeno = await sembrarLote('X', null, 3, { idBodega: b2 });
    const trx = await db.transaction();
    try {
      const error = await atrapar(stockService.aplicarMovimiento(trx, datos({ tipo: 'SALIDA', cantidad: 1, idLote: ajeno.id_lote })));
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      // Con la transacción todavía abierta, otra puede tomar el lote ajeno al instante.
      const libre = await db.transaction(async (otra) => {
        await otra.raw("SET LOCAL lock_timeout = '150ms'");
        return otra('lotes').where({ id_lote: ajeno.id_lote }).forUpdate().first();
      });
      expect(libre).toMatchObject({ cantidad_disponible: 3 });
    } finally {
      await trx.rollback();
    }
  });

  it('el 404 del lote ajeno va antes que el 409 del saldo: la referencia inválida se informa aunque tampoco haya stock', async () => {
    /* Una referencia que no existe es el primer error que el cliente debe corregir. */
    const ajeno = await sembrarLote('X', null, 3, { idProducto: 6 });
    expect(await atrapar(aplicar({ tipo: 'SALIDA', cantidad: 99, idLote: ajeno.id_lote }))).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
  });

  it('si un lote falla a mitad del FEFO (invariante roto), la transacción se deshace ENTERA: ni el saldo ni ningún lote cambian', async () => {
    /* La segunda resta «no se aplica»: el motor no puede seguir con el plan a medias y lanza un error interno. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await sembrarLote('A', '2027-01-31', 3);
    await sembrarLote('B', '2027-02-28', 3);
    const real = loteRepository.ajustar;
    jest.spyOn(loteRepository, 'ajustar').mockImplementationOnce(real).mockImplementationOnce(async () => undefined);
    const error = await atrapar(aplicar({ tipo: 'SALIDA', cantidad: 5 }));
    expect(error).not.toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(await saldoDe()).toBe(10);
    expect(await lotesDe()).toEqual({ A: 3, B: 3 });
    expect(await kardex()).toEqual([]);
  });
});

describe('stockService.aplicarMovimiento: TRASLADO_SALIDA sin FEFO (D28(a))', () => {
  // Un traslado mueve 0 o 1 lote (traslados.id_lote): sin idLote saca SOLO stock sin lote (saldo − suma de los lotes del par).
  const sembrarLote = (codigo, fecha, cantidad, extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad, ...extra });
  const lotesDe = async () => Object.fromEntries((await db('lotes').select('codigo_lote', 'cantidad_disponible').orderBy('id_lote')).map((l) => [l.codigo_lote, l.cantidad_disponible]));
  const traslado = (cantidad, extra) => aplicar({ tipo: 'TRASLADO_SALIDA', cantidad, ...extra });
  const insuficiente = (error, disponible, solicitado) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, codigo: 'STOCK_INSUFICIENTE', message: expect.stringMatching(/sin lote.*id_lote/) });
    expect(error.detalles).toEqual([{ campo: 'cantidad', mensaje: `Disponible sin lote: ${disponible}; solicitado: ${solicitado}`, disponible, solicitado }]);
  };

  it('con stock sin lote suficiente baja el saldo, NO toca ningún lote y el movimiento lleva id_lote null', async () => {
    /* Saldo 10 = A 4 + 6 sin lote; un traslado de 6 los agota sin tocar A. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await sembrarLote('A', '2027-01-31', 4);
    expect(await traslado(6)).toMatchObject({ id_lote: null, saldo_resultante: 4 });
    expect(await lotesDe()).toEqual({ A: 4 });
  });

  it('con lotes que cubren TODO el saldo (sin stock sin lote) → 409 con disponible 0; nada cambia', async () => {
    /* Control: un traslado con idLote del mismo estado sí sale. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const a = await sembrarLote('A', '2027-01-31', 6);
    await sembrarLote('B', null, 4);
    expect(await traslado(1, { idLote: a.id_lote })).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 9 });
    insuficiente(await atrapar(traslado(1)), 0, 1);
    expect(await saldoDe()).toBe(9);
    expect(await lotesDe()).toEqual({ A: 5, B: 4 });
    expect(await kardex()).toHaveLength(1);
  });

  it('lotes 5 y 5 con saldo 12 (2 sin lote): 3 → 409 con disponible 2 y sin cambios; 2 sí sale', async () => {
    /* El límite exacto del stock sin lote. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 12 });
    await sembrarLote('A', '2027-01-31', 5);
    await sembrarLote('B', '2027-02-28', 5);
    insuficiente(await atrapar(traslado(3)), 2, 3);
    expect(await saldoDe()).toBe(12);
    expect(await kardex()).toEqual([]);
    expect(await traslado(2)).toMatchObject({ id_lote: null, saldo_resultante: 10 });
    expect(await lotesDe()).toEqual({ A: 5, B: 5 });
  });

  it('con idLote resta de ESE lote aunque haya stock sin lote', async () => {
    /* Saldo 10 = A 4 + 6 sin lote: el traslado de 3 del lote A no toca el stock sin lote. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const a = await sembrarLote('A', '2027-01-31', 4);
    expect(await traslado(3, { idLote: a.id_lote })).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 7 });
    expect(await lotesDe()).toEqual({ A: 1 });
  });

  it('el saldo insuficiente se informa primero, con los datos del SALDO', async () => {
    /* Saldo 3 sin lotes: un traslado de 4 no cabe ni en el saldo. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    const error = await atrapar(traslado(4));
    expect(error.detalles).toEqual([expect.objectContaining({ disponible: 3, solicitado: 4 })]);
    expect(error.message).not.toMatch(/sin lote/);
  });

  it('la suma de los lotes se lee BAJO el candado del saldo: una entrada a un lote confirmada mientras el traslado espera cuenta', async () => {
    /* Saldo 10 = A 10. T1 (sin confirmar) entra 5 al lote A; el traslado de 5 sin lote espera el saldo y, al obtenerlo, ve saldo 15 Y lotes 15 → 409 disponible 0. Si leyera la suma antes del candado vería lotes 10 y sacaría 5 «sin lote» que son del lote. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await sembrarLote('A', '2027-01-31', 10);
    const t1 = await db.transaction();
    let pendiente;
    try {
      await stockService.aplicarMovimiento(t1, datos({ cantidad: 5, lote: { codigoLote: 'A', fechaVencimiento: '2027-01-31' } }));
      pendiente = atrapar(traslado(5));
      await new Promise((resolver) => setTimeout(resolver, 150)); // el traslado ya leyó lo que lea antes del candado y espera
      await t1.commit();
    } finally {
      if (!t1.isCompleted()) await t1.rollback();
    }
    insuficiente(await pendiente, 0, 5);
    expect(await saldoDe()).toBe(15);
    expect(await lotesDe()).toEqual({ A: 15 });
  });

  it.each(['repeatable read', 'serializable'])('en una transacción %s → TypeError sin escribir nada (la suma sin FOR UPDATE exige READ COMMITTED)', async (isolationLevel) => {
    /* Control: la misma operación en READ COMMITTED (el valor por defecto) sí sale. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    expect(await db.transaction((trx) => stockService.aplicarMovimiento(trx, datos({ tipo: 'TRASLADO_SALIDA', cantidad: 1 })), { isolationLevel: 'read committed' })).toMatchObject({ saldo_resultante: 9 });
    const error = await atrapar(db.transaction((trx) => stockService.aplicarMovimiento(trx, datos({ tipo: 'TRASLADO_SALIDA', cantidad: 1 })), { isolationLevel }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toMatch(/READ COMMITTED/);
    expect(await saldoDe()).toBe(9);
    expect(await kardex()).toHaveLength(1);
  });

  it('concurrencia: 8 traslados sin lote de 3 a la vez con 10 sin lote (saldo 20, lote 10) → exactamente tres confirmados y cinco 409; el lote intacto', async () => {
    /* El candado del saldo serializa los traslados: cada uno ve el stock sin lote que dejó el anterior. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 20 });
    await sembrarLote('A', '2027-01-31', 10);
    const resultados = await Promise.allSettled(Array.from({ length: 8 }, () => traslado(3)));
    const confirmados = resultados.filter((r) => r.status === 'fulfilled');
    const rechazados = resultados.filter((r) => r.status === 'rejected');
    expect(confirmados).toHaveLength(3);
    expect(rechazados.map((r) => [r.reason.status, r.reason.codigo])).toEqual(Array(5).fill([409, 'STOCK_INSUFICIENTE']));
    expect(confirmados.every((r) => r.value.id_lote === null)).toBe(true);
    expect(await saldoDe()).toBe(11);
    expect(await lotesDe()).toEqual({ A: 10 });
  });
});

