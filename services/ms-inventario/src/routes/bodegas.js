const { crearBodegaController } = require('../controllers/bodegaController');
const { crearBodegaService } = require('../services/bodegaService');

/**
 * Las seis operaciones de bodegas de la Tabla 9 (RF05). Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * Cada módulo de rutas arma sus propias capas a partir de `deps`: { db, clients, logger }. No toca la base al construirse.
 */
function rutasBodegas({ db } = {}) {
  const controlador = crearBodegaController({ bodegaService: crearBodegaService({ db }) });
  return [
    { metodo: 'get', ruta: '/bodegas', handler: controlador.listar },
    { metodo: 'get', ruta: '/bodegas/:id', handler: controlador.obtener },
    { metodo: 'post', ruta: '/bodegas', handler: controlador.crear },
    { metodo: 'put', ruta: '/bodegas/:id', handler: controlador.actualizar },
    { metodo: 'post', ruta: '/bodegas/:id/inactivar', handler: controlador.inactivar },
    { metodo: 'post', ruta: '/bodegas/:id/activar', handler: controlador.activar },
  ];
}

module.exports = { rutasBodegas };
