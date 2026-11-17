// Llamada 2 de la Tabla 2: ms-compras → ms-inventario, POST /movimientos (espera respuesta).
const config = require('../config');
const { ApiError } = require('../errores');
const { ClienteHttp, ServicioNoDisponible } = require('./clienteHttp');

const cliente = new ClienteHttp('ms-inventario', config.servicios.inventario);

function cabecerasDeIdentidad(usuario, requestId) {
  const cabeceras = { 'X-Request-Id': requestId, 'X-User-Id': String(usuario.id), 'X-User-Rol': usuario.rol };
  if (usuario.idBodega) cabeceras['X-User-Bodega'] = String(usuario.idBodega);
  return cabeceras;
}

// Registra un movimiento ENTRADA_COMPRA o DEVOLUCION_PROVEEDOR y devuelve el movimiento creado.
// Con Idempotency-Key, repetir la llamada no duplica el movimiento, por eso sí se reintenta (RNF17).
async function registrarMovimiento(movimiento, { claveIdempotencia, usuario, requestId }) {
  let respuesta;
  try {
    respuesta = await cliente.peticion('POST', '/movimientos', {
      cuerpo: movimiento,
      cabeceras: { ...cabecerasDeIdentidad(usuario, requestId), 'Idempotency-Key': claveIdempotencia },
      reintentar: true,
    });
  } catch (error) {
    if (error instanceof ServicioNoDisponible) throw ApiError.servicioNoDisponible('ms-inventario');
    throw error;
  }

  if (respuesta.status === 200 || respuesta.status === 201) {
    const datos = respuesta.cuerpo?.datos ?? respuesta.cuerpo ?? {};
    if (!Number.isInteger(datos.id_movimiento)) {
      throw ApiError.servicioNoDisponible('ms-inventario', [
        { mensaje: 'La respuesta de ms-inventario no trae id_movimiento.' },
      ]);
    }
    return datos;
  }

  // Los rechazos de inventario (por ejemplo 409 STOCK_INSUFICIENTE o 404 producto inexistente)
  // se devuelven al cliente con el mismo código.
  const error = respuesta.cuerpo?.error ?? {};
  const status = [400, 401, 403, 404, 409, 422].includes(respuesta.status) ? respuesta.status : 422;
  throw new ApiError(
    status,
    error.codigo || 'RECHAZADO_POR_INVENTARIO',
    error.mensaje || `ms-inventario rechazó el movimiento (${respuesta.status}).`,
    error.detalles || [],
  );
}

module.exports = { registrarMovimiento, cliente };
