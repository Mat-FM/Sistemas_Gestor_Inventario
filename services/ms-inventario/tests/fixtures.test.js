const { AppError } = require('../src/errors');
const { createTestDb, truncateAll } = require('./helpers/db');
const { buildTestApp } = require('./helpers/app');
const { crearBodega, crearSaldo, crearUmbral, crearLote, headers, fakeCatalogo, fakeNotificaciones } = require('./helpers/fixtures');

describe('fixtures: datos en la base real', () => {
  let db;
  beforeAll(() => {
    db = createTestDb();
  });
  afterAll(async () => {
    await truncateAll(db);
    await db.destroy();
  });
  beforeEach(() => truncateAll(db));

  describe('crearBodega', () => {
    it('sin opciones crea la bodega B1 activa y devuelve la fila (no un arreglo)', async () => {
      const bodega = await crearBodega(db);
      expect(bodega).toEqual({ id_bodega: 1, codigo: 'B1', nombre: 'Bodega B1', ciudad: 'Manizales', direccion: 'Calle B1', activa: true });
      expect(await db('bodegas')).toEqual([bodega]);
    });

    it('respeta el código y el estado pedidos, y admite `{}` como segundo argumento', async () => {
      const inactiva = await crearBodega(db, { codigo: 'ZZ', activa: false });
      expect(inactiva).toMatchObject({ codigo: 'ZZ', nombre: 'Bodega ZZ', activa: false });
      expect(await crearBodega(db, {})).toMatchObject({ codigo: 'B1', activa: true });
    });

    it('dos bodegas con el mismo código chocan por la unicidad; con códigos distintos conviven con ids distintos', async () => {
      const a = await crearBodega(db, { codigo: 'B1' });
      await expect(crearBodega(db, { codigo: 'B1' })).rejects.toMatchObject({ code: '23505' });
      const b = await crearBodega(db, { codigo: 'B2' });
      expect(b.id_bodega).not.toBe(a.id_bodega);
    });

    it('funciona también dentro de una transacción', async () => {
      const REVERTIR = new Error('revertir');
      await expect(db.transaction(async (trx) => {
        expect((await crearBodega(trx, { codigo: 'T1' })).codigo).toBe('T1');
        throw REVERTIR;
      })).rejects.toBe(REVERTIR);
      expect(await db('bodegas')).toEqual([]);
    });
  });

  describe('crearSaldo', () => {
    it('guarda el saldo con la cantidad pedida y devuelve la fila', async () => {
      const { id_bodega: idBodega } = await crearBodega(db);
      const saldo = await crearSaldo(db, { idProducto: 5, idBodega, cantidad: 12 });
      expect(saldo).toMatchObject({ id_saldo: 1, id_producto: 5, id_bodega: idBodega, cantidad_disponible: 12 });
      expect(saldo.fecha_actualizacion).toBeInstanceOf(Date);
      expect(await db('saldos').where({ id_saldo: saldo.id_saldo }).first()).toEqual(saldo);
    });

    it('sin cantidad el saldo empieza en 0', async () => {
      const { id_bodega: idBodega } = await crearBodega(db);
      expect((await crearSaldo(db, { idProducto: 5, idBodega })).cantidad_disponible).toBe(0);
    });
  });

  describe('crearUmbral', () => {
    it('guarda el umbral y devuelve la fila (no un arreglo)', async () => {
      const umbral = await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
      expect(umbral).toMatchObject({ id_producto: 5, cantidad_minima: 10 });
      expect(umbral.fecha_actualizacion).toBeInstanceOf(Date);
      expect(Object.keys(umbral).sort()).toEqual(['cantidad_minima', 'fecha_actualizacion', 'id_producto']);
      expect(await db('umbrales_producto').where({ id_producto: 5 }).first()).toEqual(umbral);
    });

    it('un producto solo tiene un umbral (clave primaria): repetirlo choca; otro producto convive', async () => {
      await crearUmbral(db, { idProducto: 5, cantidadMinima: 10 });
      await expect(crearUmbral(db, { idProducto: 5, cantidadMinima: 3 })).rejects.toMatchObject({ code: '23505' });
      await crearUmbral(db, { idProducto: 6, cantidadMinima: 0 });
      expect(await db('umbrales_producto').count({ total: '*' })).toEqual([{ total: 2 }]);
    });
  });

  describe('crearLote', () => {
    it('sin fecha de vencimiento la deja en null', async () => {
      const { id_bodega: idBodega } = await crearBodega(db);
      const lote = await crearLote(db, { idBodega, idProducto: 5, codigoLote: 'L-1', cantidad: 8 });
      expect(lote).toEqual({ id_lote: 1, id_bodega: idBodega, id_producto: 5, codigo_lote: 'L-1', fecha_vencimiento: null, cantidad_disponible: 8 });
    });

    it('guarda la fecha de vencimiento como fecha (sin hora ni zona)', async () => {
      const { id_bodega: idBodega } = await crearBodega(db);
      const lote = await crearLote(db, { idBodega, idProducto: 5, codigoLote: 'L-2', fechaVencimiento: '2026-12-31', cantidad: 8 });
      const { rows } = await db.raw('SELECT fecha_vencimiento::text AS texto FROM lotes WHERE id_lote = ?', [lote.id_lote]);
      expect(rows[0].texto).toBe('2026-12-31');
    });
  });
});

