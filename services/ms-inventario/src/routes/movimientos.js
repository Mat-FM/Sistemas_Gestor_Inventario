const { crearMovimientoController } = require('../controllers/movimientoController');
const { crearMovimientoService } = require('../services/movimientoService');

/**
 * Las operaciones de movimientos de la Tabla 9 (RF04, RF10, RF15): POST /movimientos y las dos lecturas del kardex,
 * GET /movimientos y GET /movimientos/{id}. Devuelve entradas { metodo, ruta, handler } (ver routes/index.js). `/movimientos` es
 * la misma ruta con dos métodos, y `/movimientos/:id` no oculta a ninguna estática (no hay `/movimientos/<palabra>`).
 * Arma sus capas a partir de `deps`: { db, clients, logger }. No toca la base ni los clientes al construirse.
 */
function rutasMovimientos({ db, clients, logger } = {}) {
  const controlador = crearMovimientoController({ movimientoService: crearMovimientoService({ db, clients, logger }) });
  return [
    { metodo: 'post', ruta: '/movimientos', handler: controlador.registrar },
    { metodo: 'get', ruta: '/movimientos', handler: controlador.listar },
    { metodo: 'get', ruta: '/movimientos/:id', handler: controlador.obtener },
  ];
}

module.exports = { rutasMovimientos };
