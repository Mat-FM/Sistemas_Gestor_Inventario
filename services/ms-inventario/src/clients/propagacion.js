const { requestIdActual } = require('../logger');

// Cabeceras que este servicio propaga a ms-catalogo y ms-notificaciones: el identificador de la petición y la identidad que
// puso el Gateway. Nada más: ni Authorization ni Cookie ni ninguna otra cabecera del cliente final llegan a otro servicio.
const PROPAGABLES = Object.freeze(['x-request-id', 'x-user-id', 'x-user-rol', 'x-user-bodega']);

const CABECERA_DE = Object.freeze({
  requestId: 'X-Request-Id',
  idUsuario: 'X-User-Id',
  rol: 'X-User-Rol',
  idBodega: 'X-User-Bodega',
});

/** Texto de la cabecera, o undefined si no hay nada que propagar. Un salto de línea es un error de programación: nunca se omite en silencio. */
function comoCabecera(nombre, valor) {
  if (valor === undefined || valor === null) return undefined;
  const texto = String(valor);
  // Un valor vacío se omite: un X-User-Id vacío haría que el servicio destino responda 401.
  if (texto === '') return undefined;
  // La identidad ya viene validada (identity.js), así que esto no debería ocurrir; si ocurre, es un defecto que debe verse.
  if (/[\r\n]/.test(texto)) throw new TypeError(`El valor de la cabecera ${nombre} contiene saltos de línea`);
  return texto;
}

/**
 * Cabeceras de propagación a partir de `req.identity` ({ idUsuario, rol, idBodega, requestId }):
 * X-Request-Id, X-User-Id, X-User-Rol y X-User-Bodega, todas como texto y omitiendo las que no existen.
 *
 * El X-Request-Id es el de la petición en curso (el mismo `request_id` que lleva cada línea del registro, leído del contexto
 * de la petición) y, fuera de una petición, el de la identidad. Si no hay ninguno se omite: un identificador inventado aquí
 * no aparecería en ningún registro propio y no ayudaría a seguir la petición.
 * @throws {TypeError} si algún valor contiene un salto de línea
 */
function headersDe(identity) {
  const origen = {
    requestId: requestIdActual() ?? identity?.requestId,
    idUsuario: identity?.idUsuario,
    rol: identity?.rol,
    idBodega: identity?.idBodega,
  };
  const cabeceras = {};
  for (const [campo, nombre] of Object.entries(CABECERA_DE)) {
    const valor = comoCabecera(nombre, origen[campo]);
    if (valor !== undefined) cabeceras[nombre] = valor;
  }
  return cabeceras;
}

/** Deja solo las cabeceras de propagación (sin distinguir mayúsculas). Defensa para que un llamador no reenvíe Authorization ni Cookie. */
function soloPropagables(headers) {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return {};
  return Object.fromEntries(Object.entries(headers).filter(([nombre]) => PROPAGABLES.includes(nombre.toLowerCase())));
}

module.exports = { headersDe, soloPropagables };
