const { AppError } = require('../src/errors');
const bodegaRepository = require('../src/repositories/bodegaRepository');
const { crearBodegaService } = require('../src/services/bodegaService');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearBodega } = require('./helpers/fixtures');

// Las capas de bodegas por separado (RNF13): el repositorio contra PostgreSQL real y el servicio con un repositorio falso.
// El comportamiento de punta a punta está en bodegas.test.js.

const DATOS = { codigo: 'MZL', nombre: 'Principal', ciudad: 'Manizales', direccion: 'Cra 1' };

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => truncateAll(db));
afterAll(() => db.destroy());

const filas = () => db('bodegas').select('*').orderBy('id_bodega');

// Error de PostgreSQL por una restricción única, con la forma que entrega `pg`.
const errorUnico = (constraint) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });

describe('bodegaRepository', () => {
  describe('insert', () => {
    it('inserta y devuelve la bodega completa, activa por defecto', async () => {
      const bodega = await bodegaRepository.insert(db, DATOS);
      expect(bodega).toEqual({ id_bodega: expect.any(Number), ...DATOS, activa: true });
      expect(await filas()).toEqual([bodega]);
    });

    it('solo inserta las cuatro columnas editables: ignora `activa` e `id_bodega` que lleguen de más', async () => {
      const bodega = await bodegaRepository.insert(db, { ...DATOS, activa: false, id_bodega: 99, otro: 'x' });
      expect(bodega.activa).toBe(true);
      expect(bodega.id_bodega).not.toBe(99);
    });

    it('con un codigo repetido lanza el error 23505 de la restricción bodegas_codigo_key', async () => {
      await bodegaRepository.insert(db, DATOS);
      const error = await bodegaRepository.insert(db, DATOS).catch((falla) => falla);
      expect(error).toMatchObject({ code: '23505', constraint: 'bodegas_codigo_key' });
      expect(bodegaRepository.esCodigoDuplicado(error)).toBe(true);
    });

    it('con un codigo que solo difiere en mayúsculas lanza el 23505 del índice bodegas_codigo_lower_key (pg informa su nombre)', async () => {
      await bodegaRepository.insert(db, DATOS);
      for (const variante of ['mzl', 'Mzl']) {
        const error = await bodegaRepository.insert(db, { ...DATOS, codigo: variante }).catch((falla) => falla);
        expect(error).toMatchObject({ code: '23505', constraint: 'bodegas_codigo_lower_key' });
        expect(bodegaRepository.esCodigoDuplicado(error)).toBe(true);
      }
      expect(await filas()).toHaveLength(1);
    });

    it('funciona dentro de una transacción (dbOrTrx): un rollback no deja nada', async () => {
      await expect(db.transaction(async (trx) => {
        await bodegaRepository.insert(trx, DATOS);
        expect(await bodegaRepository.findByCodigo(trx, 'MZL')).toBeDefined();
        throw new Error('deshacer');
      })).rejects.toThrow('deshacer');
      expect(await filas()).toEqual([]);

      const confirmada = await db.transaction((trx) => bodegaRepository.insert(trx, DATOS));
      expect(await filas()).toEqual([confirmada]);
    });
  });

  describe('findById y findByCodigo', () => {
    it('devuelven la bodega con exactamente sus seis campos, o undefined si no existe', async () => {
      const creada = await crearBodega(db, { codigo: 'B1' });
      expect(await bodegaRepository.findById(db, creada.id_bodega)).toEqual(creada);
      expect(Object.keys(await bodegaRepository.findById(db, creada.id_bodega)).sort())
        .toEqual(['activa', 'ciudad', 'codigo', 'direccion', 'id_bodega', 'nombre']);
      expect(await bodegaRepository.findById(db, 999)).toBeUndefined();
      expect(await bodegaRepository.findByCodigo(db, 'B1')).toEqual(creada);
      expect(await bodegaRepository.findByCodigo(db, 'NOPE')).toBeUndefined();
    });

    it('findByCodigo no distingue mayúsculas (como la unicidad del código) y encuentra también las inactivas', async () => {
      const inactiva = await crearBodega(db, { codigo: 'MZL', activa: false });
      expect(await bodegaRepository.findByCodigo(db, 'MZL')).toEqual(inactiva);
      for (const variante of ['mzl', 'Mzl', 'mZL']) expect(await bodegaRepository.findByCodigo(db, variante)).toEqual(inactiva);
    });

    it('findByCodigo no encuentra un código distinto, aunque se parezca, ni un código con espacios (el repositorio no recorta)', async () => {
      await crearBodega(db, { codigo: 'MZL' });
      for (const otro of ['MZ', 'MZL1', 'M-ZL', ' mzl', 'mzl ', '']) expect(await bodegaRepository.findByCodigo(db, otro)).toBeUndefined();
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      for (const [codigo, activa] of [['C', true], ['A', false], ['B', true], ['D', false]]) await crearBodega(db, { codigo, activa });
    });

    it('devuelve { filas, total } ordenado por id_bodega; total cuenta todas las filas, no las de la página', async () => {
      const { filas: pagina, total } = await bodegaRepository.list(db, { limit: 2, offset: 0 });
      expect(pagina.map((fila) => fila.codigo)).toEqual(['C', 'A']);
      expect(total).toBe(4);
      expect(typeof total).toBe('number');
      expect((await bodegaRepository.list(db, { limit: 2, offset: 2 })).filas.map((fila) => fila.codigo)).toEqual(['B', 'D']);
    });

    it('activa filtra filas y total con el mismo criterio; undefined no filtra', async () => {
      const inactivas = await bodegaRepository.list(db, { activa: false, limit: 1, offset: 0 });
      expect(inactivas.filas.map((fila) => fila.codigo)).toEqual(['A']);
      expect(inactivas.total).toBe(2);
      const activas = await bodegaRepository.list(db, { activa: true, limit: 10, offset: 0 });
      expect(activas.filas.map((fila) => fila.codigo)).toEqual(['C', 'B']);
      expect(activas.total).toBe(2);
      expect((await bodegaRepository.list(db, { activa: undefined, limit: 10, offset: 0 })).total).toBe(4);
    });

    it('una página fuera de rango devuelve filas vacías y el total exacto', async () => {
      expect(await bodegaRepository.list(db, { limit: 10, offset: 100 })).toEqual({ filas: [], total: 4 });
    });
  });

  describe('update y setActiva', () => {
    it('update cambia nombre, ciudad y direccion, devuelve la bodega y no toca codigo ni activa aunque lleguen', async () => {
      const creada = await crearBodega(db, { codigo: 'MZL', activa: false });
      const nueva = await bodegaRepository.update(db, creada.id_bodega, { nombre: 'N', ciudad: 'C', direccion: 'D', codigo: 'X', activa: true });
      expect(nueva).toEqual({ id_bodega: creada.id_bodega, codigo: 'MZL', nombre: 'N', ciudad: 'C', direccion: 'D', activa: false });
      expect(await filas()).toEqual([nueva]);
    });

    it('update de un id inexistente devuelve undefined y no cambia nada', async () => {
      const creada = await crearBodega(db, { codigo: 'MZL' });
      expect(await bodegaRepository.update(db, 999, { nombre: 'N', ciudad: 'C', direccion: 'D' })).toBeUndefined();
      expect(await filas()).toEqual([creada]);
    });

    it('setActiva cambia solo el estado, devuelve la bodega (también si ya estaba así) y undefined si no existe', async () => {
      const creada = await crearBodega(db, { codigo: 'MZL' });
      const otra = await crearBodega(db, { codigo: 'OTRA' });
      expect(await bodegaRepository.setActiva(db, creada.id_bodega, false)).toEqual({ ...creada, activa: false });
      expect(await bodegaRepository.setActiva(db, creada.id_bodega, false)).toEqual({ ...creada, activa: false });
      expect(await bodegaRepository.setActiva(db, creada.id_bodega, true)).toEqual(creada);
      expect(await bodegaRepository.setActiva(db, 999, true)).toBeUndefined();
      expect((await filas())[1]).toEqual(otra);
    });
  });

  describe('esCodigoDuplicado', () => {
    it.each(['bodegas_codigo_key', 'bodegas_codigo_lower_key'])('es verdadero para el 23505 de la restricción %s (código exacto o sin distinguir mayúsculas)', (restriccion) => {
      expect(bodegaRepository.esCodigoDuplicado(errorUnico(restriccion))).toBe(true);
    });

    it('RESTRICCIONES_CODIGO nombra exactamente esas dos restricciones', () => {
      expect([...bodegaRepository.RESTRICCIONES_CODIGO].sort()).toEqual(['bodegas_codigo_key', 'bodegas_codigo_lower_key']);
    });

    it('un 23505 de otra restricción no es un código duplicado', () => {
      expect(bodegaRepository.esCodigoDuplicado(errorUnico('movimientos_clave_idempotencia_key'))).toBe(false);
      expect(bodegaRepository.esCodigoDuplicado(errorUnico('bodegas_pkey'))).toBe(false);
      expect(bodegaRepository.esCodigoDuplicado(errorUnico('bodegas_codigo_otra_key'))).toBe(false);
      expect(bodegaRepository.esCodigoDuplicado(errorUnico(undefined))).toBe(false);
    });

    it('no se guía por el texto del mensaje: un 23505 ajeno que mencione la restricción no cuenta', () => {
      const ajeno = Object.assign(new Error('mensaje con bodegas_codigo_key dentro'), { code: '23505', constraint: 'otra_key' });
      expect(bodegaRepository.esCodigoDuplicado(ajeno)).toBe(false);
      expect(bodegaRepository.esCodigoDuplicado(new Error('duplicate key value violates unique constraint "bodegas_codigo_key"'))).toBe(false);
    });

    it('la restricción correcta con otro código de error tampoco cuenta; ni lo que no es un error', () => {
      for (const restriccion of ['bodegas_codigo_key', 'bodegas_codigo_lower_key']) {
        expect(bodegaRepository.esCodigoDuplicado(Object.assign(new Error('x'), { code: '23503', constraint: restriccion }))).toBe(false);
      }
      for (const valor of [undefined, null, 'texto', 42, {}]) expect(bodegaRepository.esCodigoDuplicado(valor)).toBe(false);
    });
  });
});

