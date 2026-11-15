const { crearMovimientoController } = require('../controllers/movimientoController');
const { crearMovimientoService } = require('../services/movimientoService');

/**
 * Las operaciones de movimientos de la Tabla 9 (RF04, RF10). Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * Hoy solo POST /movimientos; el kardex (GET /movimientos y GET /movimientos/{id}) llega en la Tarea 10.
 * Arma sus capas a partir de `deps`: { db, clients, logger }. No toca la base ni los clientes al construirse.
 */
function rutasMovimientos({ db, clients, logger } = {}) {
  const controlador = crearMovimientoController({ movimientoService: crearMovimientoService({ db, clients, logger }) });
  return [
    { metodo: 'post', ruta: '/movimientos', handler: controlador.registrar },
  ];
}

module.exports = { rutasMovimientos };
