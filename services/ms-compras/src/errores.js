// Error con la forma común de todos los servicios: {"error": {"codigo", "mensaje", "detalles"}}
// (Entrega 2, sección 4.1).
class ApiError extends Error {
  constructor(status, codigo, mensaje, detalles = []) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }

  aJson() {
    return { error: { codigo: this.codigo, mensaje: this.message, detalles: this.detalles } };
  }

  static peticionInvalida(mensaje, detalles) {
    return new ApiError(400, 'PETICION_INVALIDA', mensaje, detalles);
  }

  static sinPermiso(mensaje, codigo = 'SIN_PERMISO') {
    return new ApiError(403, codigo, mensaje);
  }

  static noEncontrado(mensaje, codigo = 'NO_ENCONTRADO') {
    return new ApiError(404, codigo, mensaje);
  }

  static conflicto(codigo, mensaje, detalles) {
    return new ApiError(409, codigo, mensaje, detalles);
  }

  static datosInvalidos(detalles, mensaje = 'Los datos enviados no son válidos.') {
    return new ApiError(422, 'DATOS_INVALIDOS', mensaje, detalles);
  }

  static servicioNoDisponible(servicio, detalles) {
    return new ApiError(503, 'SERVICIO_NO_DISPONIBLE', `El servicio ${servicio} no responde.`, detalles);
  }
}

module.exports = { ApiError };
