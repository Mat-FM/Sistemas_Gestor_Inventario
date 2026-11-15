const { describirError } = require('../errors');
const { logger: loggerPorDefecto } = require('../logger');
const { soloPropagables } = require('./propagacion');

// Cliente de ms-notificaciones: llamada 3 de la Tabla 2, «aviso». El servicio guarda primero el movimiento y avisa después; si
// el destino falla solo se anota en el registro: un fallo de notificaciones nunca debe impedir registrar un movimiento (D13).

const MENSAJE_FALLO = 'No se pudo avisar el stock bajo a ms-notificaciones';

function armarMensaje({ idProducto, idBodega, cantidadTotal, cantidadMinima }) {
  const queda = cantidadTotal === 1 ? 'queda 1 unidad' : `quedan ${cantidadTotal} unidades`;
  return `Stock bajo del producto ${idProducto} tras un movimiento en la bodega ${idBodega}: ${queda} en total y el mínimo es ${cantidadMinima}.`;
}

/**
 * @param {{request: Function}} client cliente HTTP resiliente (resilientClient.js) apuntado a ms-notificaciones
 * @param {{error: Function}} [logger]
 * @returns {{notificarStockBajo: Function}}
 */
function createNotificacionesClient(client, logger = loggerPorDefecto) {
  // Un logger roto no puede hacer que el aviso lance.
  function registrar(registro) {
    try {
      logger.error(registro);
    } catch {
      // se ignora: registrar es secundario
    }
  }

  /**
   * POST /internas/notificaciones con { tipo: 'STOCK_BAJO', mensaje, id_producto, id_bodega }, sin reintentos.
   * NUNCA lanza ni rechaza (ni por red, ni por el circuito abierto, ni por datos o cabeceras inválidos): registra el fallo con
   * los datos del aviso perdido (el cliente HTTP ya registró el detalle técnico de la llamada) y resuelve undefined.
   * Como la promesa nunca se rechaza, quien la usa puede lanzarla sin esperarla (el contrato dice «sin esperar respuesta»):
   * esperarla añadiría hasta timeoutMs a la respuesta del movimiento si ms-notificaciones está colgado.
   * @param {{idProducto: number, idBodega: number, cantidadTotal: number, cantidadMinima: number}} datos enteros
   * @param {object} [headers] cabeceras de propagación (headersDe); solo viajan X-Request-Id y X-User-*
   * @returns {Promise<void>}
   */
  async function notificarStockBajo(datos, headers = {}) {
    try {
      const campos = ['idProducto', 'idBodega', 'cantidadTotal', 'cantidadMinima'];
      if (typeof datos !== 'object' || datos === null || !campos.every((campo) => Number.isInteger(datos[campo]))) {
        throw new TypeError('Los datos del aviso de stock bajo no son válidos');
      }
      const { status } = await client.request('POST', '/internas/notificaciones', {
        headers: soloPropagables(headers),
        body: { tipo: 'STOCK_BAJO', mensaje: armarMensaje(datos), id_producto: datos.idProducto, id_bodega: datos.idBodega },
        reintentable: false, // un aviso repetido crearía otra alerta
      });
      // Un 4xx (p. ej. 422) llega aquí como respuesta, no como excepción: también es un aviso que no se entregó.
      if (!(status >= 200 && status < 300)) {
        registrar({ mensaje: MENSAJE_FALLO, id_producto: datos.idProducto, id_bodega: datos.idBodega, estado: status });
      }
    } catch (err) {
      registrar({ mensaje: MENSAJE_FALLO, id_producto: datos?.idProducto, id_bodega: datos?.idBodega, error: describirError(err) });
    }
  }

  return { notificarStockBajo };
}

module.exports = { createNotificacionesClient };
