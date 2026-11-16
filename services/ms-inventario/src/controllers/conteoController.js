const { envelope, parsePagination } = require('../http/pagination');
const { enteroQuery, enumerado, validarCampos } = require('../http/validate');

const ESTADOS = Object.freeze(['PROGRAMADO', 'EN_REVISION', 'APROBADO']);

/**
 * Filtros de GET /conteos: ?id_bodega&estado&pagina&por_pagina. Se informan juntos todos los parámetros inválidos. `estado` es
 * PROGRAMADO, EN_REVISION o APROBADO (exacto); `id_bodega` es un entero positivo. Un parámetro repetido o vacío es 422.
 */
function leerFiltros(query) {
  return validarCampos({
    idBodega: () => enteroQuery(query.id_bodega, 'id_bodega'),
    estado: () => (query.estado === undefined ? undefined : enumerado(query.estado, 'estado', ESTADOS)),
    paginacion: () => parsePagination(query),
  });
}

/**
 * Controlador fino de los conteos físicos (RNF13): toma de la petición el cuerpo, el {id} de la ruta y la identidad, llama al
 * servicio y arma la respuesta. El {id} y el cuerpo los valida el servicio (su orden frente al alcance es parte del contrato). La
 * identidad (X-User-Id) también la exige registrarRutas en las escrituras; las lecturas son válidas sin ella (D8).
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearConteoController({ conteoService }) {
  return {
    // GET /conteos?id_bodega&estado&pagina&por_pagina → 200 {datos, meta}; cada conteo SIN sus líneas (resumen)
    async listar(req, res) {
      const { paginacion, ...filtros } = leerFiltros(req.query);
      const { filas, total } = await conteoService.listar({
        ...filtros, limit: paginacion.porPagina, offset: paginacion.offset, identity: req.identity,
      });
      res.json(envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total }));
    },

    // GET /conteos/{id} → 200 conteo con sus líneas
    async obtener(req, res) {
      res.json(await conteoService.obtener({ idConteo: req.params.id, identity: req.identity }));
    },

    // POST /conteos → 201 conteo PROGRAMADO con sus líneas
    async programar(req, res) {
      res.status(201).json(await conteoService.programar({ body: req.body, identity: req.identity }));
    },
  };
}

module.exports = { crearConteoController };
