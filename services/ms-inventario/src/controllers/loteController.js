const { e } = require('../errors');
const { envelope, parsePagination } = require('../http/pagination');
const { booleanoQuery, enteroQuery, fechaQuery, validarCampos } = require('../http/validate');

/**
 * Filtros de GET /lotes: ?id_producto&id_bodega&vence_antes_de&con_existencia&pagina&por_pagina. Se informan juntos todos los
 * parámetros inválidos. `vence_antes_de` es una fecha `YYYY-MM-DD` real y el filtro es estricto (un lote que vence ese día no
 * entra); `con_existencia` es `true` o `false` (solo `true` filtra).
 */
function leerFiltros(query) {
  return validarCampos({
    idProducto: () => enteroQuery(query.id_producto, 'id_producto'),
    idBodega: () => enteroQuery(query.id_bodega, 'id_bodega'),
    venceAntesDe: () => fechaQuery(query.vence_antes_de, 'vence_antes_de'),
    conExistencia: () => booleanoQuery(query.con_existencia, 'con_existencia'),
    paginacion: () => parsePagination(query),
  });
}

// Un parámetro OBLIGATORIO de la consulta: ausente es 422 («es obligatorio»); presente pasa por su validador (que ya rechaza el
// repetido, el vacío y el que no sea un entero).
function obligatorio(valor, campo, leer) {
  const leido = leer(valor, campo);
  if (leido === undefined) throw e.datosNoValidos([{ campo, mensaje: 'es obligatorio' }]);
  return leido;
}

/**
 * Parámetros de GET /lotes/sugerencia-salida: ?id_producto&id_bodega&cantidad, los tres OBLIGATORIOS y enteros positivos dentro
 * del INTEGER (la cantidad pedida es un entero ≥ 1, D2). Se informan juntos todos los inválidos o ausentes.
 */
function leerSugerencia(query) {
  return validarCampos({
    idProducto: () => obligatorio(query.id_producto, 'id_producto', enteroQuery),
    idBodega: () => obligatorio(query.id_bodega, 'id_bodega', enteroQuery),
    cantidad: () => obligatorio(query.cantidad, 'cantidad', enteroQuery),
  });
}

/**
 * Controlador fino de los lotes (RNF13): lee la petición, valida su forma, llama al servicio y arma la respuesta. No decide
 * reglas de negocio ni toca la base. Las rutas son lecturas, válidas sin X-User-Id (llamadas internas, D8). Los métodos no usan
 * `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al manejador de errores
 * (Express 5).
 */
function crearLoteController({ loteService }) {
  return {
    // GET /lotes?id_producto&id_bodega&vence_antes_de&con_existencia&pagina&por_pagina → 200 {datos, meta}, del que vence primero al último
    async listar(req, res) {
      const { paginacion, ...filtros } = leerFiltros(req.query);
      const { filas, total } = await loteService.listar({
        identity: req.identity, ...filtros, limit: paginacion.porPagina, offset: paginacion.offset,
      });
      res.json(envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total }));
    },

    // GET /lotes/sugerencia-salida?id_producto&id_bodega&cantidad → 200 [{id_lote, codigo_lote, fecha_vencimiento, cantidad_sugerida}]
    // (arreglo plano, sin paginar, del más próximo a vencer al último); 409 STOCK_INSUFICIENTE si los lotes no alcanzan
    async sugerirSalida(req, res) {
      res.json(await loteService.sugerirSalida({ identity: req.identity, ...leerSugerencia(req.query) }));
    },
  };
}

module.exports = { crearLoteController };
