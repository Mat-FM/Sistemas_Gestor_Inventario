// Se ejecuta una vez antes de toda la suite: deja lista la base de pruebas (D21).
const { prepararBaseDePrueba } = require('./db');

module.exports = async function globalSetup() {
  await prepararBaseDePrueba(process.env);
};
