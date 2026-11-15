// Tipos de movimiento del kardex y su efecto sobre el saldo (D3, D4). Dominio puro: sin Express, sin base de datos y sin
// ningún otro módulo, para que lo usen por igual el motor de movimientos, los controladores y las Tareas 8–13.
//
// La lista debe coincidir con la restricción `movimientos_tipo_valido` de la migración (stock.test.js lo comprueba contra la
// base). La migración repite los valores a propósito: es una instantánea y no importa este módulo.

// Techo del INTEGER de PostgreSQL (columnas `cantidad` y `saldo_resultante`). Repetido aquí para no depender de http/validate.
const ENTERO_MAXIMO = 2147483647;

/** Los nueve tipos de movimiento. */
const TIPOS = Object.freeze([
  'ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA',
  'DEVOLUCION_PROVEEDOR', 'TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL',
]);

/**
 * Los que acepta POST /movimientos (D4). Los traslados los crean POST /traslados y su recepción, y la carga inicial su ruta
 * interna: por POST /movimientos son 403. ENTRADA_COMPRA y DEVOLUCION_PROVEEDOR los registra ms-compras con las mismas
 * cabeceras que un usuario, así que no se pueden reservar a ese servicio.
 */
const TIPOS_PERMITIDOS_POR_API = Object.freeze([
  'ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA', 'DEVOLUCION_PROVEEDOR',
]);

const SUMAN = Object.freeze(['ENTRADA', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL']);
const RESTAN = Object.freeze(['SALIDA', 'DEVOLUCION_PROVEEDOR', 'TRASLADO_SALIDA']);

/**
 * Cambio que un movimiento produce en el saldo (D3). En todos los tipos la `cantidad` es un entero positivo y el signo lo pone
 * el tipo; solo AJUSTE lleva la cantidad con su signo (entero distinto de 0).
 * La entrada ya llega validada (422 en el controlador o en el servicio): un tipo desconocido o una cantidad imposible aquí es
 * un error de programación y lanza TypeError (un 500), nunca un saldo calculado con un signo inventado.
 * @param {string} tipo uno de TIPOS
 * @param {number} cantidad entero; > 0 salvo en AJUSTE, donde es ≠ 0
 * @returns {number} positivo si suma, negativo si resta
 */
function delta(tipo, cantidad) {
  if (!Number.isSafeInteger(cantidad) || cantidad === 0 || Math.abs(cantidad) > ENTERO_MAXIMO) {
    throw new TypeError('La cantidad de un movimiento debe ser un entero distinto de 0 dentro del INTEGER');
  }
  if (tipo === 'AJUSTE') return cantidad;
  if (cantidad < 0) throw new TypeError(`La cantidad de un movimiento ${tipo} no lleva signo: debe ser positiva`);
  if (SUMAN.includes(tipo)) return cantidad;
  if (RESTAN.includes(tipo)) return -cantidad;
  throw new TypeError('El tipo de movimiento no es válido');
}

module.exports = { TIPOS, TIPOS_PERMITIDOS_POR_API, delta };
