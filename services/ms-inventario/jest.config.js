// Configuración de Jest (RNF20: cobertura mínima del 60 %).
module.exports = {
  testEnvironment: 'node',
  // Un solo proceso: todas las suites comparten la base inventario_test y se truncan entre sí si corren a la vez.
  maxWorkers: 1,
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Plazo de cada prueba y de cada hook (beforeAll/afterAll heredan este valor). El de Jest por defecto, 5 s, no alcanza para
  // los hooks que crean y borran bases de datos temporales (schema.test.js, db.test.js): borrar una base tarda ~0,1 s casi
  // siempre, pero con cobertura (y la CI siempre la mide, RNF20) o con el servidor ocupado a veces se detiene más de 5 s y
  // la suite entera falla aunque todas sus pruebas pasen.
  testTimeout: 30000,
  // Crea la base de pruebas si falta y aplica las migraciones (D21).
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: { lines: 60, statements: 60, functions: 60, branches: 60 },
  },
};
