const { AppError } = require('../src/errors');
const saldoRepository = require('../src/repositories/saldoRepository');
const { crearSaldoService } = require('../src/services/saldoService');
const { promesasReales } = require('./helpers/capas');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, crearUmbral } = require('./helpers/fixtures');

// Las capas de saldos por separado (RNF13): el repositorio contra PostgreSQL real y el servicio con un repositorio falso.
// El comportamiento de punta a punta está en saldos.test.js.

let db;
let b1;
let b2;
let b3;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(async () => {
  await truncateAll(db);
  [b1, b2, b3] = [(await crearBodega(db, { codigo: 'B1' })).id_bodega, (await crearBodega(db, { codigo: 'B2' })).id_bodega, (await crearBodega(db, { codigo: 'B3' })).id_bodega];
});
afterAll(() => db.destroy());

describe('saldoRepository', () => {
  describe('list', () => {
    beforeEach(async () => {
      // Producto 5 en las tres bodegas (3 + 4 + 0) y producto 6 en dos (10 + 20), insertados en desorden.
      await crearSaldo(db, { idProducto: 6, idBodega: b2, cantidad: 20 });
      await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 0 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 10 });
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    });

    const claves = (filas) => filas.map((fila) => [fila.id_producto, fila.id_bodega]);

    it('devuelve { filas, total, cantidadTotal } ordenado por id_producto e id_bodega, con exactamente los cinco campos de un Saldo', async () => {
      const { filas, total, cantidadTotal } = await saldoRepository.list(db, { limit: 10, offset: 0 });
      expect(claves(filas)).toEqual([[5, b1], [5, b2], [5, b3], [6, b1], [6, b2]]);
      expect(total).toBe(5);
      expect(cantidadTotal).toBe(37);
      expect(Object.keys(filas[0]).sort()).toEqual(['cantidad_disponible', 'fecha_actualizacion', 'id_bodega', 'id_producto', 'id_saldo']);
      expect(filas[0].fecha_actualizacion).toBeInstanceOf(Date);
      expect(await db('saldos').where({ id_saldo: filas[0].id_saldo }).first()).toEqual(filas[0]);
    });

    it('total y cantidadTotal son numéricos y cubren TODAS las filas del filtro, no las de la página', async () => {
      const { filas, total, cantidadTotal } = await saldoRepository.list(db, { limit: 2, offset: 2 });
      expect(claves(filas)).toEqual([[5, b3], [6, b1]]);
      expect(typeof total).toBe('number');
      expect(typeof cantidadTotal).toBe('number');
      expect(total).toBe(5);
      expect(cantidadTotal).toBe(37);
    });

    it('idProducto filtra filas, total y cantidadTotal con el mismo criterio', async () => {
      const { filas, total, cantidadTotal } = await saldoRepository.list(db, { idProducto: 5, limit: 1, offset: 0 });
      expect(claves(filas)).toEqual([[5, b1]]);
      expect(total).toBe(3);
      expect(cantidadTotal).toBe(7);
    });

    it('idBodega filtra filas, total y cantidadTotal con el mismo criterio', async () => {
      const { filas, total, cantidadTotal } = await saldoRepository.list(db, { idBodega: b2, limit: 10, offset: 0 });
      expect(claves(filas)).toEqual([[5, b2], [6, b2]]);
      expect(total).toBe(2);
      expect(cantidadTotal).toBe(24);
    });

    it('idProducto e idBodega juntos se combinan con AND', async () => {
      const { filas, total, cantidadTotal } = await saldoRepository.list(db, { idProducto: 6, idBodega: b1, limit: 10, offset: 0 });
      expect(claves(filas)).toEqual([[6, b1]]);
      expect(total).toBe(1);
      expect(cantidadTotal).toBe(10);
    });

    it('sin filas que cumplan el filtro: filas vacías, total 0 y cantidadTotal 0 (no null)', async () => {
      expect(await saldoRepository.list(db, { idProducto: 999, limit: 10, offset: 0 })).toEqual({ filas: [], total: 0, cantidadTotal: 0 });
    });

    it('una página fuera de rango devuelve filas vacías y el total exacto', async () => {
      expect(await saldoRepository.list(db, { limit: 10, offset: 100 })).toEqual({ filas: [], total: 5, cantidadTotal: 37 });
    });

    it('la suma no desborda el INTEGER y sale como número', async () => {
      await db('saldos').update({ cantidad_disponible: 2147483647 });
      const { cantidadTotal } = await saldoRepository.list(db, { idProducto: 5, limit: 10, offset: 0 });
      expect(cantidadTotal).toBe(3 * 2147483647);
    });

    it('los valores del filtro viajan como parámetros enlazados: ninguno se interpola en el texto de la consulta', async () => {
      const consultas = [];
      const registrar = (consulta) => consultas.push(consulta);
      db.on('query', registrar);
      try {
        await saldoRepository.list(db, { idProducto: 54321, idBodega: 98765, limit: 77, offset: 33 });
      } finally {
        db.removeListener('query', registrar);
      }
      expect(consultas.length).toBeGreaterThan(0);
      for (const { sql } of consultas) expect(sql).not.toMatch(/54321|98765|\b77\b|\b33\b/);
      const enlazados = consultas.flatMap(({ bindings }) => bindings);
      expect(enlazados).toEqual(expect.arrayContaining([54321, 98765, 77, 33]));
    });

    it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado y un rollback no deja nada', async () => {
      await expect(db.transaction(async (trx) => {
        await crearSaldo(trx, { idProducto: 77, idBodega: b1, cantidad: 9 });
        expect((await saldoRepository.list(trx, { idProducto: 77, limit: 10, offset: 0 })).cantidadTotal).toBe(9);
        expect((await saldoRepository.list(db, { idProducto: 77, limit: 10, offset: 0 })).total).toBe(0); // desde fuera no se ve
        throw new Error('deshacer');
      })).rejects.toThrow('deshacer');
      expect((await saldoRepository.list(db, { idProducto: 77, limit: 10, offset: 0 })).total).toBe(0);
    });
  });

  describe('totalPorProducto', () => {
    it('suma las bodegas del producto (3 + 4 + 0 = 7) como NÚMERO, sin contar los saldos de otro producto', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 0 });
      await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 100 });
      const total = await saldoRepository.totalPorProducto(db, 5);
      expect(total).toBe(7);
      expect(typeof total).toBe('number');
    });

    it('un producto sin ninguna fila de saldos da 0 (no null ni undefined)', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      expect(await saldoRepository.totalPorProducto(db, 5)).toBe(3); // control
      expect(await saldoRepository.totalPorProducto(db, 999)).toBe(0);
    });

    it('la suma no desborda el INTEGER', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2147483647 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 2147483647 });
      expect(await saldoRepository.totalPorProducto(db, 5)).toBe(4294967294);
    });

    it('dentro de una transacción ve los cambios de esa transacción (la Tarea 7 lo usa tras escribir el saldo)', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await db.transaction(async (trx) => {
        await trx('saldos').where({ id_producto: 5, id_bodega: b1 }).update({ cantidad_disponible: 1 });
        expect(await saldoRepository.totalPorProducto(trx, 5)).toBe(1);
        expect(await saldoRepository.totalPorProducto(db, 5)).toBe(3);
      });
      expect(await saldoRepository.totalPorProducto(db, 5)).toBe(1);
    });
  });

  describe('bajoUmbral', () => {
    it('devuelve [{ id_producto, cantidad_total, cantidad_minima }] solo con total < mínimo, ordenado por id_producto, con números', async () => {
      await crearUmbral(db, { idProducto: 9, cantidadMinima: 4 }); // sin saldos: total 0 < 4
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 }); // 7 < 10
      await crearUmbral(db, { idProducto: 6, cantidadMinima: 7 }); // 7 = 7: no
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
      await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 7 });
      const filas = await saldoRepository.bajoUmbral(db);
      expect(filas).toEqual([
        { id_producto: 5, cantidad_total: 7, cantidad_minima: 10 },
        { id_producto: 9, cantidad_total: 0, cantidad_minima: 4 },
      ]);
      for (const fila of filas) for (const valor of Object.values(fila)) expect(typeof valor).toBe('number');
    });

    it('sin umbrales o sin productos bajo el mínimo devuelve un arreglo vacío', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 0 });
      expect(await saldoRepository.bajoUmbral(db)).toEqual([]);
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 0 });
      expect(await saldoRepository.bajoUmbral(db)).toEqual([]);
    });

    it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado y un rollback no deja nada', async () => {
      await expect(db.transaction(async (trx) => {
        await crearUmbral(trx, { idProducto: 5, cantidadMinima: 10 });
        expect(await saldoRepository.bajoUmbral(trx)).toEqual([{ id_producto: 5, cantidad_total: 0, cantidad_minima: 10 }]);
        expect(await saldoRepository.bajoUmbral(db)).toEqual([]);
        throw new Error('deshacer');
      })).rejects.toThrow('deshacer');
      expect(await saldoRepository.bajoUmbral(db)).toEqual([]);
    });
  });
});

