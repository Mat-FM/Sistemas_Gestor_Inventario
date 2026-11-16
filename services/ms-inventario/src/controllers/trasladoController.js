const { envelope, parsePagination } = require('../http/pagination');
const { enteroQuery, enumerado, validarCampos } = require('../http/validate');

const ESTADOS = Object.freeze(['EN_TRANSITO', 'RECIBIDO']);

/**
 * Filtros de GET /traslados: ?estado&id_bodega&pagina&por_pagina. Se informan juntos todos los parámetros inválidos. `estado`
 * es EN_TRANSITO o RECIBIDO (exacto); `id_bodega` es un entero positivo y filtra por la bodega de origen O la de destino. Un
 * parámetro repetido o vacío es 422.
 */
function leerFiltros(query) {
  return validarCampos({
    estado: () => (query.estado === undefined ? undefined : enumerado(query.estado, 'estado', ESTADOS)),
    idBodega: () => enteroQuery(query.id_bodega, 'id_bodega'),
    paginacion: () => parsePagination(query),
  });
}

/**
 * Controlador fino de los traslados (RNF13): toma de la petición el cuerpo, la cabecera Idempotency-Key y la identidad, llama al
 * servicio y arma la respuesta. La validación va en el servicio porque su ORDEN es parte del contrato: la repetición de una clave
 * se responde antes de mirar el cuerpo (RNF17). La identidad (X-User-Id) también la exige registrarRutas en las escrituras; el
 * listado es una lectura, válida sin ella (D8).
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearTrasladoController({ trasladoService }) {
  return {
    // GET /traslados?estado&id_bodega&pagina&por_pagina → 200 {datos, meta}, del envío más reciente al más antiguo
    async listar(req, res) {
      const { paginacion, ...filtros } = leerFiltros(req.query);
      const { filas, total } = await trasladoService.listar({
        ...filtros, limit: paginacion.porPagina, offset: paginacion.offset, identity: req.identity,
      });
      res.json(envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total }));
    },

    // POST /traslados + Idempotency-Key → 201 { ...Traslado EN_TRANSITO, movimiento: TRASLADO_SALIDA }; 200 con el original
    // (en su estado actual) si la clave ya se usó
    async crear(req, res) {
      const { traslado, movimiento, replayed } = await trasladoService.crear({
        body: req.body,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      });
      res.status(replayed ? 200 : 201).json({ ...traslado, movimiento });
    },

    // POST /traslados/{id}/recepcion + Idempotency-Key → 200 { ...Traslado RECIBIDO, movimiento: TRASLADO_ENTRADA }, también
    // cuando es la repetición de la misma recepción. El {id} lo valida el servicio, DESPUÉS de la clave (su orden es parte del
    // contrato: una clave ausente es 400 aunque el id sea inválido).
    async recibir(req, res) {
      const { traslado, movimiento } = await trasladoService.recibir({
        idTraslado: req.params.id,
        body: req.body,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      });
      res.json({ ...traslado, movimiento });
    },
  };
}

module.exports = { crearTrasladoController };