describe('bodegaRepository: promesas reales (Ruling 21)', () => {
  // Un Knex sin `async` devuelve el builder (un thenable), no una Promise: un fallo síncrono lanza en vez de rechazar y cada
  // `await` sobre el mismo valor ejecuta la consulta otra vez. Esta es la lista de las funciones asíncronas que exporta el
  // repositorio; las tareas siguientes copian el patrón.
  const FUNCIONES = {
    findById: [1],
    findByCodigo: ['MZL'],
    list: [{ limit: 10, offset: 0 }],
    insert: [DATOS],
    update: [1, { nombre: 'N', ciudad: 'C', direccion: 'D' }],
    setActiva: [1, false],
  };

  it('la lista de arriba cubre TODA función asíncrona exportada (esCodigoDuplicado es la única síncrona)', () => {
    const exportadas = Object.entries(bodegaRepository).filter(([, valor]) => typeof valor === 'function').map(([nombre]) => nombre);
    expect(exportadas.filter((nombre) => nombre !== 'esCodigoDuplicado').sort()).toEqual(Object.keys(FUNCIONES).sort());
    expect(bodegaRepository.esCodigoDuplicado(undefined)).toBe(false); // síncrona: devuelve un booleano, no una promesa
  });

  it.each(Object.entries(FUNCIONES))('%s devuelve una Promise real, no el builder de Knex', async (nombre, argumentos) => {
    const resultado = bodegaRepository[nombre](db, ...argumentos);
    expect(resultado).toBeInstanceOf(Promise);
    await resultado;
  });

  it.each(Object.entries(FUNCIONES))('%s: un fallo síncrono (db nulo) llega como RECHAZO, no como excepción síncrona', async (nombre, argumentos) => {
    let resultado;
    expect(() => { resultado = bodegaRepository[nombre](null, ...argumentos); }).not.toThrow();
    expect(resultado).toBeInstanceOf(Promise);
    await expect(resultado).rejects.toBeInstanceOf(TypeError);
  });

  it.each(Object.entries(FUNCIONES))('%s: esperar dos veces la misma promesa NO ejecuta la consulta dos veces', async (nombre, argumentos) => {
    const sql = [];
    const registrar = (consulta) => sql.push(consulta.sql);
    db.on('query', registrar);
    try {
      const resultado = bodegaRepository[nombre](db, ...argumentos);
      await resultado;
      const tras1 = sql.length;
      expect(tras1).toBeGreaterThan(0);
      await resultado;
      expect(sql.length).toBe(tras1);
    } finally {
      db.removeListener('query', registrar);
    }
  });
});

