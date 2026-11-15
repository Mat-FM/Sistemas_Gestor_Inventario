const { e } = require('../errors');

// Claves de idempotencia (RNF17): ÚNICA fuente de verdad de cómo se arma la clave que se guarda en
// movimientos.clave_idempotencia (D25, D25b, D25c). La usan POST /movimientos (Tarea 7) y los traslados, la aprobación de
// conteos y la carga inicial (Tareas 9, 11 y 12). Nadie arma una clave ni una derivada a mano.
//
// Formato: `<id_usuario>:<operacion>:<clave>` y, para las operaciones que generan varios movimientos (D5),
// `<id_usuario>:<operacion>:<clave>#<sufijo>`.
// - Por usuario (D25): dos usuarios con la misma clave no se devuelven el movimiento el uno al otro.
// - Por operación (D25b): un mismo usuario que reutiliza una clave entre un movimiento y un traslado no recibe el
//   movimiento equivocado con un 200.
// - Sin `#` en la cabecera (D25c): la clave de un usuario nunca coincide con una derivada (`abc#1` frente a la #1 de `abc`).
// Inyectiva: el id solo tiene dígitos y la operación no lleva `:`, así que los dos primeros `:` separan siempre las partes.
// Peor caso: 10 (id) + 1 + 4 (operación) + 1 + 200 (clave) + 1 + 10 (sufijo) = 227 ≤ varchar(255).

/** Operaciones que registran movimientos con su propia Idempotency-Key. */
const OPERACIONES = Object.freeze({ MOVIMIENTO: 'mov', TRASLADO: 'tras', CONTEO: 'con', CARGA_INICIAL: 'ini' });
const VALORES_OPERACION = Object.freeze(Object.values(OPERACIONES));

// La cabecera Idempotency-Key, sin espacios en los extremos, tiene de 1 a 200 caracteres (D25).
const LARGO_MAXIMO_CLAVE = 200;
const SEPARADOR_DERIVADA = '#';

/**
 * Valor de la cabecera Idempotency-Key, sin espacios en los extremos. Node une con «, » los valores de una cabecera repetida;
 * el resultado se trata como una sola clave con la misma regla.
 * @param {string|undefined} valor
 * @returns {string} la clave recortada, de 1 a 200 caracteres y sin `#`
 * @throws 400 PETICION_MAL_FORMADA si falta, está vacía (o solo tiene espacios), supera los 200 caracteres o lleva `#`. El
 *   mensaje nunca repite el valor recibido.
 */
function leerClaveIdempotencia(valor) {
  const clave = typeof valor === 'string' ? valor.trim() : '';
  if (clave === '') throw e.malFormada('Falta la cabecera Idempotency-Key');
  if (clave.length > LARGO_MAXIMO_CLAVE) {
    throw e.malFormada(`La cabecera Idempotency-Key debe tener como máximo ${LARGO_MAXIMO_CLAVE} caracteres`);
  }
  if (clave.includes(SEPARADOR_DERIVADA)) {
    throw e.malFormada(`La cabecera Idempotency-Key no puede contener el carácter «${SEPARADOR_DERIVADA}»`);
  }
  return clave;
}

/**
 * La clave tal como se guarda: `<id_usuario>:<operacion>:<clave>` (D25, D25b).
 * @param {number} idUsuario entero positivo (X-User-Id ya validado)
 * @param {string} operacion uno de los valores de OPERACIONES
 * @param {string} clave la cabecera ya validada (leerClaveIdempotencia)
 * @returns {string}
 * @throws {TypeError} error de PROGRAMACIÓN (nunca un AppError) si la operación no está en OPERACIONES o los otros
 *   argumentos no son un id y un texto no vacío
 */
function claveAlmacenada(idUsuario, operacion, clave) {
  if (!VALORES_OPERACION.includes(operacion)) throw new TypeError('La operación de la clave de idempotencia no es válida');
  if (!Number.isSafeInteger(idUsuario) || idUsuario < 1) throw new TypeError('idUsuario debe ser un entero positivo');
  if (typeof clave !== 'string' || clave === '') throw new TypeError('La clave de idempotencia debe ser un texto no vacío');
  return `${idUsuario}:${operacion}:${clave}`;
}

/**
 * Clave derivada de D5 para una operación que genera varios movimientos (una por línea de conteo, por fila de la carga
 * inicial…): `<claveAlmacenada>#<sufijo>`. ÚNICA vía para armarlas.
 * @param {string} almacenada el resultado de claveAlmacenada
 * @param {string|number} sufijo texto no vacío sin `#`, o entero seguro ≥ 0 (p. ej. el id del producto o la fila)
 * @returns {string}
 * @throws {TypeError} si la base o el sufijo no son válidos (error de programación)
 */
function derivada(almacenada, sufijo) {
  if (typeof almacenada !== 'string' || almacenada === '') throw new TypeError('La clave base de una derivada debe ser un texto no vacío');
  const esEntero = Number.isSafeInteger(sufijo) && sufijo >= 0;
  const esTexto = typeof sufijo === 'string' && sufijo !== '' && !sufijo.includes(SEPARADOR_DERIVADA);
  if (!esEntero && !esTexto) throw new TypeError('El sufijo de una clave derivada debe ser un entero seguro ≥ 0 o un texto no vacío sin «#»');
  return `${almacenada}${SEPARADOR_DERIVADA}${sufijo}`;
}

module.exports = { OPERACIONES, LARGO_MAXIMO_CLAVE, leerClaveIdempotencia, claveAlmacenada, derivada };