describe('fixtures: cabeceras y dobles', () => {
  describe('headers', () => {
    it('lleva usuario 7 por defecto y cabeceras de texto, sin X-User-Bodega si no hay bodega', () => {
      expect(headers('ADMINISTRADOR')).toEqual({ 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' });
      expect(Object.keys(headers('CONTADOR'))).not.toContain('X-User-Bodega');
    });

    it('con bodega y usuario propios los envía como texto', () => {
      expect(headers('OPERADOR_BODEGA', { idUsuario: 12, idBodega: 3 })).toEqual({
        'X-User-Id': '12', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': '3',
      });
    });

    it('un operador con la bodega 0 o sin ella no se confunden: solo undefined y null se omiten', () => {
      expect(headers('OPERADOR_BODEGA', { idBodega: undefined })).not.toHaveProperty('X-User-Bodega');
      expect(headers('OPERADOR_BODEGA', { idBodega: null })).not.toHaveProperty('X-User-Bodega');
      expect(headers('OPERADOR_BODEGA', { idBodega: 0 })).toHaveProperty('X-User-Bodega', '0');
    });
  });

  describe('fakeCatalogo', () => {
    it('devuelve el producto, y null para el 999 (el inexistente por defecto)', async () => {
      const catalogo = fakeCatalogo();
      expect(await catalogo.obtenerProducto(5)).toEqual({ id_producto: 5, codigo: 'P5', nombre: 'Producto 5' });
      expect(await catalogo.obtenerProducto(999)).toBeNull();
    });

    it('acepta el id como texto y una lista propia de inexistentes (que reemplaza a la de por defecto)', async () => {
      const catalogo = fakeCatalogo({ inexistentes: [3, 4] });
      expect(await catalogo.obtenerProducto('3')).toBeNull();
      expect(await catalogo.obtenerProducto(4)).toBeNull();
      expect(await catalogo.obtenerProducto(999)).toMatchObject({ id_producto: 999 });
    });

    it('caído lanza un AppError 503 SERVICIO_NO_DISPONIBLE (el manejador de errores no lo convierte en 500)', async () => {
      const error = await fakeCatalogo({ caido: true }).obtenerProducto(5).catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
    });

    it('registra las llamadas para poder afirmar que no se consultó', async () => {
      const catalogo = fakeCatalogo();
      expect(catalogo.obtenerProducto).not.toHaveBeenCalled();
      await catalogo.obtenerProducto(5, { 'X-Request-Id': 'r1' });
      expect(catalogo.obtenerProducto).toHaveBeenCalledWith(5, { 'X-Request-Id': 'r1' });
    });
  });

  describe('fakeNotificaciones', () => {
    it('notificarStockBajo es un doble que se resuelve sin valor y recuerda sus llamadas', async () => {
      const notificaciones = fakeNotificaciones();
      expect(notificaciones.notificarStockBajo).not.toHaveBeenCalled();
      const aviso = { idProducto: 1, idBodega: 2, cantidadTotal: 3, cantidadMinima: 5 };
      await expect(notificaciones.notificarStockBajo(aviso, {})).resolves.toBeUndefined();
      expect(notificaciones.notificarStockBajo).toHaveBeenCalledWith(aviso, {});
    });

    it('cada llamada devuelve un doble nuevo: no se arrastran llamadas de una prueba a otra', async () => {
      const una = fakeNotificaciones();
      await una.notificarStockBajo({}, {});
      expect(fakeNotificaciones().notificarStockBajo).not.toHaveBeenCalled();
    });
  });
});

describe('buildTestApp: clientes falsos por defecto', () => {
  const abiertas = [];
  const construir = (opciones) => {
    const construida = buildTestApp(opciones);
    abiertas.push(construida.db);
    return construida;
  };
  afterAll(() => Promise.all(abiertas.map((conexion) => conexion.destroy())));

  it('sin clientes usa fakeCatalogo y fakeNotificaciones', async () => {
    const { clients } = construir();
    expect(await clients.catalogo.obtenerProducto(5)).toMatchObject({ id_producto: 5 });
    expect(await clients.catalogo.obtenerProducto(999)).toBeNull();
    await expect(clients.notificaciones.notificarStockBajo({}, {})).resolves.toBeUndefined();
    expect(jest.isMockFunction(clients.catalogo.obtenerProducto)).toBe(true);
    expect(jest.isMockFunction(clients.notificaciones.notificarStockBajo)).toBe(true);
  });

  it('cada app lleva sus propios dobles', async () => {
    const una = construir();
    const otra = construir();
    await una.clients.catalogo.obtenerProducto(5);
    expect(otra.clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
    expect(otra.clients.catalogo).not.toBe(una.clients.catalogo);
  });

  it('un cliente pasado reemplaza solo a su par: el otro conserva el doble por defecto', () => {
    const catalogo = fakeCatalogo({ caido: true });
    const { clients } = construir({ clients: { catalogo } });
    expect(clients.catalogo).toBe(catalogo);
    expect(jest.isMockFunction(clients.notificaciones.notificarStockBajo)).toBe(true);
  });

  it('la app sigue atendiendo /health con esos clientes', async () => {
    const { request } = construir();
    const respuesta = await request.get('/health');
    expect(respuesta.status).toBe(200);
  });
});