describe('bodegaService', () => {
  // Repositorio real salvo lo que cada prueba reemplaza.
  const servicio = (repo = {}) => crearBodegaService({ db, repo: { ...bodegaRepository, ...repo } });
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);

  describe('crear', () => {
    it.each(['bodegas_codigo_key', 'bodegas_codigo_lower_key'])('un 23505 de %s → 409 CODIGO_DUPLICADO', async (restriccion) => {
      const error = await atrapar(servicio({ insert: async () => { throw errorUnico(restriccion); } }).crear(DATOS));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, codigo: 'CODIGO_DUPLICADO' });
      expect(error.message).toMatch(/\S/);
    });

    it('un 23505 de CUALQUIER OTRA restricción no se disfraza de CODIGO_DUPLICADO: se relanza el mismo error', async () => {
      const ajeno = errorUnico('movimientos_clave_idempotencia_key');
      const error = await atrapar(servicio({ insert: async () => { throw ajeno; } }).crear(DATOS));
      expect(error).toBe(ajeno);
      expect(error).not.toBeInstanceOf(AppError);
    });

    it('cualquier otro error de la base se relanza tal cual (el manejador lo registra y responde 500)', async () => {
      const caida = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
      expect(await atrapar(servicio({ insert: async () => { throw caida; } }).crear(DATOS))).toBe(caida);
    });

    it('sin conflicto devuelve la bodega creada', async () => {
      expect(await servicio().crear(DATOS)).toEqual({ id_bodega: expect.any(Number), ...DATOS, activa: true });
    });

    it('con un código repetido de verdad (base real), con las mismas o distintas mayúsculas → 409 CODIGO_DUPLICADO', async () => {
      await servicio().crear(DATOS);
      expect(await atrapar(servicio().crear(DATOS))).toMatchObject({ status: 409, codigo: 'CODIGO_DUPLICADO' });
      expect(await atrapar(servicio().crear({ ...DATOS, codigo: 'mzl' }))).toMatchObject({ status: 409, codigo: 'CODIGO_DUPLICADO' });
    });
  });

  describe('obtener, actualizar, inactivar y activar', () => {
    it('lanzan 404 NO_EXISTE cuando el repositorio no encuentra la bodega', async () => {
      const vacio = { findById: async () => undefined, update: async () => undefined, setActiva: async () => undefined };
      const s = servicio(vacio);
      for (const llamada of [() => s.obtener(1), () => s.actualizar(1, { nombre: 'N', ciudad: 'C', direccion: 'D' }), () => s.inactivar(1), () => s.activar(1)]) {
        const error = await atrapar(llamada());
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      }
    });

    it('inactivar y activar fijan el estado con setActiva y devuelven la bodega', async () => {
      const creada = await crearBodega(db, { codigo: 'MZL' });
      expect(await servicio().inactivar(creada.id_bodega)).toEqual({ ...creada, activa: false });
      expect(await servicio().activar(creada.id_bodega)).toEqual(creada);
    });

    it('actualizar solo envía al repositorio nombre, ciudad y direccion', async () => {
      const update = jest.fn(async () => ({ id_bodega: 1 }));
      await servicio({ update }).actualizar(1, { nombre: 'N', ciudad: 'C', direccion: 'D', codigo: 'X', activa: false });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(db, 1, { nombre: 'N', ciudad: 'C', direccion: 'D' });
    });
  });

  describe('listar', () => {
    it('devuelve una Promise real y un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      const s = servicio({ list: () => { throw falla; } });
      let resultado;
      expect(() => { resultado = s.listar({ limit: 1, offset: 0 }); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });

    it('pasa activa, limit y offset al repositorio y devuelve { filas, total }', async () => {
      const list = jest.fn(async () => ({ filas: [], total: 7 }));
      expect(await servicio({ list }).listar({ activa: false, limit: 5, offset: 10 })).toEqual({ filas: [], total: 7 });
      expect(list).toHaveBeenCalledWith(db, { activa: false, limit: 5, offset: 10 });
    });
  });

  it('no guarda estado entre llamadas (RNF05): dos servicios sobre la misma base ven los mismos datos', async () => {
    const creada = await servicio().crear(DATOS);
    expect(await servicio().obtener(creada.id_bodega)).toEqual(creada);
  });
});
