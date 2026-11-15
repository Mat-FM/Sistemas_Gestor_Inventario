const { createDb } = require('../../src/config/db');
const { cargarConfig } = require('../../src/config/env');

// Tablas que lleva Knex para saber qué migraciones ya corrieron: truncateAll nunca las vacía.
const TABLAS_DE_CONTROL = ['knex_migrations', 'knex_migrations_lock'];

/**
 * Guardia del arnés (D21): devuelve el nombre de la base de pruebas o lanza un error claro.
 * Debe ser la única vía por la que las pruebas obtienen su base, y corre antes de abrir cualquier conexión.
 */
function verificarBaseDePrueba(env = process.env) {
  const nombre = (env.TEST_DB_NAME ?? '').trim();
  if (nombre === '') {
    throw new Error('TEST_DB_NAME no está definida: las pruebas necesitan una base propia cuyo nombre termine en _test.');
  }
  if (!nombre.endsWith('_test')) {
    throw new Error(`TEST_DB_NAME ("${nombre}") debe terminar en _test: las pruebas nunca deben tocar otra base.`);
  }
  if (nombre === env.DB_NAME) {
    throw new Error(`TEST_DB_NAME ("${nombre}") coincide con DB_NAME: las pruebas vacían las tablas y no pueden usar la base de desarrollo.`);
  }
  // El nombre acaba en un CREATE DATABASE: nada de comillas, espacios ni mayúsculas.
  if (!/^[a-z][a-z0-9_]*$/.test(nombre)) {
    throw new Error(`TEST_DB_NAME ("${nombre}") solo puede llevar minúsculas, dígitos y guiones bajos, y empezar con una letra.`);
  }
  return nombre;
}

// Configuración de conexión a la base de pruebas, sin depender de NODE_ENV.
function configDePrueba(env = process.env) {
  const database = verificarBaseDePrueba(env);
  return { ...cargarConfig(env).db, database };
}

function createTestDb(env = process.env) {
  return createDb(configDePrueba(env));
}

/**
 * Crea la base de pruebas si falta (conectándose a la base `postgres`) y aplica las migraciones.
 * Lo usa globalSetup; antes de conectar pasa por la guardia.
 */
async function prepararBaseDePrueba(env = process.env) {
  const config = configDePrueba(env);

  const admin = createDb({ ...config, database: 'postgres' });
  try {
    const { rowCount } = await admin.raw('SELECT 1 FROM pg_database WHERE datname = ?', [config.database]);
    if (rowCount === 0) {
      try {
        await admin.raw('CREATE DATABASE ??', [config.database]);
      } catch (error) {
        // 42P04: otra ejecución la creó entre la consulta y el CREATE.
        if (error.code !== '42P04') throw error;
      }
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error(`No se pudo conectar a PostgreSQL en ${config.host}:${config.port}. ¿Está arriba la base de datos (docker compose up -d db-ms-inventario)?`, { cause: error });
    }
    throw error;
  } finally {
    await admin.destroy();
  }

  const db = createDb(config);
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}

/**
 * Vacía todas las tablas de datos y reinicia sus secuencias (menos las de control de Knex).
 * Se niega a correr sobre una base cuyo nombre no termine en _test.
 */
async function truncateAll(db) {
  const { rows: base } = await db.raw('SELECT current_database() AS nombre');
  if (!base[0].nombre.endsWith('_test')) {
    throw new Error(`truncateAll se niega a vaciar la base "${base[0].nombre}": no termina en _test.`);
  }
  const { rows } = await db.raw(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL (?)",
    [TABLAS_DE_CONTROL],
  );
  if (rows.length === 0) return;
  const tablas = rows.map(() => '??').join(', ');
  await db.raw(`TRUNCATE ${tablas} RESTART IDENTITY CASCADE`, rows.map((fila) => fila.tablename));
}

module.exports = { verificarBaseDePrueba, configDePrueba, createTestDb, prepararBaseDePrueba, truncateAll };
