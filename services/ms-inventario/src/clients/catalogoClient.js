const { e } = require('../errors');
const { ENTERO_MAXIMO } = require('../http/validate');
const { logger: loggerPorDefecto } = require('../logger');
const { soloPropagables } = require('./propagacion');

// Cliente de ms-catalogo: llamada 1 de la Tabla 2 de la Entrega 2, «con espera» (si el destino no responde, la operación que
// la necesita se rechaza con 503).

const esObjeto = (valor) => typeof valor === 'object' && valor !== null && !Array.isArray(valor);

/**
 * @param {{request: Function}} client cliente HTTP resiliente (resilientClient.js) apuntado a ms-catalogo
 * @param {{error: Function}} [logger]
 * @returns {{obtenerProducto: Function}}
 */
function createCatalogoClient(client, logger = loggerPorDefecto) {
  /**
   * GET /productos/{id}.
   * @param {number} idProducto entero positivo ya validado por quien llama; cualquier otra cosa es un error de programación
   *   (TypeError): nunca se interpola en la ruta sin comprobarlo
   * @param {object} [headers] cabeceras de propagación (headersDe); solo viajan X-Request-Id y X-User-*
   * @returns {Promise<object|null>} el producto, o null si no existe (404)
   * @throws {AppError} 503 si ms-catalogo no responde (red, plazo, 5xx, circuito abierto) o responde algo que el contrato no prevé
   */
  async function obtenerProducto(idProducto, headers = {}) {
    if (!Number.isInteger(idProducto) || idProducto < 1 || idProducto > ENTERO_MAXIMO) {
      throw new TypeError('idProducto debe ser un entero positivo');
    }
    const { status, body } = await client.request('GET', `/productos/${idProducto}`, {
      headers: soloPropagables(headers),
      reintentable: true, // una lectura no se duplica
    });
    if (status === 404) return null;
    if (status === 200 && esObjeto(body)) return body;

    // El contrato de catálogo solo prevé 200 y 404 (más 401/422 por cabeceras, que serían un error de integración nuestro).
    // Devolver null aquí diría «el producto no existe» y se rechazaría una operación válida con un error engañoso.
    logger.error({ mensaje: 'Respuesta inesperada de ms-catalogo', estado: status, id_producto: idProducto });
    throw e.noDisponible('El servicio ms-catalogo no está disponible');
  }

  return { obtenerProducto };
}

module.exports = { createCatalogoClient };
