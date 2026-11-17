// Llamada 4 de la Tabla 2: ms-compras → ms-notificaciones, POST /internas/notificaciones (aviso).
// Es un aviso: la recepción ya quedó guardada. Si ms-notificaciones no responde, solo se registra
// el fallo y la operación sigue (RNF18). No se reintenta, porque repetirla podría duplicar la alerta.
const config = require('../config');
const logger = require('../logger');
const { ClienteHttp } = require('./clienteHttp');

const cliente = new ClienteHttp('ms-notificaciones', config.servicios.notificaciones);

function avisar(notificacion, { requestId }) {
  // No se espera la respuesta: la promesa queda corriendo y nunca lanza.
  return cliente
    .peticion('POST', '/internas/notificaciones', {
      cuerpo: notificacion,
      cabeceras: { 'X-Request-Id': requestId },
    })
    .then((respuesta) => {
      if (respuesta.status >= 400) {
        logger.warn('aviso rechazado', { destino: 'ms-notificaciones', estado: respuesta.status, request_id: requestId });
      }
    })
    .catch((error) => {
      logger.warn('aviso no entregado', { destino: 'ms-notificaciones', causa: error.message, request_id: requestId });
    });
}

module.exports = { avisar, cliente };
