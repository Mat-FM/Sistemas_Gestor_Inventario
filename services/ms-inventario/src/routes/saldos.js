const { crearSaldoController } = require('../controllers/saldoController');
const { crearSaldoService } = require('../services/saldoService');

/**
 * Las dos consultas de saldos de la Tabla 9 (RF05, RF09). Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * `/saldos/bajo-umbral` es estática y va ANTES de cualquier `/saldos/:x` que se añada (hoy no hay ninguna).
 * Arma sus capas a partir de `deps`: { db }. No toca la base al construirse.
 */
function rutasSaldos({ db } = {}) {
  const controlador = crearSaldoController({ saldoService: crearSaldoService({ db }) });
  return [
    { metodo: 'get', ruta: '/saldos/bajo-umbral', handler: controlador.bajoUmbral },
    { metodo: 'get', ruta: '/saldos', handler: controlador.listar },
  ];
}

module.exports = { rutasSaldos };
