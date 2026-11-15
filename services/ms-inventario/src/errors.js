// Errores de negocio y de validación. El manejador de errores (middleware/errorHandler.js) los traduce al cuerpo común
// {"error": {"codigo", "mensaje", "detalles"}}; cualquier otro error es un 500 genérico.

class AppError extends Error {
  /**
   * @param {number} status HTTP (400, 401, 403, 404, 409, 422 o 503)
   * @param {string} codigo código estable del vocabulario común de errores (p. ej. 'SIN_PERMISO')
   * @param {string} mensaje texto para quien consume la API
   * @param {Array<{campo: string, mensaje: string}>} detalles un elemento por campo inválido (solo en 422)
   */
  constructor(status, codigo, mensaje, detalles = []) {
    super(mensaje);
    this.name = 'AppError';
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

// Fábrica de los errores comunes a todos los servicios. Los códigos propios de este servicio (STOCK_INSUFICIENTE,
// BODEGA_INACTIVA…) se crean con e.conflicto(codigo, mensaje).
const e = {
  malFormada: (mensaje = 'La petición está mal formada') => new AppError(400, 'PETICION_MAL_FORMADA', mensaje),
  noAutenticado: (mensaje = 'No autenticado') => new AppError(401, 'NO_AUTENTICADO', mensaje),
  sinPermiso: (mensaje = 'No tiene permiso para realizar esta operación') => new AppError(403, 'SIN_PERMISO', mensaje),
  noExiste: (mensaje = 'El recurso no existe') => new AppError(404, 'NO_EXISTE', mensaje),
  conflicto: (codigo, mensaje) => new AppError(409, codigo, mensaje),
  datosNoValidos: (detalles) => new AppError(422, 'DATOS_NO_VALIDOS', 'Los datos enviados no son válidos', detalles),
  noDisponible: (mensaje = 'El servicio no está disponible') => new AppError(503, 'SERVICIO_NO_DISPONIBLE', mensaje),
};

module.exports = { AppError, e };
