// Cuerpo común de error de todos los servicios: {"error": {"codigo", "mensaje", "detalles"}}.
function cuerpoError(codigo, mensaje, detalles = []) {
  return { error: { codigo, mensaje, detalles } };
}

module.exports = { cuerpoError };
