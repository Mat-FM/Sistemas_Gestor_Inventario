const { envelope, parsePagination } = require('../http/pagination');
const { enteroQuery, validarCampos } = require('../http/validate');

/**
 * Controlador fino de los saldos (RNF13): lee la petición, valida su forma, llama al servicio y arma la respuesta. No decide
 * reglas de negocio ni toca la base. Las dos rutas son lecturas, válidas sin X-User-Id (llamadas internas, D8).
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearSaldoController({ saldoService }) {
  return {
    // GET /saldos?id_producto&id_bodega&pagina&por_pagina → 200 {datos, meta}; con id_producto, meta.cantidad_total (D10)
    async listar(req, res) {
      // Se informan juntos todos los parámetros inválidos (id_producto, id_bodega, pagina y por_pagina).
      const { idProducto, idBodega, paginacion } = validarCampos({
        idProducto: () => enteroQuery(req.query.id_producto, 'id_producto'),
        idBodega: () => enteroQuery(req.query.id_bodega, 'id_bodega'),
        paginacion: () => parsePagination(req.query),
      });
      const { filas, total, cantidadTotal } = await saldoService.listar({
        identity: req.identity, idProducto, idBodega, limit: paginacion.porPagina, offset: paginacion.offset,
      });
      const cuerpo = envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total });
      // Aditivo respecto al contrato: la clave solo existe cuando se pidió un id_producto.
      if (cantidadTotal !== undefined) cuerpo.meta.cantidad_total = cantidadTotal;
      res.json(cuerpo);
    },

    // GET /saldos/bajo-umbral → 200 [{id_producto, cantidad_total, cantidad_minima}] (arreglo plano, sin paginar)
    async bajoUmbral(_req, res) {
      res.json(await saldoService.bajoUmbral());
    },
  };
}

module.exports = { crearSaldoController };
