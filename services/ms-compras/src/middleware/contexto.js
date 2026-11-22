// Lee las cabeceras que agrega el API Gateway (Entrega 2, sección 2.2) y registra cada petición.
const { randomUUID } = require('node:crypto');
const logger = require('../logger');
const { ApiError } = require('../errores');

const ROLES = ['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'];

function aEntero(valor) {
  if (valor === undefined) return undefined;
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : undefined;
}

// req.contexto = { requestId, usuario: { id, rol, idBodega } | null }
// Las rutas internas (llamadas desde otros servicios, como ms-reportes) llegan sin usuario.
function contexto(req, res, next) {
  const requestId = req.get('X-Request-Id') || randomUUID();
  res.set('X-Request-Id', requestId);

  const id = aEntero(req.get('X-User-Id'));
  const rol = req.get('X-User-Rol');
  req.contexto = {
    requestId,
    usuario: id ? { id, rol: ROLES.includes(rol) ? rol : undefined, idBodega: aEntero(req.get('X-User-Bodega')) } : null,
  };

  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('peticion', {
      request_id: requestId,
      metodo: req.method,
      ruta: req.originalUrl,
      estado: res.statusCode,
      duracion_ms: Number((process.hrtime.bigint() - inicio) / 1000000n),
      id_usuario: req.contexto.usuario?.id ?? null,
    });
  });
  next();
}

// Las operaciones que guardan datos necesitan saber quién las hizo (RF10).
function requiereUsuario(req, res, next) {
  const usuario = req.contexto.usuario;
  if (!usuario || !usuario.rol) {
    return next(new ApiError(401, 'NO_AUTENTICADO', 'Falta la identidad del usuario (cabeceras X-User-Id y X-User-Rol).'));
  }
  // El operador de bodega siempre tiene una bodega asignada; sin ella no puede operar.
  if (usuario.rol === 'OPERADOR_BODEGA' && !usuario.idBodega) {
    return next(ApiError.sinPermiso('El operador de bodega no tiene una bodega asignada.', 'SIN_BODEGA'));
  }
  return next();
}

// Defensa de roles (RNF07, RNF09): 403 SIN_PERMISO si el rol no figura en `roles`. Sin usuario es una llamada interna y pasa.
function exigirRol(roles) {
  return function exigirRolDeLaRuta(req, res, next) {
    const rol = req.contexto.usuario?.rol;
    if (rol && !roles.includes(rol)) return next(ApiError.sinPermiso('Su rol no puede realizar esta operación.'));
    return next();
  };
}

// Solo el operador de bodega queda limitado a su bodega (Tabla 5, «Su bodega»).
function verificarBodega(usuario, idBodega) {
  if (usuario?.rol === 'OPERADOR_BODEGA' && usuario.idBodega !== idBodega) {
    throw ApiError.sinPermiso('Solo puede operar sobre la bodega que tiene asignada.', 'BODEGA_AJENA');
  }
}

module.exports = { contexto, requiereUsuario, exigirRol, verificarBodega };
