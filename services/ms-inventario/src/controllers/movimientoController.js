const { TIPOS } = require('../domain/tipos');
const { e } = require('../errors');
const { envelope, parsePagination } = require('../http/pagination');
const { enteroQuery, enumerado, fechaQuery, idRuta, validarCampos } = require('../http/validate');

/**
 * Filtros de GET /movimientos: ?id_producto&id_bodega&id_usuario&tipo&fecha_desde&fecha_hasta&pagina&por_pagina. Se informan
 * juntos todos los parámetros inválidos. `tipo` admite los nueve tipos (los tres que POST /movimientos reserva también son
 * filtros válidos del kardex). Las fechas son `YYYY-MM-DD` reales y se interpretan como días UTC (D29); `fecha_desde` posterior
 * a `fecha_hasta` es 422 (se comprueba solo si las dos son válidas: las fechas son texto de ancho fijo y comparan en orden).
 */
function leerFiltros(query) {
  const filtros = validarCampos({
    idProducto: () => enteroQuery(query.id_producto, 'id_producto'),
    idBodega: () => enteroQuery(query.id_bodega, 'id_bodega'),
    idUsuario: () => enteroQuery(query.id_usuario, 'id_usuario'),
    // Ausente → undefined; presente (también vacío o repetido), pasa por su validador.
    tipo: () => (query.tipo === undefined ? undefined : enumerado(query.tipo, 'tipo', TIPOS)),
    fechaDesde: () => fechaQuery(query.fecha_desde, 'fecha_desde'),
    fechaHasta: () => fechaQuery(query.fecha_hasta, 'fecha_hasta'),
    paginacion: () => parsePagination(query),
  });
  if (filtros.fechaDesde !== undefined && filtros.fechaHasta !== undefined && filtros.fechaDesde > filtros.fechaHasta) {
    throw e.datosNoValidos([{ campo: 'fecha_desde', mensaje: 'no puede ser posterior a fecha_hasta' }]);
  }
  return filtros;
}

/**
 * Controlador fino de los movimientos (RNF13): toma de la petición el cuerpo, la cabecera Idempotency-Key y la identidad (o, en
 * el kardex, la consulta y el id de la ruta), llama al servicio y arma la respuesta. La validación del registro va en el
 * servicio porque su ORDEN es parte del contrato: la repetición de una clave se responde antes de mirar el cuerpo (RNF17). La
 * identidad (X-User-Id) también la exige registrarRutas en las escrituras; las lecturas del kardex son válidas sin ella (D8).
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearMovimientoController({ movimientoService }) {
  return {
    // GET /movimientos?id_producto&id_bodega&id_usuario&tipo&fecha_desde&fecha_hasta&pagina&por_pagina → 200 {datos, meta}
    async listar(req, res) {
      const { paginacion, ...filtros } = leerFiltros(req.query);
      const { filas, total } = await movimientoService.listar({
        identity: req.identity, ...filtros, limit: paginacion.porPagina, offset: paginacion.offset,
      });
      res.json(envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total }));
    },

    // GET /movimientos/{id} → 200 movimiento; un id que no sea un entero positivo dentro del INTEGER es 404 NO_EXISTE
    async obtener(req, res) {
      res.json(await movimientoService.obtener({ identity: req.identity, id: idRuta(req.params.id) }));
    },

    // POST /movimientos + Idempotency-Key → 201 movimiento con saldo_resultante; 200 con el original si la clave ya se usó
    async registrar(req, res) {
      const { movimiento, replayed } = await movimientoService.registrar({
        body: req.body,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      });
      res.status(replayed ? 200 : 201).json(movimiento);
    },
  };
}

module.exports = { crearMovimientoController };
