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
