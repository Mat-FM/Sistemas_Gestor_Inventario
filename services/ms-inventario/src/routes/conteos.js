const { crearConteoController } = require('../controllers/conteoController');
const { crearConteoService } = require('../services/conteoService');

/**
 * Las operaciones de conteos físicos de la Tabla 9 (RF18). Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * Arma sus capas a partir de `deps`: { db, clients, logger, now }. No toca la base ni los clientes al construirse.
 */
function rutasConteos({ db, clients, logger, now } = {}) {
  const controlador = crearConteoController({ conteoService: crearConteoService({ db, clients, logger, now }) });
  return [
    { metodo: 'post', ruta: '/conteos', handler: controlador.programar },
    { metodo: 'get', ruta: '/conteos', handler: controlador.listar },
    { metodo: 'get', ruta: '/conteos/:id', handler: controlador.obtener },
    { metodo: 'put', ruta: '/conteos/:id/detalles', handler: controlador.registrarDetalles },
    { metodo: 'post', ruta: '/conteos/:id/aprobacion', handler: controlador.aprobar },
  ];
}

module.exports = { rutasConteos };
