const { createDb } = require('../src/config/db');
const { configDePrueba, createTestDb, prepararBaseDePrueba, truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, crearLote } = require('./helpers/fixtures');

const MIGRACION = '20261103000100_esquema_inventario.js';

// Las ocho tablas del modelo de datos de ms-inventario (Entrega 2, Figura 5 + D1 y D5), en orden alfabético.
const TABLAS = ['bodegas', 'conteos', 'detalles_conteo', 'lotes', 'movimientos', 'saldos', 'traslados', 'umbrales_producto'];

const TIPOS_MOVIMIENTO = [
  'ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA',
  'DEVOLUCION_PROVEEDOR', 'TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL',
];

// Estructura exacta: nombre, tipo y nulabilidad de cada columna. Es la interfaz con la que trabajan las Tareas 4 a 13.
const ESTRUCTURA = {
  bodegas: {
    id_bodega: 'integer NOT NULL',
    codigo: 'varchar(30) NOT NULL',
    nombre: 'varchar(100) NOT NULL',
    ciudad: 'varchar(100) NOT NULL',
    direccion: 'varchar(255) NOT NULL',
    activa: 'boolean NOT NULL',
  },
  saldos: {
    id_saldo: 'integer NOT NULL',
    id_producto: 'integer NOT NULL',
    id_bodega: 'integer NOT NULL',
    cantidad_disponible: 'integer NOT NULL',
    fecha_actualizacion: 'timestamptz NOT NULL',
  },
  lotes: {
    id_lote: 'integer NOT NULL',
    id_bodega: 'integer NOT NULL',
    id_producto: 'integer NOT NULL',
    codigo_lote: 'varchar(50) NOT NULL',
    fecha_vencimiento: 'date NULL',
    cantidad_disponible: 'integer NOT NULL',
  },
  traslados: {
    id_traslado: 'integer NOT NULL',
    id_producto: 'integer NOT NULL',
    id_bodega_origen: 'integer NOT NULL',
    id_bodega_destino: 'integer NOT NULL',
    id_lote: 'integer NULL',
    cantidad: 'integer NOT NULL',
    estado: 'varchar(20) NOT NULL',
    fecha_envio: 'timestamptz NOT NULL',
    fecha_recepcion: 'timestamptz NULL',
    id_usuario_envia: 'integer NOT NULL',
    id_usuario_recibe: 'integer NULL',
  },
  conteos: {
    id_conteo: 'integer NOT NULL',
    id_bodega: 'integer NOT NULL',
    estado: 'varchar(20) NOT NULL',
    fecha_programada: 'date NOT NULL',
    fecha_aprobacion: 'timestamptz NULL',
    id_usuario_aprueba: 'integer NULL',
    clave_aprobacion: 'varchar(255) NULL',
  },
  detalles_conteo: {
    id_detalle_conteo: 'integer NOT NULL',
    id_conteo: 'integer NOT NULL',
    id_producto: 'integer NOT NULL',
    cantidad_sistema: 'integer NOT NULL',
    cantidad_contada: 'integer NULL',
    diferencia: 'integer NULL',
  },
  movimientos: {
    id_movimiento: 'integer NOT NULL',
    tipo: 'varchar(30) NOT NULL',
    id_producto: 'integer NOT NULL',
    id_bodega: 'integer NOT NULL',
    id_lote: 'integer NULL',
    id_traslado: 'integer NULL',
    id_conteo: 'integer NULL',
    cantidad: 'integer NOT NULL',
    saldo_resultante: 'integer NOT NULL',
    fecha: 'timestamptz NOT NULL',
    id_usuario: 'integer NOT NULL',
    clave_idempotencia: 'varchar(255) NOT NULL',
    documento_referencia: 'varchar(100) NULL',
    observacion: 'varchar(500) NULL',
  },
  umbrales_producto: {
    id_producto: 'integer NOT NULL',
    cantidad_minima: 'integer NOT NULL',
    fecha_actualizacion: 'timestamptz NOT NULL',
  },
};

// Índices (claves primarias incluidas) con nombre propio y estable. El servicio detecta la repetición de una clave de
// idempotencia por el nombre `movimientos_clave_idempotencia_key` (Tarea 7): no debe cambiar.
const INDICES = {
  bodegas_pkey: 'UNIQUE bodegas(id_bodega)',
  bodegas_codigo_key: 'UNIQUE bodegas(codigo)',
  saldos_pkey: 'UNIQUE saldos(id_saldo)',
  saldos_id_producto_id_bodega_key: 'UNIQUE saldos(id_producto, id_bodega)',
  lotes_pkey: 'UNIQUE lotes(id_lote)',
  lotes_id_bodega_id_producto_codigo_lote_key: 'UNIQUE lotes(id_bodega, id_producto, codigo_lote)',
  traslados_pkey: 'UNIQUE traslados(id_traslado)',
  conteos_pkey: 'UNIQUE conteos(id_conteo)',
  conteos_clave_aprobacion_key: 'UNIQUE conteos(clave_aprobacion)',
  detalles_conteo_pkey: 'UNIQUE detalles_conteo(id_detalle_conteo)',
  detalles_conteo_id_conteo_id_producto_key: 'UNIQUE detalles_conteo(id_conteo, id_producto)',
  movimientos_pkey: 'UNIQUE movimientos(id_movimiento)',
  movimientos_clave_idempotencia_key: 'UNIQUE movimientos(clave_idempotencia)',
  movimientos_id_producto_fecha_idx: 'movimientos(id_producto, fecha DESC)',
  movimientos_id_bodega_fecha_idx: 'movimientos(id_bodega, fecha DESC)',
  umbrales_producto_pkey: 'UNIQUE umbrales_producto(id_producto)',
};

