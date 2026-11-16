const { describirError } = require('../errors');

// Registro de los fallos que un servicio NO propaga (RNF10, D13, D19): el aviso de stock bajo que falla, el umbral que no se pudo
// evaluar tras aprobar un conteo… La operación ya está confirmada y su respuesta no debe cambiar, así que el fallo solo se
// registra. ÚNICO sitio de esta regla; lo usan movimientoService y conteoService.

/**
 * Registra `registro` con `logger.error`, añadiendo `error` como { nombre, mensaje, pila } (describirError): nunca el objeto Error
 * crudo, que saldría como {} al serializarlo. El request_id lo añade el logger desde el contexto de la petición (D19).
 * NUNCA lanza: si el logger falla (o falta), el fallo se ignora; registrar es secundario.
 * @param {{error: (registro: object) => void}|undefined} logger
 * @param {{mensaje: string}} registro campos de texto o números del registro (sin `error`)
 * @param {unknown} error el fallo que se registra
 */
function registrarFallo(logger, registro, error) {
  try {
    logger.error({ ...registro, error: describirError(error) });
  } catch {
    // se ignora: registrar es secundario
  }
}

module.exports = { registrarFallo };
