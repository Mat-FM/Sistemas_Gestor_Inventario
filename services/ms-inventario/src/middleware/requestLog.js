const { resolverRequestId, rutaDe } = require('../http/peticion');
const { ejecutarEnPeticion } = require('../logger');

/**
 * Primer middleware de la aplicación (RNF10): fija el request_id de la petición, lo devuelve en la cabecera X-Request-Id,
 * abre el contexto (AsyncLocalStorage) que el logger usa para etiquetar toda línea de la petición (D19) y, al terminar la
 * respuesta, escribe un registro { request_id, metodo, ruta, estado, id_usuario, duracion_ms }.
 *
 * La línea sale en 'close' (no al llegar la petición) para llevar el estado final, también el que fija errorHandler, y
 * para no perder las peticiones que el cliente abandona. Va siempre en nivel info: los 5xx ya los registra errorHandler
 * en nivel error con su causa.
 */
function crearRequestLog({ logger }) {
  return function requestLog(req, res, next) {
    const requestId = resolverRequestId(req);
    const inicio = process.hrtime.bigint();
    const metodo = req.method;
    const ruta = rutaDe(req);

    res.setHeader('X-Request-Id', requestId);

    res.once('close', () => {
      // El contexto de un listener de eventos no es fiable: el identificador se pasa explícito, capturado arriba.
      const registro = {
        request_id: requestId,
        metodo,
        ruta,
        // Sin cabeceras enviadas (cliente que abandona antes de la respuesta) no hay estado que informar.
        estado: res.headersSent ? res.statusCode : null,
        // req.identity no existe si la petición se rechazó antes de fijar la identidad (cabeceras inválidas).
        id_usuario: req.identity?.idUsuario ?? null,
        duracion_ms: Number((Number(process.hrtime.bigint() - inicio) / 1e6).toFixed(1)),
      };
      if (!res.writableFinished) registro.abortada = true;
      logger.info(registro);
    });

    return ejecutarEnPeticion(requestId, next);
  };
}

module.exports = { crearRequestLog };