describe('saldoRepository.bloquear (motor de movimientos, Tarea 7)', () => {
  const CLAVES_SALDO = ['cantidad_disponible', 'fecha_actualizacion', 'id_bodega', 'id_producto', 'id_saldo'];

  it('devuelve el saldo existente con exactamente sus cinco campos, sin cambiarlo', async () => {
    const creado = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 8 });
    const saldo = await db.transaction((trx) => saldoRepository.bloquear(trx, { idProducto: 5, idBodega: b1 }));
    expect(Object.keys(saldo).sort()).toEqual(CLAVES_SALDO);
    expect(saldo).toEqual(creado);
  });

  it('sin fila la crea en 0 y la devuelve; un rollback no deja la fila', async () => {
    await expect(db.transaction(async (trx) => {
      const saldo = await saldoRepository.bloquear(trx, { idProducto: 5, idBodega: b1 });
      expect(saldo).toMatchObject({ id_producto: 5, id_bodega: b1, cantidad_disponible: 0 });
      throw new Error('deshacer');
    })).rejects.toThrow('deshacer');
    expect(await db('saldos')).toEqual([]);
  });

  it('con la fila ya creada no inserta otra (ON CONFLICT DO NOTHING) ni lanza el 23505', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2 });
    await db.transaction((trx) => saldoRepository.bloquear(trx, { idProducto: 5, idBodega: b1 }));
    await db.transaction((trx) => saldoRepository.bloquear(trx, { idProducto: 5, idBodega: b1 }));
    expect(await db('saldos')).toHaveLength(1);
  });

  it('BLOQUEA la fila hasta el fin de la transacción: otra conexión no puede tomarla (FOR UPDATE NOWAIT → 55P03)', async () => {
    const { id_saldo: idSaldo } = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2 });
    const intentar = () => db.raw('SELECT 1 FROM saldos WHERE id_saldo = ? FOR UPDATE NOWAIT', [idSaldo]);
    await intentar(); // control: sin nadie que la bloquee, se toma
    const trx = await db.transaction();
    try {
      await saldoRepository.bloquear(trx, { idProducto: 5, idBodega: b1 });
      await expect(intentar()).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await trx.rollback();
    }
    await intentar(); // liberada al terminar la transacción
  });
});

