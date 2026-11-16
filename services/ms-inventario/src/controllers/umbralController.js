const { envelope, parsePagination } = require('../http/pagination');
const { cuerpoObjeto, entero, enteroQuery, idRuta, validarCampos } = require('../http/validate');

// Cuerpo de PUT /umbrales/{id_producto}: {cantidad_minima}, un entero >= 0 dentro del INTEGER (D2; el 0 es válido y nunca
// alerta). Se descarta cualquier otro campo (`id_producto`, `fecha_actualizacion`…): el producto lo fija la ruta.
const leerCuerpo = (cuerpo) => {
  const datos = cuerpoObjeto(cuerpo);
  return validarCampos({ cantidadMinima: () => entero(datos.cantidad_minima, 'cantidad_minima', { min: 0 }) });
};

/**
 * Controlador fino de los umbrales (RNF13): lee la petición, valida su forma, llama al servicio y arma la respuesta. No decide
 * reglas de negocio ni toca la base. La identidad (X-User-Id en el PUT) la exige registrarRutas.
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearUmbralController({ umbralService }) {
  return {
    // GET /umbrales?id_producto&pagina&por_pagina → 200 {datos, meta}
    async listar(req, res) {
      // Se informan juntos todos los parámetros inválidos (id_producto, pagina y por_pagina).
      const { idProducto, paginacion } = validarCampos({
        idProducto: () => enteroQuery(req.query.id_producto, 'id_producto'),
        paginacion: () => parsePagination(req.query),
      });
      const { filas, total } = await umbralService.listar({ idProducto, limit: paginacion.porPagina, offset: paginacion.offset });
      res.json(envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total }));
    },

    // PUT /umbrales/{id_producto} {cantidad_minima} → 200 umbral (se crea si no existía)
    // Orden: el id de la ruta (404) y el cuerpo (422) se validan antes de llamar al servicio, que es quien consulta al catálogo.
    async guardar(req, res) {
      const idProducto = idRuta(req.params.id_producto);
      const { cantidadMinima } = leerCuerpo(req.body);
      res.json(await umbralService.guardar({ identity: req.identity, idProducto, cantidadMinima }));
    },
  };
}

module.exports = { crearUmbralController };
