const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../src/errors');
const tipos = require('../src/domain/tipos');
const stockService = require('../src/services/stockService');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo } = require('./helpers/fixtures');

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
      // TODO(Tarea 8): los lotes llegan con la Tarea 8; hasta entonces el motor no los acepta en silencio.
      ['un idLote', { idLote: 1 }],
      ['un lote', { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-01' } }],
    ])('%s → TypeError y nada escrito', async (_caso, extra) => {
      await expect(aplicar(extra)).rejects.toBeInstanceOf(TypeError);
      expect(await filasSaldo()).toEqual([]);
      expect(await kardex()).toEqual([]);
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
