// Análisis de código con ESLint (RNF13). Solo las reglas recomendadas, que detectan errores reales (variables sin usar,
// referencias rotas, código inalcanzable); no impone estilo, así que no obliga a reformatear nada.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node },
    rules: {
      // Un parámetro o una variable que empieza por «_» se deja sin usar a propósito.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  { files: ['tests/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.jest } } },
];
