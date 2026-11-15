const { AppError, e } = require('../src/errors');
const umbralRepository = require('../src/repositories/umbralRepository');
const { crearUmbralService } = require('../src/services/umbralService');
const { createTestDb, truncateAll } = require('./helpers/db');
const { crearUmbral, fakeCatalogo } = require('./helpers/fixtures');

// Las capas de umbrales por separado (RNF13): el repositorio contra PostgreSQL real y el servicio con un repositorio y un
// catálogo falsos. El comportamiento de punta a punta está en umbrales.test.js.

let db;
beforeAll(() => {
  db = createTestDb();
});
beforeEach(() => truncateAll(db));
afterAll(() => db.destroy());

const filas = () => db('umbrales_producto').select('*').orderBy('id_producto');
// Retrasa la fecha de todas las filas una hora: una actualización posterior queda siempre estrictamente después.
const retrasar = () => db('umbrales_producto').update({ fecha_actualizacion: db.raw("now() - interval '1 hour'") });

describe('umbralRepository', () => {
  describe('findByProducto', () => {
    it('devuelve el umbral con exactamente sus tres campos, o undefined si el producto no tiene', async () => {
      const creado = await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
      expect(await umbralRepository.findByProducto(db, 5)).toEqual(creado);
      expect(Object.keys(await umbralRepository.findByProducto(db, 5)).sort()).toEqual(['cantidad_minima', 'fecha_actualizacion', 'id_producto']);
      expect(await umbralRepository.findByProducto(db, 999)).toBeUndefined();
    });

    it('un umbral de 0 es un umbral (no se confunde con la ausencia)', async () => {
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 0 });
      expect(await umbralRepository.findByProducto(db, 5)).toMatchObject({ id_producto: 5, cantidad_minima: 0 });
    });

    it('funciona dentro de una transacción (dbOrTrx): ve lo no confirmado', async () => {
      await db.transaction(async (trx) => {
        await crearUmbral(trx, { idProducto: 5, cantidadMinima: 10 });
        expect(await umbralRepository.findByProducto(trx, 5)).toMatchObject({ cantidad_minima: 10 });
        expect(await umbralRepository.findByProducto(db, 5)).toBeUndefined();
      });
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      for (const idProducto of [4, 2, 5, 1, 3]) await crearUmbral(db, { idProducto, cantidadMinima: idProducto * 10 });
    });

    it('devuelve { filas, total } ordenado por id_producto; total cuenta todas las filas, no las de la página', async () => {
      const { filas: pagina, total } = await umbralRepository.list(db, { limit: 2, offset: 0 });
      expect(pagina.map((fila) => fila.id_producto)).toEqual([1, 2]);
      expect(total).toBe(5);
      expect(typeof total).toBe('number');
      expect((await umbralRepository.list(db, { limit: 2, offset: 2 })).filas.map((fila) => fila.id_producto)).toEqual([3, 4]);
      expect(Object.keys(pagina[0]).sort()).toEqual(['cantidad_minima', 'fecha_actualizacion', 'id_producto']);
    });

    it('idProducto filtra filas y total con el mismo criterio; undefined no filtra', async () => {
      expect(await umbralRepository.list(db, { idProducto: 3, limit: 10, offset: 0 })).toEqual({
        filas: [expect.objectContaining({ id_producto: 3, cantidad_minima: 30 })],
        total: 1,
      });
      expect(await umbralRepository.list(db, { idProducto: 999, limit: 10, offset: 0 })).toEqual({ filas: [], total: 0 });
      expect((await umbralRepository.list(db, { idProducto: undefined, limit: 10, offset: 0 })).total).toBe(5);
    });

    it('una página fuera de rango devuelve filas vacías y el total exacto', async () => {
      expect(await umbralRepository.list(db, { limit: 10, offset: 100 })).toEqual({ filas: [], total: 5 });
    });
  });

  describe('upsert', () => {
    it('crea el umbral y devuelve la fila con exactamente sus tres campos', async () => {
      const umbral = await umbralRepository.upsert(db, 5, 10);
      expect(umbral).toEqual({ id_producto: 5, cantidad_minima: 10, fecha_actualizacion: expect.any(Date) });
      expect(await filas()).toEqual([umbral]);
    });

    it('con el producto ya existente actualiza la MISMA fila (no inserta otra) y refresca fecha_actualizacion', async () => {
      await umbralRepository.upsert(db, 5, 10);
      await retrasar();
      const [retrasada] = await filas();
      const umbral = await umbralRepository.upsert(db, 5, 25);
      expect(umbral).toMatchObject({ id_producto: 5, cantidad_minima: 25 });
      expect(umbral.fecha_actualizacion.getTime()).toBeGreaterThan(retrasada.fecha_actualizacion.getTime());
      expect(await filas()).toEqual([umbral]);
    });

    it('repetir el mismo valor también refresca la fecha', async () => {
      await umbralRepository.upsert(db, 5, 10);
      await retrasar();
      const [retrasada] = await filas();
      const umbral = await umbralRepository.upsert(db, 5, 10);
      expect(umbral.fecha_actualizacion.getTime()).toBeGreaterThan(retrasada.fecha_actualizacion.getTime());
    });

    it('no toca los umbrales de otros productos', async () => {
      const otro = await crearUmbral(db, { idProducto: 6, cantidadMinima: 20 });
      await umbralRepository.upsert(db, 5, 10);
      await umbralRepository.upsert(db, 5, 11);
      expect(await filas()).toEqual([expect.objectContaining({ id_producto: 5, cantidad_minima: 11 }), otro]);
    });

    it('es una sola sentencia INSERT … ON CONFLICT … DO UPDATE: sin lectura previa que deje una carrera', async () => {
      const sql = [];
      const registrar = (consulta) => sql.push(consulta.sql);
      db.on('query', registrar);
      try {
        await umbralRepository.upsert(db, 5, 10);
        await umbralRepository.upsert(db, 5, 11);
      } finally {
        db.removeListener('query', registrar);
      }
      expect(sql).toHaveLength(2);
      for (const consulta of sql) expect(consulta).toMatch(/^insert into "umbrales_producto".+on conflict \("id_producto"\) do update set .*excluded\.cantidad_minima.*returning/is);
    });

    it('veinte upserts simultáneos del mismo producto dejan UNA fila y cada uno devuelve lo que escribió', async () => {
      const valores = Array.from({ length: 20 }, (_, k) => k + 1);
      const resultados = await Promise.all(valores.map((cantidad) => umbralRepository.upsert(db, 5, cantidad)));
      expect(resultados.map((umbral) => umbral.cantidad_minima)).toEqual(valores);
      const guardadas = await filas();
      expect(guardadas).toHaveLength(1);
      expect(valores).toContain(guardadas[0].cantidad_minima);
    });

    it('los valores viajan como parámetros enlazados: ninguno se interpola en el texto de la consulta', async () => {
      const consultas = [];
      const registrar = (consulta) => consultas.push(consulta);
      db.on('query', registrar);
      try {
        await umbralRepository.upsert(db, 54321, 98765);
      } finally {
        db.removeListener('query', registrar);
      }
      for (const { sql } of consultas) expect(sql).not.toMatch(/54321|98765/);
      expect(consultas.flatMap(({ bindings }) => bindings)).toEqual(expect.arrayContaining([54321, 98765]));
    });

    it('funciona dentro de una transacción (dbOrTrx): un rollback no deja nada y una confirmación sí', async () => {
      await expect(db.transaction(async (trx) => {
        await umbralRepository.upsert(trx, 5, 10);
        expect(await umbralRepository.findByProducto(trx, 5)).toMatchObject({ cantidad_minima: 10 });
        throw new Error('deshacer');
      })).rejects.toThrow('deshacer');
      expect(await filas()).toEqual([]);

      const confirmado = await db.transaction((trx) => umbralRepository.upsert(trx, 5, 10));
      expect(await filas()).toEqual([confirmado]);
    });

    it('un valor fuera de la restricción de la base (negativo) lanza el 23514: el repositorio no valida, lo hace el controlador', async () => {
      await expect(umbralRepository.upsert(db, 5, -1)).rejects.toMatchObject({ code: '23514', constraint: 'umbrales_producto_cantidad_minima_no_negativa' });
      expect(await filas()).toEqual([]);
    });
  });
});