describe('saldoRepository.fijarCantidad (motor de movimientos, Tarea 7)', () => {
  it('fija la cantidad y la fecha_actualizacion con clock_timestamp() (posterior al inicio de la transacción, D24) y devuelve el saldo', async () => {
    const { id_saldo: idSaldo } = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2 });
    await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_sleep(0.01)');
      const saldo = await saldoRepository.fijarCantidad(trx, idSaldo, 9);
      expect(saldo).toMatchObject({ id_saldo: idSaldo, id_producto: 5, id_bodega: b1, cantidad_disponible: 9 });
      const { rows: [{ posterior }] } = await trx.raw('SELECT fecha_actualizacion > now() AS posterior FROM saldos WHERE id_saldo = ?', [idSaldo]);
      expect(posterior).toBe(true);
    });
    expect((await db('saldos').where({ id_saldo: idSaldo }).first()).cantidad_disponible).toBe(9);
  });

  it('solo toca la fila indicada', async () => {
    const uno = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2 });
    const otro = await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 4 });
    await saldoRepository.fijarCantidad(db, uno.id_saldo, 0);
    expect(await db('saldos').where({ id_saldo: otro.id_saldo }).first()).toEqual(otro);
  });

  it('un valor negativo lo rechaza la base (23514): el repositorio no valida, lo hace el motor', async () => {
    const { id_saldo: idSaldo } = await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2 });
    await expect(saldoRepository.fijarCantidad(db, idSaldo, -1)).rejects.toMatchObject({ code: '23514', constraint: 'saldos_cantidad_no_negativa' });
  });
});

// Cada función que exporta el repositorio con sus argumentos: todas son asíncronas.
promesasReales(saldoRepository, {
  list: [{ limit: 10, offset: 0 }],
  totalPorProducto: [5],
  bajoUmbral: [],
  // id_bodega 1: la primera bodega que crea el beforeEach (truncateAll reinicia las secuencias).
  bloquear: [{ idProducto: 5, idBodega: 1 }],
  fijarCantidad: [1, 0],
}, { titulo: 'saldoRepository', db: () => db });

