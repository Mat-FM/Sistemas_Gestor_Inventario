// Convierte cualquier error en la respuesta común {"error": {...}} y registra los inesperados.
const { ApiError } = require('../errores');
const logger = require('../logger');

function rutaNoEncontrada(req, res, next) {
  next(ApiError.noEncontrado(`No existe la ruta ${req.method} ${req.path}.`, 'RUTA_NO_ENCONTRADA'));
}

// eslint-disable-next-line no-unused-vars
function manejarErrores(error, req, res, next) {
  if (error instanceof ApiError) {
    return res.status(error.status).json(error.aJson());
  }
  // JSON mal formado en el cuerpo.
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json(ApiError.peticionInvalida('El cuerpo de la petición no es un JSON válido.').aJson());
  }
  logger.error('error inesperado', {
    request_id: req.contexto?.requestId,
    error: error.message,
    pila: error.stack,
  });
  return res
    .status(500)
    .json(new ApiError(500, 'ERROR_INTERNO', 'Ocurrió un error inesperado en ms-compras.').aJson());
}

module.exports = { rutaNoEncontrada, manejarErrores };
