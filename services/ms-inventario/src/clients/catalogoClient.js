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
   * @returns {Promise<object|null>} el producto (con id_producto igual al pedido), o null si no existe (404)
   * @throws {AppError} 503 si ms-catalogo no responde (red, plazo, 5xx, circuito abierto) o responde algo que el contrato no prevé
   *   (otro 4xx, un 200 que no es el producto pedido)
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
    if (status === 200) {
      // Un 200 solo vale si trae el producto PEDIDO: un cuerpo que no es un objeto, o un {} / otro producto, haría que quien llama
      // lea estado o unidad_medida de algo que no es lo que confirmó. El id debe ser el mismo número, sin coerción: el contrato y
      // ms-catalogo (clave entera de Eloquent) emiten un número; un texto como "5" sería una desviación del contrato que
      // conviene ver cuanto antes (el 503 queda registrado con su motivo), no aceptarla en silencio.
      if (!esObjeto(body)) return respuestaDefectuosa(idProducto, status, 'cuerpo_no_es_un_producto');
      if (body.id_producto !== idProducto) return respuestaDefectuosa(idProducto, status, 'id_producto_no_coincide');
      return body;
    }

    // El contrato de catálogo solo prevé 200 y 404 (más 401/422 por cabeceras, que serían un error de integración nuestro).
    // Devolver null aquí diría «el producto no existe» y se rechazaría una operación válida con un error engañoso.
    return respuestaDefectuosa(idProducto, status);
  }

  /** Registra solo campos de texto (nunca el contenido de la respuesta) y lanza el 503. `motivo` solo se añade a los 200 defectuosos. */
  function respuestaDefectuosa(idProducto, estado, motivo) {
    logger.error({ mensaje: 'Respuesta inesperada de ms-catalogo', estado, id_producto: idProducto, ...(motivo ? { motivo } : {}) });
    throw e.noDisponible('El servicio ms-catalogo no está disponible');
  }

  return { obtenerProducto };
}

module.exports = { createCatalogoClient };