describe('saldoService', () => {
  const OPERADOR = { idUsuario: 7, rol: 'OPERADOR_BODEGA', idBodega: 2, requestId: 'r1' };
  const ADMIN = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const INTERNA = { idUsuario: null, rol: null, idBodega: null, requestId: 'r1' };

  // Repositorio real salvo lo que cada prueba reemplaza.
  const servicio = (repo = {}) => crearSaldoService({ db, repo: { ...saldoRepository, ...repo } });
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);
  const listaVacia = () => jest.fn(async () => ({ filas: [], total: 0, cantidadTotal: 0 }));

  describe('listar', () => {
    it('un operador con otra bodega → 403 SIN_PERMISO y NO consulta el repositorio', async () => {
      const list = listaVacia();
      const error = await atrapar(servicio({ list }).listar({ identity: OPERADOR, idBodega: 3, limit: 20, offset: 0 }));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(list).not.toHaveBeenCalled();
    });

    it('un operador sin bodega asignada → 403 SIN_PERMISO', async () => {
      const list = listaVacia();
      const error = await atrapar(servicio({ list }).listar({ identity: { ...OPERADOR, idBodega: null }, limit: 20, offset: 0 }));
      expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
      expect(list).not.toHaveBeenCalled();
    });

    it('un operador sin id_bodega recibe el filtro de SU bodega; con la propia también', async () => {
      const list = listaVacia();
      await servicio({ list }).listar({ identity: OPERADOR, limit: 20, offset: 0 });
      await servicio({ list }).listar({ identity: OPERADOR, idBodega: 2, limit: 20, offset: 0 });
      expect(list).toHaveBeenNthCalledWith(1, db, { idProducto: undefined, idBodega: 2, limit: 20, offset: 0 });
      expect(list).toHaveBeenNthCalledWith(2, db, { idProducto: undefined, idBodega: 2, limit: 20, offset: 0 });
    });

    it.each([['un administrador', ADMIN], ['una llamada interna', INTERNA]])('%s: el filtro pasa tal cual, con o sin id_bodega', async (_nombre, identity) => {
      const list = listaVacia();
      await servicio({ list }).listar({ identity, idBodega: 3, idProducto: 5, limit: 20, offset: 40 });
      await servicio({ list }).listar({ identity, limit: 20, offset: 0 });
      expect(list).toHaveBeenNthCalledWith(1, db, { idProducto: 5, idBodega: 3, limit: 20, offset: 40 });
      expect(list).toHaveBeenNthCalledWith(2, db, { idProducto: undefined, idBodega: undefined, limit: 20, offset: 0 });
    });

    it('cantidadTotal solo se informa cuando se pidió un id_producto (D10); si no, es undefined', async () => {
      const list = jest.fn(async () => ({ filas: [{ id_saldo: 1 }], total: 1, cantidadTotal: 8 }));
      expect(await servicio({ list }).listar({ identity: ADMIN, idProducto: 5, limit: 20, offset: 0 })).toEqual({ filas: [{ id_saldo: 1 }], total: 1, cantidadTotal: 8 });
      expect(await servicio({ list }).listar({ identity: ADMIN, limit: 20, offset: 0 })).toEqual({ filas: [{ id_saldo: 1 }], total: 1, cantidadTotal: undefined });
    });

    it('un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      let resultado;
      expect(() => { resultado = servicio({ list: () => { throw falla; } }).listar({ identity: ADMIN, limit: 1, offset: 0 }); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });
  });

  describe('bajoUmbral', () => {
    it('devuelve lo que entrega el repositorio, sin envolverlo', async () => {
      const filas = [{ id_producto: 5, cantidad_total: 7, cantidad_minima: 10 }];
      const bajoUmbral = jest.fn(async () => filas);
      expect(await servicio({ bajoUmbral }).bajoUmbral()).toBe(filas);
      expect(bajoUmbral).toHaveBeenCalledWith(db);
    });

    it('con la base real: arreglo con los productos bajo el umbral', async () => {
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      expect(await servicio().bajoUmbral()).toEqual([{ id_producto: 5, cantidad_total: 3, cantidad_minima: 10 }]);
    });

    it('un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      let resultado;
      expect(() => { resultado = servicio({ bajoUmbral: () => { throw falla; } }).bajoUmbral(); }).not.toThrow();
      await expect(resultado).rejects.toBe(falla);
    });
  });

  it('no guarda estado entre llamadas (RNF05): dos servicios sobre la misma base ven los mismos datos', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 3 });
    const una = await servicio().listar({ identity: ADMIN, limit: 10, offset: 0 });
    const otra = await servicio().listar({ identity: ADMIN, limit: 10, offset: 0 });
    expect(otra).toEqual(una);
    expect(una.total).toBe(1);
  });
});
