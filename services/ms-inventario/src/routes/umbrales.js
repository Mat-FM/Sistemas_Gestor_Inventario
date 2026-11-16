const { crearUmbralController } = require('../controllers/umbralController');
const { crearUmbralService } = require('../services/umbralService');

/**
 * Las dos operaciones de umbrales de la Tabla 9 (RF09). Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * El parámetro se llama `id_producto`, como en el contrato, para que la Tarea 14 lo convierta en `{id_producto}` del OpenAPI.
 * Arma sus capas a partir de `deps`: { db, clients }. No toca la base ni los clientes al construirse.
 */
function rutasUmbrales({ db, clients } = {}) {
  const controlador = crearUmbralController({ umbralService: crearUmbralService({ db, clients }) });
  return [
    { metodo: 'get', ruta: '/umbrales', handler: controlador.listar },
    { metodo: 'put', ruta: '/umbrales/:id_producto', handler: controlador.guardar },
  ];
}

module.exports = { rutasUmbrales };
