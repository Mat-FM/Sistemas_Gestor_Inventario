const { createDb } = require('../src/config/db');
const { configDePrueba, createTestDb, prepararBaseDePrueba, truncateAll } = require('./helpers/db');

describe('base de pruebas real (PostgreSQL)', () => {
  let db;
  beforeAll(() => {
    db = createTestDb();
  });
  afterAll(() => db.destroy());

  it('globalSetup dejó lista la base de pruebas: es otra base distinta de DB_NAME y termina en _test', async () => {
    const { rows } = await db.raw('SELECT current_database() AS nombre');
    expect(rows[0].nombre).toMatch(/_test$/);
    expect(rows[0].nombre).not.toBe(process.env.DB_NAME);
  });

  it('globalSetup aplicó las migraciones: existen las tablas de control de Knex', async () => {
    const { rows } = await db.raw("SELECT to_regclass('public.knex_migrations')::text AS tabla");
    expect(rows[0].tabla).toBe('knex_migrations');
  });

  it('COUNT y SUM llegan como número, no como texto (parser de bigint)', async () => {
    const { rows } = await db.raw('SELECT COUNT(*) AS total, SUM(g) AS suma FROM generate_series(1, 4) AS g');
    expect(rows[0]).toEqual({ total: 4, suma: 10 });
    expect(typeof rows[0].total).toBe('number');
  });

  describe('columnas date como texto YYYY-MM-DD (Ruling 15)', () => {
    // Sin el parser, `pg` crea un Date a medianoche LOCAL y JSON.stringify lo pasa a UTC: en un huso adelantado a UTC la fecha
    // retrocede un día. Se prueba en procesos hijos con el huso fijado, para no depender del de la máquina que corre la suite.
    const path = require('node:path');
    const { ejecutarHijo } = require('./helpers/hijos');
    const HIJO = `
      const pg = require('pg');
      const { createTestDb } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'db.js'))});
      (async () => {
        const db = createTestDb();
        try {
          const { rows: [fila] } = await db.raw("SELECT '2027-01-31'::date AS vence, '2026-12-31'::date AS fin_de_anio, NULL::date AS nula");
          process.stdout.write(JSON.stringify({
            tipo: typeof fila.vence,
            json: JSON.stringify(fila),
            desfase: new Date(2027, 0, 31).getTimezoneOffset(),
            parser: pg.types.getTypeParser(1082)('2027-01-31'),
          }));
        } finally {
          await db.destroy();
        }
      })().catch((error) => { process.stderr.write(String(error && error.stack)); process.exit(1); });
    `;
    // Con plazo propio (ejecutarHijo): si la base no responde, el hijo muere a los 20 s y la prueba falla con un mensaje claro.
    const enHuso = async (tz) => JSON.parse((await ejecutarHijo(['-e', HIJO], { env: { ...process.env, TZ: tz }, cwd: path.join(__dirname, '..') })).stdout);

    it('una columna date llega como el texto exacto de la base, no como Date (y null sigue siendo null)', async () => {
      const { rows: [fila] } = await db.raw("SELECT '2027-01-31'::date AS vence, NULL::date AS nula");
      expect(fila).toEqual({ vence: '2027-01-31', nula: null });
    });

    it('timestamptz NO cambia: sigue llegando como Date (el parser solo toca date, OID 1082)', async () => {
      const { rows: [fila] } = await db.raw('SELECT now() AS ahora');
      expect(fila.ahora).toBeInstanceOf(Date);
    });

    it.each([
      ['America/Bogota', 300],
      ['Pacific/Auckland', -780],
    ])('con TZ=%s la fecha sobrevive a JSON.stringify sin desplazarse un día', async (tz, desfase) => {
      const resultado = await enHuso(tz);
      expect(resultado.desfase).toBe(desfase); // control: el huso del hijo es de verdad el pedido
      expect(resultado).toEqual({
        tipo: 'string', json: '{"vence":"2027-01-31","fin_de_anio":"2026-12-31","nula":null}', desfase, parser: '2027-01-31',
      });
    });

    it('el parser es el del `pg` que usa Knex: config/db.js lo registra para las conexiones de pruebas y de producción', () => {
      // createDb (lo usan src/server.js, knexfile.js y el arnés) carga config/db.js, que registra el parser en `pg.types`, que es
      // global al módulo `pg`. Knex debe resolver ESE mismo módulo `pg`; si tuviera su propia copia, el parser no le llegaría.
      const pg = require('pg');
      const pgDeKnex = require.resolve('pg', { paths: [path.dirname(require.resolve('knex'))] });
      expect(pgDeKnex).toBe(require.resolve('pg'));
      expect(pg.types.getTypeParser(1082)('2027-01-31')).toBe('2027-01-31');
    });
  });

  describe('createTestDb con zonaHoraria (D29: el huso de la sesión no debe cambiar una consulta)', () => {
    const zonaDe = async (conexion) => (await conexion.raw('SHOW TimeZone')).rows[0].TimeZone;
    // La zona con la que nace una sesión NUEVA que no pide ninguna: la del servidor (postgresql.conf) o la de la base
    // (ALTER DATABASE … SET timezone). NO se supone: es UTC en el contenedor y puede ser America/Bogota en un PostgreSQL local.
    const zonaPorDefecto = async (conexion) => (await conexion.raw("SELECT reset_val FROM pg_settings WHERE name = 'TimeZone'")).rows[0].reset_val;
    const CANDIDATAS = ['America/Bogota', 'Pacific/Auckland', 'Pacific/Kiritimati'];

    it.each(['America/Bogota', 'Pacific/Auckland', 'UTC'])('cada conexión del pool nace con TimeZone = %s, sea cual sea la zona por defecto del servidor', async (zona) => {
      const conZona = createTestDb(process.env, { zonaHoraria: zona });
      try {
        expect(await zonaDe(conZona)).toBe(zona);
        // Una segunda conexión simultánea (otra del pool) también la lleva.
        const trxs = await Promise.all([conZona.transaction(), conZona.transaction()]);
        try {
          expect(await Promise.all(trxs.map(zonaDe))).toEqual([zona, zona]);
        } finally {
          await Promise.all(trxs.map((trx) => trx.rollback()));
        }
      } finally {
        await conZona.destroy();
      }
    });

    it('sin zonaHoraria la sesión conserva la zona por defecto del servidor, y pedir otra zona SÍ la cambia (la de contraste se elige distinta de la por defecto)', async () => {
      const sinZona = createTestDb();
      try {
        const porDefecto = await zonaPorDefecto(sinZona);
        expect(await zonaDe(sinZona)).toBe(porDefecto);
        // Como máximo una de las tres candidatas coincide con la por defecto: siempre quedan al menos dos de contraste.
        const contraste = CANDIDATAS.filter((zona) => zona !== porDefecto);
        expect(contraste.length).toBeGreaterThanOrEqual(2);
        for (const zona of contraste) {
          const conZona = createTestDb(process.env, { zonaHoraria: zona });
          try {
            expect({ pedida: zona, sesion: await zonaDe(conZona) }).toEqual({ pedida: zona, sesion: zona });
            expect(await zonaDe(conZona)).not.toBe(porDefecto);
            expect(await zonaDe(sinZona)).toBe(porDefecto); // pedir una zona en un pool no cambia la de los demás
          } finally {
            await conZona.destroy();
          }
        }
      } finally {
        await sinZona.destroy();
      }
    });
  });

  describe('esperarBloqueo (helpers/bloqueos.js)', () => {
    const { esperarBloqueo } = require('./helpers/bloqueos');

    it('detecta una sesión que espera un candado y, sin ninguna, falla con un mensaje claro en su plazo', async () => {
      /* Control positivo: A bloquea una fila con FOR UPDATE y B espera esa fila → esperarBloqueo la ve. Después, sin esperas, falla. */
      await db.raw('CREATE TABLE IF NOT EXISTS prueba_bloqueo (id INTEGER PRIMARY KEY)');
      await db.raw('INSERT INTO prueba_bloqueo (id) VALUES (1) ON CONFLICT DO NOTHING');
      const a = await db.transaction();
      let b;
      try {
        await a.raw('SELECT * FROM prueba_bloqueo WHERE id = 1 FOR UPDATE');
        b = db.transaction((trx) => trx.raw('SELECT * FROM prueba_bloqueo WHERE id = 1 FOR UPDATE'));
        expect(await esperarBloqueo(db)).toBeGreaterThanOrEqual(1);
      } finally {
        await a.rollback();
        await b;
        await db.raw('DROP TABLE prueba_bloqueo');
      }
      await expect(esperarBloqueo(db, { plazoMs: 100 })).rejects.toThrow(/esperarBloqueo: en 100 ms nunca hubo 1 sesión\(es\) esperando un candado \(había 0\)/);
    });
  });

  describe('truncateAll', () => {
    // Todo ocurre dentro de una transacción que se revierte: no queda ni una tabla ni una fila de prueba.
    const REVERTIR = new Error('revertir');
    const enTransaccionRevertida = async (prueba) => {
      await expect(db.transaction(async (trx) => { await prueba(trx); throw REVERTIR; })).rejects.toBe(REVERTIR);
    };

    it('vacía las tablas de datos, reinicia sus secuencias y no toca las tablas de control de Knex', () =>
      enTransaccionRevertida(async (trx) => {
        await trx.raw('CREATE TABLE prueba_truncar (id SERIAL PRIMARY KEY, valor INTEGER)');
        await trx.raw('INSERT INTO prueba_truncar (valor) VALUES (1), (2)');
        await trx.raw("INSERT INTO knex_migrations (name, batch, migration_time) VALUES ('centinela.js', 999, now())");

        await truncateAll(trx);

        expect((await trx.raw('SELECT COUNT(*) AS n FROM prueba_truncar')).rows[0].n).toBe(0);
        const [{ id }] = (await trx.raw('INSERT INTO prueba_truncar (valor) VALUES (3) RETURNING id')).rows;
        expect(id).toBe(1);
        expect((await trx.raw("SELECT COUNT(*) AS n FROM knex_migrations WHERE name = 'centinela.js'")).rows[0].n).toBe(1);
      }));

    it('se niega a vaciar una base que no termina en _test y no emite ningún TRUNCATE', async () => {
      const raw = jest.fn().mockResolvedValue({ rows: [{ nombre: 'inventario_db' }] });
      await expect(truncateAll({ raw })).rejects.toThrow(/se niega a vaciar la base "inventario_db"/);
      expect(raw).toHaveBeenCalledTimes(1);
    });

    it('no hace nada si no hay tablas de datos', async () => {
      const raw = jest.fn().mockResolvedValueOnce({ rows: [{ nombre: 'inventario_test' }] }).mockResolvedValueOnce({ rows: [] });
      await truncateAll({ raw });
      expect(raw.mock.calls.every(([sql]) => !sql.includes('TRUNCATE'))).toBe(true);
    });
  });

  describe('prepararBaseDePrueba', () => {
    const BASE_TEMPORAL = 'inventario_arnes_test';
    const entorno = () => ({ ...process.env, TEST_DB_NAME: BASE_TEMPORAL });
    const eliminarBaseTemporal = async () => {
      const admin = createDb({ ...configDePrueba(entorno()), database: 'postgres' });
      try {
        await admin.raw('DROP DATABASE IF EXISTS ??', [BASE_TEMPORAL]);
      } finally {
        await admin.destroy();
      }
    };
    beforeAll(eliminarBaseTemporal);
    afterAll(eliminarBaseTemporal);

    it('crea la base si falta, la deja migrada y se puede repetir sin error', async () => {
      await prepararBaseDePrueba(entorno());
      await prepararBaseDePrueba(entorno());

      const nueva = createTestDb(entorno());
      try {
        const { rows } = await nueva.raw("SELECT current_database() AS nombre, to_regclass('public.knex_migrations')::text AS tabla");
        expect(rows[0]).toEqual({ nombre: BASE_TEMPORAL, tabla: 'knex_migrations' });
      } finally {
        await nueva.destroy();
      }
    });
  });
});
