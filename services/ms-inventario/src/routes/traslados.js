const { crearTrasladoController } = require('../controllers/trasladoController');
const { crearTrasladoService } = require('../services/trasladoService');

/**
 * Las operaciones de traslados de la Tabla 9 (RF04). Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * Arma sus capas a partir de `deps`: { db, clients, logger }. No toca la base ni los clientes al construirse.
 */
function rutasTraslados({ db, clients, logger } = {}) {
  const controlador = crearTrasladoController({ trasladoService: crearTrasladoService({ db, clients, logger }) });
  return [
    { metodo: 'post', ruta: '/traslados', handler: controlador.crear },
    { metodo: 'post', ruta: '/traslados/:id/recepcion', handler: controlador.recibir },
  ];
}

module.exports = { rutasTraslados };