// Las once relaciones del modelo, todas entre tablas propias: id_producto e id_usuario son identificadores sin clave
// foránea (RNF02). Solo las líneas de un conteo se borran en cascada con él.
const CLAVES_FORANEAS = {
  saldos_id_bodega_fkey: 'saldos FOREIGN KEY (id_bodega) REFERENCES bodegas(id_bodega)',
  lotes_id_bodega_fkey: 'lotes FOREIGN KEY (id_bodega) REFERENCES bodegas(id_bodega)',
  traslados_id_bodega_origen_fkey: 'traslados FOREIGN KEY (id_bodega_origen) REFERENCES bodegas(id_bodega)',
  traslados_id_bodega_destino_fkey: 'traslados FOREIGN KEY (id_bodega_destino) REFERENCES bodegas(id_bodega)',
  traslados_id_lote_fkey: 'traslados FOREIGN KEY (id_lote) REFERENCES lotes(id_lote)',
  conteos_id_bodega_fkey: 'conteos FOREIGN KEY (id_bodega) REFERENCES bodegas(id_bodega)',
  detalles_conteo_id_conteo_fkey: 'detalles_conteo FOREIGN KEY (id_conteo) REFERENCES conteos(id_conteo) ON DELETE CASCADE',
  movimientos_id_bodega_fkey: 'movimientos FOREIGN KEY (id_bodega) REFERENCES bodegas(id_bodega)',
  movimientos_id_lote_fkey: 'movimientos FOREIGN KEY (id_lote) REFERENCES lotes(id_lote)',
  movimientos_id_traslado_fkey: 'movimientos FOREIGN KEY (id_traslado) REFERENCES traslados(id_traslado)',
  movimientos_id_conteo_fkey: 'movimientos FOREIGN KEY (id_conteo) REFERENCES conteos(id_conteo)',
};

const BODEGA_INEXISTENTE = 9999;

// Filas mínimas válidas: cada prueba cambia solo el campo que quiere romper.
const filaBodega = (extra = {}) => ({ codigo: 'A', nombre: 'n', ciudad: 'c', direccion: 'd', ...extra });
const filaConteo = (idBodega, extra = {}) => ({ id_bodega: idBodega, estado: 'PROGRAMADO', fecha_programada: '2026-11-20', ...extra });
const filaTraslado = (origen, destino, extra = {}) => ({
  id_producto: 1, id_bodega_origen: origen, id_bodega_destino: destino, cantidad: 3, estado: 'EN_TRANSITO', id_usuario_envia: 7, ...extra,
});
let consecutivo = 0;
const filaMovimiento = (idBodega, extra = {}) => ({
  tipo: 'ENTRADA', id_producto: 1, id_bodega: idBodega, cantidad: 5, saldo_resultante: 5, id_usuario: 7, clave_idempotencia: `clave-${++consecutivo}`, ...extra,
});

const tablasDeDatos = async (db) => {
  const { rows } = await db.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex\\_%' ORDER BY tablename");
  return rows.map((fila) => fila.tablename).sort();
};

