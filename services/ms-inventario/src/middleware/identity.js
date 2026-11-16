const { e } = require('../errors');
const { resolverRequestId } = require('../http/peticion');

// El servicio confía en las cabeceras X-User-* porque el único alcanzable desde fuera es el Gateway, que las repone siempre
// (RNF09). Aun así las valida: una cabecera inválida nunca se ignora en silencio ni acaba en un 500 de la base (D20).

const ROLES = Object.freeze(['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR']);

const ENTERO_POSITIVO = /^[1-9]\d*$/;
// Los identificadores van a columnas INTEGER de PostgreSQL: por encima de este valor la base lanzaría un error 22003.
const ID_MAXIMO = 2147483647;

// Cabecera ausente → null; presente pero que no sea un entero positivo (vacía incluida) → 401.
function leerEntero(valor, cabecera) {
  if (valor === undefined) return null;
  if (!ENTERO_POSITIVO.test(valor) || Number(valor) > ID_MAXIMO) {
    throw e.noAutenticado(`La cabecera ${cabecera} no es válida`);
  }
  return Number(valor);
}

function leerRol(valor) {
  if (valor === undefined) return null;
  if (!ROLES.includes(valor)) throw e.noAutenticado('La cabecera X-User-Rol no es válida');
  return valor;
}

/**
 * Fija req.identity = { idUsuario, rol, idBodega, requestId } a partir de X-User-Id, X-User-Rol, X-User-Bodega y X-Request-Id.
 * Sin X-User-Id la petición es una llamada interna válida (D8): idUsuario es null y las escrituras la rechazan con requireUser.
 * X-User-Id sin X-User-Rol es 401: el Gateway siempre manda las dos juntas.
 */
function identity(req, _res, next) {
  const requestId = resolverRequestId(req);
  const idUsuario = leerEntero(req.headers['x-user-id'], 'X-User-Id');
  const idBodega = leerEntero(req.headers['x-user-bodega'], 'X-User-Bodega');
  const rol = leerRol(req.headers['x-user-rol']);
  if (idUsuario !== null && rol === null) throw e.noAutenticado('Falta la cabecera X-User-Rol');
  req.identity = { idUsuario, rol, idBodega, requestId };
  next();
}

/** Las escrituras exigen un usuario: 401 si la petición no trae X-User-Id. Devuelve la misma identidad. */
function requireUser(identidad) {
  if (identidad.idUsuario === null) throw e.noAutenticado('Falta la cabecera X-User-Id');
  return identidad;
}

/**
 * Limita al operador de bodega a la suya: sin bodega pedida devuelve la del operador; si pide otra, o si el operador no
 * tiene bodega asignada, 403. Los demás roles (y las llamadas internas) reciben lo que pidieron.
 */
function scopeBodega(identidad, idBodega) {
  if (identidad.rol !== 'OPERADOR_BODEGA') return idBodega;
  if (identidad.idBodega == null) throw e.sinPermiso('El operador de bodega no tiene una bodega asignada');
  if (idBodega != null && idBodega !== identidad.idBodega) {
    throw e.sinPermiso('El operador de bodega solo puede operar sobre su bodega');
  }
  return identidad.idBodega;
}

module.exports = { ROLES, identity, requireUser, scopeBodega };
