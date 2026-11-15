const { cargarConfig } = require('../src/config/env');

describe('cargarConfig con NODE_ENV=test', () => {
  const base = { DB_HOST: '127.0.0.1', DB_PORT: '5439', DB_NAME: 'inventario_db', DB_USER: 'inventario' };

  it('sin TEST_DB_NAME lanza un error claro en vez de dejar database en undefined', () => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'test' })).toThrow(/TEST_DB_NAME/);
  });

  it.each([['vacía', ''], ['solo con espacios', '   ']])('con TEST_DB_NAME %s también lanza el error', (_descripcion, valor) => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'test', TEST_DB_NAME: valor })).toThrow(/TEST_DB_NAME/);
  });

  it('no cae en DB_NAME: la base de desarrollo nunca se usa en pruebas', () => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'test' })).toThrow(/NODE_ENV=test/);
  });

  it('con TEST_DB_NAME definido usa esa base', () => {
    expect(cargarConfig({ ...base, NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test' }).db.database).toBe('inventario_test');
  });

  it.each([['production'], ['development'], [undefined]])('con NODE_ENV=%s no exige TEST_DB_NAME y usa DB_NAME', (entorno) => {
    expect(cargarConfig({ ...base, NODE_ENV: entorno }).db.database).toBe('inventario_db');
  });
});