describe('esquema de la base de datos (PostgreSQL real)', () => {
  let db;
  beforeAll(() => {
    db = createTestDb();
  });
  beforeEach(() => truncateAll(db));
  afterAll(async () => {
    // Se deja la base vacía para quien corra después.
    await truncateAll(db);
    await db.destroy();
  });

  describe('estructura', () => {
    it('hay exactamente las ocho tablas del modelo (y las de control de Knex)', async () => {
      expect(await tablasDeDatos(db)).toEqual(TABLAS);
    });

    it.each(Object.entries(ESTRUCTURA))('%s: columnas, tipos y nulabilidad exactos', async (tabla, esperado) => {
      const { rows } = await db.raw(
        `SELECT column_name, data_type, character_maximum_length, is_nullable
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`,
        [tabla],
      );
      const real = Object.fromEntries(rows.map((c) => {
        const tipo = { 'character varying': `varchar(${c.character_maximum_length})`, 'timestamp with time zone': 'timestamptz' }[c.data_type] ?? c.data_type;
        return [c.column_name, `${tipo} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`];
      }));
      expect(real).toEqual(esperado);
    });

    it('los índices y claves únicas existen con su nombre exacto, sus columnas y su orden (fecha DESC en el kardex)', async () => {
      const { rows } = await db.raw(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT LIKE 'knex\\_%'",
      );
      const real = Object.fromEntries(rows.map(({ indexname, indexdef }) => {
        const partes = /^CREATE (UNIQUE )?INDEX \S+ ON public\.(\S+) USING btree \((.*)\)$/.exec(indexdef);
        return [indexname, `${partes[1] ? 'UNIQUE ' : ''}${partes[2]}(${partes[3]})`];
      }));
      expect(real).toEqual(INDICES);
    });

    it('las once claves foráneas unen solo tablas propias; únicamente detalles_conteo borra en cascada', async () => {
      const { rows } = await db.raw(
        `SELECT conname, conrelid::regclass::text AS tabla, pg_get_constraintdef(oid) AS definicion
           FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
      );
      const real = Object.fromEntries(rows.map((c) => [c.conname, `${c.tabla} ${c.definicion}`]));
      expect(real).toEqual(CLAVES_FORANEAS);
    });

    it('las claves propias se autogeneran (serial); umbrales_producto usa el id_producto del catálogo y no genera nada', async () => {
      const { rows } = await db.raw(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name NOT LIKE 'knex\\_%' AND column_default LIKE 'nextval(%'
          ORDER BY table_name`,
      );
      expect(rows.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
        'bodegas.id_bodega', 'conteos.id_conteo', 'detalles_conteo.id_detalle_conteo', 'lotes.id_lote',
        'movimientos.id_movimiento', 'saldos.id_saldo', 'traslados.id_traslado',
      ]);
    });
  });

  describe('valores por defecto', () => {
    it('bodega activa; saldo en 0; fechas con la hora del servidor', async () => {
      // Sin pasar por el fixture, que siempre envía `activa`: lo que se prueba es el valor por defecto de la columna.
      const [bodega] = await db('bodegas').insert(filaBodega()).returning('*');
      expect(bodega.activa).toBe(true);

      const [saldo] = await db('saldos').insert({ id_producto: 1, id_bodega: bodega.id_bodega }).returning('*');
      expect(saldo.cantidad_disponible).toBe(0);
      expect(saldo.fecha_actualizacion).toBeInstanceOf(Date);

      const [movimiento] = await db('movimientos').insert(filaMovimiento(bodega.id_bodega)).returning('*');
      expect(movimiento.fecha).toBeInstanceOf(Date);

      const otra = await crearBodega(db, { codigo: 'B2' });
      const [traslado] = await db('traslados').insert(filaTraslado(bodega.id_bodega, otra.id_bodega)).returning('*');
      expect(traslado.fecha_envio).toBeInstanceOf(Date);
      expect(traslado).toMatchObject({ id_lote: null, fecha_recepcion: null, id_usuario_recibe: null });

      const [umbral] = await db('umbrales_producto').insert({ id_producto: 1, cantidad_minima: 5 }).returning('*');
      expect(umbral.fecha_actualizacion).toBeInstanceOf(Date);
    });

    it('las fechas son con zona horaria: se guarda el mismo instante que se envía', async () => {
      const bodega = await crearBodega(db, {});
      const instante = new Date('2026-11-15T03:30:00.000Z');
      const [movimiento] = await db('movimientos').insert(filaMovimiento(bodega.id_bodega, { fecha: instante })).returning('*');
      expect(movimiento.fecha.toISOString()).toBe('2026-11-15T03:30:00.000Z');
    });
  });

  describe('restricciones que rechazan datos', () => {
    const inserta = (tabla, fila) => (conexion) => conexion(tabla).insert(fila);
    const conBodega = (siguiente) => async (conexion) => siguiente(conexion, await crearBodega(conexion, {}));
    const conDosBodegas = (siguiente) => async (conexion) => {
      const origen = await crearBodega(conexion, { codigo: 'O' });
      const destino = await crearBodega(conexion, { codigo: 'D' });
      return siguiente(conexion, origen, destino);
    };

    // 23505 (unicidad), 23514 (CHECK), 23503 (clave foránea) y 23502 (NOT NULL), siempre con el nombre de la restricción.
    it.each([
      // --- unicidad ---
      ['bodegas.codigo repetido', (c) => c('bodegas').insert([filaBodega(), filaBodega()]), '23505', 'bodegas_codigo_key'],
      ['saldo repetido para el mismo producto y bodega', conBodega((c, b) =>
        c('saldos').insert([{ id_producto: 1, id_bodega: b.id_bodega }, { id_producto: 1, id_bodega: b.id_bodega }])), '23505', 'saldos_id_producto_id_bodega_key'],
      ['lote repetido (misma bodega, producto y código)', conBodega((c, b) => {
        const lote = { id_bodega: b.id_bodega, id_producto: 1, codigo_lote: 'L1', cantidad_disponible: 5 };
        return c('lotes').insert([lote, lote]);
      }), '23505', 'lotes_id_bodega_id_producto_codigo_lote_key'],
      ['conteos.clave_aprobacion repetida', conBodega((c, b) =>
        c('conteos').insert([filaConteo(b.id_bodega, { clave_aprobacion: 'k' }), filaConteo(b.id_bodega, { clave_aprobacion: 'k' })])), '23505', 'conteos_clave_aprobacion_key'],
      ['línea repetida del mismo producto en un conteo', conBodega(async (c, b) => {
        const [conteo] = await c('conteos').insert(filaConteo(b.id_bodega)).returning('*');
        const linea = { id_conteo: conteo.id_conteo, id_producto: 1, cantidad_sistema: 4 };
        return c('detalles_conteo').insert([linea, linea]);
      }), '23505', 'detalles_conteo_id_conteo_id_producto_key'],
      ['movimientos.clave_idempotencia repetida', conBodega((c, b) =>
        c('movimientos').insert([filaMovimiento(b.id_bodega, { clave_idempotencia: 'misma' }), filaMovimiento(b.id_bodega, { clave_idempotencia: 'misma' })])), '23505', 'movimientos_clave_idempotencia_key'],
      ['dos umbrales del mismo producto', (c) =>
        c('umbrales_producto').insert([{ id_producto: 1, cantidad_minima: 5 }, { id_producto: 1, cantidad_minima: 6 }]), '23505', 'umbrales_producto_pkey'],

      // --- CHECK ---
      ['saldo negativo', conBodega((c, b) => c('saldos').insert({ id_producto: 1, id_bodega: b.id_bodega, cantidad_disponible: -1 })), '23514', 'saldos_cantidad_no_negativa'],
      ['lote con cantidad negativa', conBodega((c, b) =>
        c('lotes').insert({ id_bodega: b.id_bodega, id_producto: 1, codigo_lote: 'L1', cantidad_disponible: -1 })), '23514', 'lotes_cantidad_no_negativa'],
      ['traslado a la misma bodega', conBodega((c, b) => c('traslados').insert(filaTraslado(b.id_bodega, b.id_bodega))), '23514', 'traslados_bodegas_distintas'],
      ['traslado con cantidad 0', conDosBodegas((c, o, d) => c('traslados').insert(filaTraslado(o.id_bodega, d.id_bodega, { cantidad: 0 }))), '23514', 'traslados_cantidad_positiva'],
      ['traslado con cantidad negativa', conDosBodegas((c, o, d) => c('traslados').insert(filaTraslado(o.id_bodega, d.id_bodega, { cantidad: -2 }))), '23514', 'traslados_cantidad_positiva'],
      ['traslado con estado fuera de la lista', conDosBodegas((c, o, d) => c('traslados').insert(filaTraslado(o.id_bodega, d.id_bodega, { estado: 'PERDIDO' }))), '23514', 'traslados_estado_valido'],
      ['conteo con estado fuera de la lista', conBodega((c, b) => c('conteos').insert(filaConteo(b.id_bodega, { estado: 'CERRADO' }))), '23514', 'conteos_estado_valido'],
      ['movimiento con tipo fuera de la lista', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { tipo: 'VENTA' }))), '23514', 'movimientos_tipo_valido'],
      ['AJUSTE con cantidad 0', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { tipo: 'AJUSTE', cantidad: 0 }))), '23514', 'movimientos_cantidad_no_cero'],
      ['movimiento con saldo resultante negativo', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { saldo_resultante: -1 }))), '23514', 'movimientos_saldo_resultante_no_negativo'],
      ['AJUSTE con saldo resultante negativo', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { tipo: 'AJUSTE', cantidad: -3, saldo_resultante: -5 }))), '23514', 'movimientos_saldo_resultante_no_negativo'],
      ['umbral negativo', inserta('umbrales_producto', { id_producto: 1, cantidad_minima: -1 }), '23514', 'umbrales_producto_cantidad_minima_no_negativa'],

      // --- claves foráneas propias (una bodega, un lote, un traslado o un conteo que no existen) ---
      ['saldo de una bodega inexistente', inserta('saldos', { id_producto: 1, id_bodega: BODEGA_INEXISTENTE }), '23503', 'saldos_id_bodega_fkey'],
      ['lote de una bodega inexistente', inserta('lotes', { id_bodega: BODEGA_INEXISTENTE, id_producto: 1, codigo_lote: 'L1', cantidad_disponible: 1 }), '23503', 'lotes_id_bodega_fkey'],
      ['traslado desde una bodega inexistente', conBodega((c, b) => c('traslados').insert(filaTraslado(BODEGA_INEXISTENTE, b.id_bodega))), '23503', 'traslados_id_bodega_origen_fkey'],
      ['traslado hacia una bodega inexistente', conBodega((c, b) => c('traslados').insert(filaTraslado(b.id_bodega, BODEGA_INEXISTENTE))), '23503', 'traslados_id_bodega_destino_fkey'],
      ['traslado de un lote inexistente', conDosBodegas((c, o, d) => c('traslados').insert(filaTraslado(o.id_bodega, d.id_bodega, { id_lote: 9999 }))), '23503', 'traslados_id_lote_fkey'],
      ['conteo de una bodega inexistente', inserta('conteos', filaConteo(BODEGA_INEXISTENTE)), '23503', 'conteos_id_bodega_fkey'],
      ['línea de un conteo inexistente', inserta('detalles_conteo', { id_conteo: 9999, id_producto: 1, cantidad_sistema: 1 }), '23503', 'detalles_conteo_id_conteo_fkey'],
      ['movimiento de una bodega inexistente', inserta('movimientos', filaMovimiento(BODEGA_INEXISTENTE)), '23503', 'movimientos_id_bodega_fkey'],
      ['movimiento de un lote inexistente', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { id_lote: 9999 }))), '23503', 'movimientos_id_lote_fkey'],
      ['movimiento de un traslado inexistente', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { id_traslado: 9999 }))), '23503', 'movimientos_id_traslado_fkey'],
      ['movimiento de un conteo inexistente', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { id_conteo: 9999 }))), '23503', 'movimientos_id_conteo_fkey'],

      // --- NOT NULL en lo que el servicio nunca debe dejar en blanco ---
      ['movimiento sin clave de idempotencia', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { clave_idempotencia: null }))), '23502', undefined],
      ['movimiento sin usuario', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { id_usuario: null }))), '23502', undefined],
      ['movimiento sin saldo resultante', conBodega((c, b) => c('movimientos').insert(filaMovimiento(b.id_bodega, { saldo_resultante: null }))), '23502', undefined],
      ['lote sin cantidad', conBodega((c, b) => c('lotes').insert({ id_bodega: b.id_bodega, id_producto: 1, codigo_lote: 'L1' })), '23502', undefined],
      ['bodega sin código', (c) => c('bodegas').insert(filaBodega({ codigo: null })), '23502', undefined],
    ])('rechaza %s', async (_nombre, insertar, codigo, restriccion) => {
      const esperado = { code: codigo };
      if (restriccion) esperado.constraint = restriccion;
      await expect(insertar(db)).rejects.toMatchObject(esperado);
    });

    it('un texto más largo que la columna se rechaza (22001) en vez de truncarse', async () => {
      await expect(db('bodegas').insert(filaBodega({ codigo: 'x'.repeat(31) }))).rejects.toMatchObject({ code: '22001' });
      const [bodega] = await db('bodegas').insert(filaBodega({ codigo: 'x'.repeat(30) })).returning('*');
      expect(bodega.codigo).toHaveLength(30);
    });

    it('rechazar una fila no deja nada escrito (la inserción es atómica)', async () => {
      await crearBodega(db, { codigo: 'A' });
      await expect(db('bodegas').insert([filaBodega({ codigo: 'Z' }), filaBodega({ codigo: 'A' })])).rejects.toMatchObject({ code: '23505' });
      expect((await db('bodegas').where({ codigo: 'Z' })).length).toBe(0);
    });
  });

  describe('lo que el esquema sí permite', () => {
    it('el mismo código de lote en otra bodega o para otro producto', async () => {
      const b1 = await crearBodega(db, { codigo: 'B1' });
      const b2 = await crearBodega(db, { codigo: 'B2' });
      await crearLote(db, { idBodega: b1.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 5 });
      await crearLote(db, { idBodega: b2.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 5 });
      await crearLote(db, { idBodega: b1.id_bodega, idProducto: 2, codigoLote: 'L1', cantidad: 5 });
      expect(await db('lotes').count({ n: '*' }).first()).toEqual({ n: 3 });
    });

    it('el mismo producto en bodegas distintas, y el mismo saldo de otro producto en la misma bodega', async () => {
      const b1 = await crearBodega(db, { codigo: 'B1' });
      const b2 = await crearBodega(db, { codigo: 'B2' });
      await crearSaldo(db, { idProducto: 1, idBodega: b1.id_bodega, cantidad: 3 });
      await crearSaldo(db, { idProducto: 1, idBodega: b2.id_bodega, cantidad: 3 });
      await crearSaldo(db, { idProducto: 2, idBodega: b1.id_bodega, cantidad: 3 });
      expect(await db('saldos').count({ n: '*' }).first()).toEqual({ n: 3 });
    });

    it('saldo y lote en cero (el límite del CHECK)', async () => {
      const bodega = await crearBodega(db, {});
      expect((await crearSaldo(db, { idProducto: 1, idBodega: bodega.id_bodega, cantidad: 0 })).cantidad_disponible).toBe(0);
      const lote = await crearLote(db, { idBodega: bodega.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 0 });
      expect(lote.cantidad_disponible).toBe(0);
    });

    it.each(TIPOS_MOVIMIENTO)('movimiento de tipo %s', async (tipo) => {
      const bodega = await crearBodega(db, {});
      const [movimiento] = await db('movimientos').insert(filaMovimiento(bodega.id_bodega, { tipo })).returning('*');
      expect(movimiento.tipo).toBe(tipo);
    });

    it.each([0, 1, 5, 250])('movimiento con saldo resultante %i (el límite del CHECK es 0)', async (saldoResultante) => {
      const bodega = await crearBodega(db, {});
      const [movimiento] = await db('movimientos').insert(filaMovimiento(bodega.id_bodega, { saldo_resultante: saldoResultante })).returning('*');
      expect(movimiento.saldo_resultante).toBe(saldoResultante);
    });

    it.each([1, -1, 3, -3, 250, -250])('movimiento con cantidad %i (un AJUSTE puede restar)', async (cantidad) => {
      const bodega = await crearBodega(db, {});
      const [movimiento] = await db('movimientos').insert(filaMovimiento(bodega.id_bodega, { tipo: 'AJUSTE', cantidad })).returning('*');
      expect(movimiento.cantidad).toBe(cantidad);
    });

    it.each(['EN_TRANSITO', 'RECIBIDO'])('traslado %s, con lote y con sus datos de recepción', async (estado) => {
      const origen = await crearBodega(db, { codigo: 'O' });
      const destino = await crearBodega(db, { codigo: 'D' });
      const lote = await crearLote(db, { idBodega: origen.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 9 });
      const [traslado] = await db('traslados')
        .insert(filaTraslado(origen.id_bodega, destino.id_bodega, { estado, id_lote: lote.id_lote, fecha_recepcion: new Date(), id_usuario_recibe: 8 }))
        .returning('*');
      expect(traslado).toMatchObject({ estado, id_lote: lote.id_lote, id_usuario_recibe: 8 });
    });

    it.each(['PROGRAMADO', 'EN_REVISION', 'APROBADO'])('conteo %s', async (estado) => {
      const bodega = await crearBodega(db, {});
      const [conteo] = await db('conteos').insert(filaConteo(bodega.id_bodega, { estado })).returning('*');
      expect(conteo).toMatchObject({ estado, fecha_aprobacion: null, id_usuario_aprueba: null, clave_aprobacion: null });
    });

    it('varios conteos sin clave de aprobación (NULL no choca con la unicidad)', async () => {
      const bodega = await crearBodega(db, {});
      await db('conteos').insert([filaConteo(bodega.id_bodega), filaConteo(bodega.id_bodega), filaConteo(bodega.id_bodega)]);
      expect(await db('conteos').count({ n: '*' }).first()).toEqual({ n: 3 });
    });

    it('un traslado genera dos movimientos (salida y entrada) y un conteo genera varios ajustes', async () => {
      const origen = await crearBodega(db, { codigo: 'O' });
      const destino = await crearBodega(db, { codigo: 'D' });
      const [traslado] = await db('traslados').insert(filaTraslado(origen.id_bodega, destino.id_bodega)).returning('*');
      await db('movimientos').insert([
        filaMovimiento(origen.id_bodega, { tipo: 'TRASLADO_SALIDA', cantidad: 3, id_traslado: traslado.id_traslado }),
        filaMovimiento(destino.id_bodega, { tipo: 'TRASLADO_ENTRADA', cantidad: 3, id_traslado: traslado.id_traslado }),
      ]);
      const [conteo] = await db('conteos').insert(filaConteo(origen.id_bodega)).returning('*');
      await db('movimientos').insert([
        filaMovimiento(origen.id_bodega, { tipo: 'AJUSTE', cantidad: -1, id_conteo: conteo.id_conteo }),
        filaMovimiento(origen.id_bodega, { tipo: 'AJUSTE', cantidad: 2, id_conteo: conteo.id_conteo }),
      ]);
      expect(await db('movimientos').where({ id_traslado: traslado.id_traslado }).count({ n: '*' }).first()).toEqual({ n: 2 });
      expect(await db('movimientos').where({ id_conteo: conteo.id_conteo }).count({ n: '*' }).first()).toEqual({ n: 2 });
    });
  });

  describe('signo de la cantidad en el kardex (D3)', () => {
    // Solo AJUSTE lleva cantidad con signo; en los demás tipos el signo lo pone el tipo (suma o resta), nunca la cantidad.
    const SIN_SIGNO = TIPOS_MOVIMIENTO.filter((tipo) => tipo !== 'AJUSTE');

    it('control positivo: AJUSTE con -3 y con +3, y cualquier otro tipo con +3, se insertan', async () => {
      const bodega = await crearBodega(db, {});
      const filas = [
        filaMovimiento(bodega.id_bodega, { tipo: 'AJUSTE', cantidad: -3 }),
        filaMovimiento(bodega.id_bodega, { tipo: 'AJUSTE', cantidad: 3 }),
        ...SIN_SIGNO.map((tipo) => filaMovimiento(bodega.id_bodega, { tipo, cantidad: 3 })),
      ];
      const guardadas = await db('movimientos').insert(filas).returning(['tipo', 'cantidad']);
      expect(guardadas).toHaveLength(filas.length);
      expect(guardadas.filter((m) => m.cantidad < 0)).toEqual([{ tipo: 'AJUSTE', cantidad: -3 }]);
    });

    it.each(SIN_SIGNO)('%s con cantidad -1 se rechaza: solo AJUSTE lleva signo', async (tipo) => {
      const bodega = await crearBodega(db, {});
      await expect(db('movimientos').insert(filaMovimiento(bodega.id_bodega, { tipo, cantidad: -1 }))).rejects.toMatchObject({
        code: '23514',
        constraint: 'movimientos_cantidad_con_signo_solo_ajuste',
      });
      expect(await db('movimientos').count({ n: '*' }).first()).toEqual({ n: 0 });
    });

    it.each(TIPOS_MOVIMIENTO)('%s con cantidad 0 se rechaza (por <> 0 o por el signo, según el tipo)', async (tipo) => {
      const bodega = await crearBodega(db, {});
      const error = await db('movimientos').insert(filaMovimiento(bodega.id_bodega, { tipo, cantidad: 0 })).then(() => null, (e) => e);
      expect(error).toMatchObject({ code: '23514' });
      // PostgreSQL revisa los CHECK por orden alfabético: en un tipo sin signo salta primero el del signo.
      expect(error.constraint).toBe(tipo === 'AJUSTE' ? 'movimientos_cantidad_no_cero' : 'movimientos_cantidad_con_signo_solo_ajuste');
    });
  });

  describe('integridad referencial', () => {
    it('borrar un conteo borra sus líneas (ON DELETE CASCADE) y deja intactas las de otro conteo', async () => {
      const bodega = await crearBodega(db, {});
      const [uno, dos] = await db('conteos').insert([filaConteo(bodega.id_bodega), filaConteo(bodega.id_bodega)]).returning('*');
      await db('detalles_conteo').insert([
        { id_conteo: uno.id_conteo, id_producto: 1, cantidad_sistema: 4 },
        { id_conteo: uno.id_conteo, id_producto: 2, cantidad_sistema: 6 },
        { id_conteo: dos.id_conteo, id_producto: 1, cantidad_sistema: 9 },
      ]);

      await db('conteos').where({ id_conteo: uno.id_conteo }).del();

      const restantes = await db('detalles_conteo').select('id_conteo', 'id_producto');
      expect(restantes).toEqual([{ id_conteo: dos.id_conteo, id_producto: 1 }]);
    });

    it.each([
      ['una bodega con saldos', async (c, b) => { await crearSaldo(c, { idProducto: 1, idBodega: b.id_bodega, cantidad: 1 }); return c('bodegas').where({ id_bodega: b.id_bodega }).del(); }],
      ['una bodega con lotes', async (c, b) => { await crearLote(c, { idBodega: b.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 1 }); return c('bodegas').where({ id_bodega: b.id_bodega }).del(); }],
      ['una bodega con movimientos', async (c, b) => { await c('movimientos').insert(filaMovimiento(b.id_bodega)); return c('bodegas').where({ id_bodega: b.id_bodega }).del(); }],
      ['una bodega con conteos', async (c, b) => { await c('conteos').insert(filaConteo(b.id_bodega)); return c('bodegas').where({ id_bodega: b.id_bodega }).del(); }],
      ['un lote usado por un movimiento', async (c, b) => {
        const lote = await crearLote(c, { idBodega: b.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 1 });
        await c('movimientos').insert(filaMovimiento(b.id_bodega, { id_lote: lote.id_lote }));
        return c('lotes').where({ id_lote: lote.id_lote }).del();
      }],
      ['un traslado con movimientos', async (c, b) => {
        const destino = await crearBodega(c, { codigo: 'D' });
        const [traslado] = await c('traslados').insert(filaTraslado(b.id_bodega, destino.id_bodega)).returning('*');
        await c('movimientos').insert(filaMovimiento(b.id_bodega, { id_traslado: traslado.id_traslado }));
        return c('traslados').where({ id_traslado: traslado.id_traslado }).del();
      }],
      ['un conteo con movimientos', async (c, b) => {
        const [conteo] = await c('conteos').insert(filaConteo(b.id_bodega)).returning('*');
        await c('movimientos').insert(filaMovimiento(b.id_bodega, { id_conteo: conteo.id_conteo }));
        return c('conteos').where({ id_conteo: conteo.id_conteo }).del();
      }],
    ])('no se puede borrar %s: lo que tiene historia se da de baja', async (_nombre, borrar) => {
      const bodega = await crearBodega(db, {});
      await expect(borrar(db, bodega)).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('truncateAll', () => {
    it('vacía las ocho tablas con datos enlazados, reinicia las identidades y conserva el registro de migraciones', async () => {
      const origen = await crearBodega(db, { codigo: 'O' });
      const destino = await crearBodega(db, { codigo: 'D' });
      await crearSaldo(db, { idProducto: 1, idBodega: origen.id_bodega, cantidad: 4 });
      const lote = await crearLote(db, { idBodega: origen.id_bodega, idProducto: 1, codigoLote: 'L1', cantidad: 4 });
      const [traslado] = await db('traslados').insert(filaTraslado(origen.id_bodega, destino.id_bodega, { id_lote: lote.id_lote })).returning('*');
      const [conteo] = await db('conteos').insert(filaConteo(origen.id_bodega)).returning('*');
      await db('detalles_conteo').insert({ id_conteo: conteo.id_conteo, id_producto: 1, cantidad_sistema: 4 });
      await db('movimientos').insert(filaMovimiento(origen.id_bodega, { id_lote: lote.id_lote, id_traslado: traslado.id_traslado, id_conteo: conteo.id_conteo }));
      await db('umbrales_producto').insert({ id_producto: 1, cantidad_minima: 2 });
      for (const tabla of TABLAS) {
        expect((await db(tabla).count({ n: '*' }).first()).n).toBeGreaterThan(0);
      }

      await truncateAll(db);

      for (const tabla of TABLAS) {
        expect({ tabla, filas: (await db(tabla).count({ n: '*' }).first()).n }).toEqual({ tabla, filas: 0 });
      }
      expect((await crearBodega(db, {})).id_bodega).toBe(1);
      const migraciones = await db('knex_migrations').pluck('name');
      expect(migraciones).toContain(MIGRACION);
    });
  });

  describe('migración', () => {
    const BASE_TEMPORAL = 'inventario_migracion_test';
    const entorno = () => ({ ...process.env, TEST_DB_NAME: BASE_TEMPORAL });
    const eliminarBaseTemporal = async () => {
      const admin = createDb({ ...configDePrueba(entorno()), database: 'postgres' });
      try {
        await admin.raw('DROP DATABASE IF EXISTS ?? WITH (FORCE)', [BASE_TEMPORAL]);
      } finally {
        await admin.destroy();
      }
    };
    beforeAll(eliminarBaseTemporal);
    afterAll(eliminarBaseTemporal);

    // Se hace en una base propia: deshacer la migración en inventario_test dejaría sin tablas a las demás suites.
    it('sobre una base vacía crea las ocho tablas; deshacerla las quita todas; volver a aplicarla funciona; repetir `latest` no hace nada', async () => {
      await prepararBaseDePrueba(entorno());
      const temporal = createTestDb(entorno());
      try {
        expect(await tablasDeDatos(temporal)).toEqual(TABLAS);
        expect((await temporal.migrate.list())[0].map((m) => m.name ?? m.file)).toContain(MIGRACION);

        await temporal.migrate.rollback(undefined, true);
        expect(await tablasDeDatos(temporal)).toEqual([]);

        const [, aplicadas] = await temporal.migrate.latest();
        expect(aplicadas).toEqual([MIGRACION]);
        expect(await tablasDeDatos(temporal)).toEqual(TABLAS);

        const [, repetidas] = await temporal.migrate.latest();
        expect(repetidas).toEqual([]);
        expect(await tablasDeDatos(temporal)).toEqual(TABLAS);
        const [, pendientes] = await temporal.migrate.list();
        expect(pendientes).toEqual([]);
      } finally {
        await temporal.destroy();
      }
    });

    it('tras deshacer y volver a aplicar, el esquema es el mismo (índices y claves foráneas incluidos)', async () => {
      const temporal = createTestDb(entorno());
      try {
        const huella = async () => {
          const { rows } = await temporal.raw(
            `SELECT 'columna' AS clase, table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS valor
               FROM information_schema.columns WHERE table_schema = 'public'
             UNION ALL SELECT 'indice', indexdef FROM pg_indexes WHERE schemaname = 'public'
             UNION ALL SELECT 'restriccion', conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
               FROM pg_constraint WHERE connamespace = 'public'::regnamespace
             ORDER BY 1, 2`,
          );
          return rows.map((fila) => `${fila.clase}: ${fila.valor}`);
        };
        const antes = await huella();
        await temporal.migrate.rollback(undefined, true);
        await temporal.migrate.latest();
        const despues = await huella();
        expect(antes.length).toBeGreaterThan(50);
        expect(despues).toEqual(antes);
      } finally {
        await temporal.destroy();
      }
    });
  });
});
