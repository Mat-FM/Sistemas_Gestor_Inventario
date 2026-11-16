const { resolverRequestId, rutaDe } = require('../http/peticion');
const { ejecutarEnPeticion } = require('../logger');

// Lecturas que NO escriben la línea por petición (Ruling 11): la sonda de salud que Kubernetes repite cada pocos segundos y la
// documentación. Los servicios hermanos hacen lo mismo (ms-reportes, ms-catalogo, ms-proveedores) para no llenar el registro de
// ruido. Rutas EXACTAS y solo GET/HEAD: un POST a /health o un /docs/otra-cosa (que da 404) siguen dejando su línea, y los
// errores de /health (503) los registra su propio handler, no esta línea. Se ignora una barra final (`/health/`).
const RUTAS_SIN_REGISTRO = new Set(['/health', '/docs', '/docs/openapi.yaml']);
const METODOS_SIN_REGISTRO = new Set(['GET', 'HEAD']);

function sinRegistro(metodo, ruta) {
  const sinBarraFinal = ruta.length > 1 && ruta.endsWith('/') ? ruta.slice(0, -1) : ruta;
  return METODOS_SIN_REGISTRO.has(metodo) && RUTAS_SIN_REGISTRO.has(sinBarraFinal);
}

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

    // Una ruta sin registro conserva todo lo demás (identificador, contexto del logger): solo omite la línea final.
    const omitir = sinRegistro(metodo, ruta);

    res.once('close', () => {
      if (omitir) return;
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
