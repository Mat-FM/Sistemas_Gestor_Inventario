// Configuración de Jest (RNF20: cobertura mínima del 60 %).
module.exports = {
  testEnvironment: 'node',
  // Un solo proceso: todas las suites comparten la base inventario_test y se truncan entre sí si corren a la vez.
  maxWorkers: 1,
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Crea la base de pruebas si falta y aplica las migraciones (D21).
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: { lines: 60, statements: 60, functions: 60, branches: 60 },
  },
};
