const { AppError, describirError, e } = require('../errors');
const { cuerpoError } = require('../http/cuerpoError');
const { rutaDe } = require('../http/peticion');

// Mensajes fijos para los errores 4xx que generan Express y express.json(): nunca se devuelve `err.message`, porque el del
// analizador de JSON cita trozos del cuerpo recibido.
const MENSAJES_4XX = {
  'entity.parse.failed': 'El cuerpo de la petición no es un JSON válido',
  'entity.too.large': 'El cuerpo de la petición supera el tamaño máximo permitido',
  'charset.unsupported': 'La codificación de caracteres del cuerpo no está soportada',
  'encoding.unsupported': 'La codificación del contenido del cuerpo no está soportada',
};
const MENSAJE_4XX_POR_DEFECTO = 'La petición está mal formada';
const MENSAJE_500 = 'Error interno del servidor';
const MENSAJE_503 = 'El servicio no está disponible';

// Fallos de conexión con PostgreSQL (D35): el servidor no acepta, ya no existe o cortó la conexión, o el pool no consiguió
// una conexión a tiempo. Ya no se cuenta con la base, pero el servicio sigue sano: 503 y no 500, como un servicio caído.
const CODIGOS_DE_CONEXION = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  '57P01', '57P02', '57P03', // apagándose, caída por un fallo, aún no acepta conexiones
  '53300', // demasiadas conexiones
]);

function esFalloDeConexion(err) {
  const code = err?.code;
  if (typeof code === 'string' && (CODIGOS_DE_CONEXION.has(code) || code.startsWith('08'))) return true;
  if (err?.name === 'KnexTimeoutError') return true;
  const mensaje = typeof err?.message === 'string' ? err.message : '';
  return mensaje.includes('Connection terminated') || mensaje.includes('timeout exceeded when trying to connect');
}

/**
 * Decide la respuesta de un error:
 * - AppError: su estado, código, mensaje y detalles (incluido el 503 SERVICIO_NO_DISPONIBLE).
 * - Cualquier otro error con status 4xx (Express, express.json()): conserva su estado y responde PETICION_MAL_FORMADA (D18).
 * - Un fallo de conexión con la base de datos: 503 SERVICIO_NO_DISPONIBLE, sin mensaje ni traza (D35).
 * - Todo lo demás, incluido un 5xx ajeno: 500 ERROR_INTERNO genérico, sin mensaje ni traza (D18).
 */
function traducir(err) {
  if (err instanceof AppError) {
    return { status: err.status, cuerpo: cuerpoError(err.codigo, err.message, err.detalles) };
  }
  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, cuerpo: cuerpoError('PETICION_MAL_FORMADA', MENSAJES_4XX[err.type] ?? MENSAJE_4XX_POR_DEFECTO) };
  }
  if (esFalloDeConexion(err)) {
    return { status: 503, cuerpo: cuerpoError('SERVICIO_NO_DISPONIBLE', MENSAJE_503) };
  }
  return { status: 500, cuerpo: cuerpoError('ERROR_INTERNO', MENSAJE_500) };
}

/**
 * Manejador de errores de Express (4 parámetros). En Express 5 los rechazos de promesas de un handler llegan solos aquí.
 * Todo 5xx se registra con el request_id de la petición; los 4xx no (ya los cubre la línea de requestLog).
 */
function crearErrorHandler({ logger }) {
  return function errorHandler(err, req, res, next) {
    const { status, cuerpo } = traducir(err);

    if (status >= 500) {
      logger.error({
        mensaje: status === 500 ? 'Error interno no controlado' : 'Error de disponibilidad',
        request_id: req.requestId,
        metodo: req.method,
        ruta: rutaDe(req),
        estado: status,
        codigo: cuerpo.error.codigo,
        error: describirError(err),
      });
    }

    // Si ya se empezó a responder no se puede cambiar el estado: Express cierra la conexión.
    if (res.headersSent) return next(err);
    return res.status(status).json(cuerpo);
  };
}

// Va después de todas las rutas: lo que no coincidió con ninguna es 404 NO_EXISTE.
function rutaNoEncontrada(_req, _res, next) {
  next(e.noExiste('La ruta solicitada no existe'));
}

module.exports = { crearErrorHandler, rutaNoEncontrada };