describe('umbralRepository: promesas reales (Ruling 21)', () => {
  // Un Knex sin `async` devuelve el builder (un thenable), no una Promise: un fallo síncrono lanza en vez de rechazar y cada
  // `await` sobre el mismo valor ejecuta la consulta otra vez. Esta es la lista de las funciones que exporta el repositorio.
  const FUNCIONES = {
    findByProducto: [5],
    list: [{ limit: 10, offset: 0 }],
    upsert: [5, 10],
  };

  it('la lista de arriba cubre TODA función exportada: todas son asíncronas', () => {
    const exportadas = Object.entries(umbralRepository).filter(([, valor]) => typeof valor === 'function').map(([nombre]) => nombre);
    expect(exportadas.sort()).toEqual(Object.keys(FUNCIONES).sort());
  });

  it.each(Object.entries(FUNCIONES))('%s devuelve una Promise real, no el builder de Knex', async (nombre, argumentos) => {
    const resultado = umbralRepository[nombre](db, ...argumentos);
    expect(resultado).toBeInstanceOf(Promise);
    await resultado;
  });

  it.each(Object.entries(FUNCIONES))('%s: un fallo síncrono (db nulo) llega como RECHAZO, no como excepción síncrona', async (nombre, argumentos) => {
    let resultado;
    expect(() => { resultado = umbralRepository[nombre](null, ...argumentos); }).not.toThrow();
    expect(resultado).toBeInstanceOf(Promise);
    await expect(resultado).rejects.toBeInstanceOf(TypeError);
  });

  it.each(Object.entries(FUNCIONES))('%s: esperar dos veces la misma promesa NO ejecuta la consulta dos veces', async (nombre, argumentos) => {
    const sql = [];
    const registrar = (consulta) => sql.push(consulta.sql);
    db.on('query', registrar);
    try {
      const resultado = umbralRepository[nombre](db, ...argumentos);
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

describe('umbralService', () => {
  const IDENTIDAD = { idUsuario: 7, rol: 'ADMINISTRADOR', idBodega: null, requestId: 'r1' };
  const CABECERAS = { 'X-Request-Id': 'r1', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' };

  // Repositorio real salvo lo que cada prueba reemplaza; el catálogo se entrega dentro de `clients`, como en la aplicación.
  const servicio = ({ repo = {}, catalogo = fakeCatalogo() } = {}) => crearUmbralService({ db, clients: { catalogo }, repo: { ...umbralRepository, ...repo } });
  const atrapar = (promesa) => promesa.then(() => { throw new Error('Se esperaba un rechazo'); }, (error) => error);

  describe('guardar', () => {
    it('confirma el producto en el catálogo con las cabeceras de propagación y SOLO después escribe', async () => {
      const catalogo = fakeCatalogo();
      const upsert = jest.fn(async () => ({ id_producto: 5, cantidad_minima: 10 }));
      const umbral = await servicio({ catalogo, repo: { upsert } }).guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 });
      expect(umbral).toEqual({ id_producto: 5, cantidad_minima: 10 });
      expect(catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
      expect(catalogo.obtenerProducto).toHaveBeenCalledWith(5, CABECERAS);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(db, 5, 10);
      expect(catalogo.obtenerProducto.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder[0]);
    });

    it('un producto que el catálogo no conoce (null) → 404 NO_EXISTE y NO escribe', async () => {
      const upsert = jest.fn();
      const error = await atrapar(servicio({ repo: { upsert } }).guardar({ identity: IDENTIDAD, idProducto: 999, cantidadMinima: 10 }));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('un resultado vacío del catálogo (undefined) tampoco confirma el producto: 404 y NO escribe (falla cerrado)', async () => {
      const upsert = jest.fn();
      const catalogo = { obtenerProducto: jest.fn(async () => undefined) };
      const error = await atrapar(servicio({ catalogo, repo: { upsert } }).guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 }));
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
      expect(upsert).not.toHaveBeenCalled();
    });

    it('con el catálogo caído el 503 se propaga TAL CUAL (el mismo AppError) y NO escribe', async () => {
      const upsert = jest.fn();
      const caida = e.noDisponible('ms-catalogo no responde');
      const catalogo = { obtenerProducto: jest.fn(async () => { throw caida; }) };
      expect(await atrapar(servicio({ catalogo, repo: { upsert } }).guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 }))).toBe(caida);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('un fallo síncrono del catálogo llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      const catalogo = { obtenerProducto: () => { throw falla; } };
      let resultado;
      expect(() => { resultado = servicio({ catalogo }).guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 }); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });

    it('un error de la base al escribir se relanza tal cual (el manejador lo registra y responde 500)', async () => {
      const caida = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
      const error = await atrapar(servicio({ repo: { upsert: async () => { throw caida; } } }).guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 }));
      expect(error).toBe(caida);
    });

    it('no toma una conexión de la base mientras espera al catálogo', async () => {
      let tomadas;
      const catalogo = { obtenerProducto: jest.fn(async (id) => { tomadas = db.client.pool.numUsed(); return { id_producto: id }; }) };
      await servicio({ catalogo }).guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 });
      expect(tomadas).toBe(0);
    });

    it('con la base real crea y luego actualiza el umbral', async () => {
      const primero = await servicio().guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 });
      const segundo = await servicio().guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 12 });
      expect(primero).toMatchObject({ id_producto: 5, cantidad_minima: 10 });
      expect(segundo).toMatchObject({ id_producto: 5, cantidad_minima: 12 });
      expect(await filas()).toEqual([segundo]);
    });

    it('lee el catálogo de `clients` en cada llamada, no al construirse: se puede construir sin clientes (rutasDeclaradas())', async () => {
      const servicioSinClientes = crearUmbralService({ db });
      expect(servicioSinClientes).toBeDefined();
      expect(() => crearUmbralService()).not.toThrow();
      const clients = {};
      const tardio = crearUmbralService({ db, clients });
      clients.catalogo = fakeCatalogo();
      expect(await tardio.guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 3 })).toMatchObject({ id_producto: 5, cantidad_minima: 3 });
    });
  });

  describe('listar', () => {
    it('pasa idProducto, limit y offset al repositorio y devuelve { filas, total }', async () => {
      const list = jest.fn(async () => ({ filas: [], total: 7 }));
      expect(await servicio({ repo: { list } }).listar({ idProducto: 5, limit: 5, offset: 10 })).toEqual({ filas: [], total: 7 });
      expect(list).toHaveBeenCalledWith(db, { idProducto: 5, limit: 5, offset: 10 });
    });

    it('devuelve una Promise real y un fallo síncrono del repositorio llega como rechazo, no como excepción', async () => {
      const falla = new Error('fallo síncrono');
      let resultado;
      expect(() => { resultado = servicio({ repo: { list: () => { throw falla; } } }).listar({ limit: 1, offset: 0 }); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBe(falla);
    });

    it('no llama al catálogo: es una lectura', async () => {
      const catalogo = fakeCatalogo();
      await servicio({ catalogo }).listar({ idProducto: 999, limit: 10, offset: 0 });
      expect(catalogo.obtenerProducto).not.toHaveBeenCalled();
    });
  });

  it('no guarda estado entre llamadas (RNF05): dos servicios sobre la misma base ven los mismos datos', async () => {
    const creado = await servicio().guardar({ identity: IDENTIDAD, idProducto: 5, cantidadMinima: 10 });
    expect(await servicio().listar({ limit: 10, offset: 0 })).toEqual({ filas: [creado], total: 1 });
  });
});
