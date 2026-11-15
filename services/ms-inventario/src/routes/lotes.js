const { crearLoteController } = require('../controllers/loteController');
const { crearLoteService } = require('../services/loteService');

/**
 * Las consultas de lotes de la Tabla 9 (RF17): GET /lotes. Devuelve entradas { metodo, ruta, handler } (ver routes/index.js).
 * No hay `/lotes/:id`: los lotes nacen y cambian con los movimientos, no se consultan por id. Si alguna vez la hubiera, toda ruta
 * estática de lotes debe declararse ANTES (ver el orden en routes/index.js).
 * Arma sus capas a partir de `deps`: { db }. No toca la base al construirse.
 */
function rutasLotes({ db } = {}) {
  const controlador = crearLoteController({ loteService: crearLoteService({ db }) });
  return [
    { metodo: 'get', ruta: '/lotes', handler: controlador.listar },
  ];
}

module.exports = { rutasLotes };
