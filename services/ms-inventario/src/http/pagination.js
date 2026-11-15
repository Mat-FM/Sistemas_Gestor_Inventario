const { AppError, e } = require('../errors');
const { enteroQuery } = require('./validate');

const POR_PAGINA_POR_DEFECTO = 20;
const POR_PAGINA_MAXIMO = 100;

// Ejecuta una validación y, si es un 422, anota sus detalles en vez de lanzar: así se informan todos los parámetros inválidos.
function recoger(detalles, validar) {
  try {
    return validar();
  } catch (error) {
    if (!(error instanceof AppError) || error.codigo !== 'DATOS_NO_VALIDOS') throw error;
    detalles.push(...error.detalles);
    return undefined;
  }
}

/**
 * Lee ?pagina=1&por_pagina=20 (D14): por defecto 1 y 20; pagina >= 1 y por_pagina entre 1 y 100, o 422 DATOS_NO_VALIDOS.
 * @returns {{pagina: number, porPagina: number, offset: number}}
 */
function parsePagination(query = {}) {
  const detalles = [];
  const pagina = recoger(detalles, () => enteroQuery(query.pagina, 'pagina')) ?? 1;
  const porPagina = recoger(detalles, () => enteroQuery(query.por_pagina, 'por_pagina', { max: POR_PAGINA_MAXIMO })) ?? POR_PAGINA_POR_DEFECTO;
  if (detalles.length > 0) throw e.datosNoValidos(detalles);
  // pagina llega acotada por el techo de enteroQuery (2147483647), así que el desplazamiento siempre es un entero exacto.
  return { pagina, porPagina, offset: (pagina - 1) * porPagina };
}

/** Respuesta de un listado: { datos, meta: { pagina, por_pagina, total } } con `total` de TODAS las filas, no de la página. */
function envelope(datos, { pagina, porPagina, total }) {
  return { datos, meta: { pagina, por_pagina: porPagina, total } };
}

module.exports = { parsePagination, envelope };
