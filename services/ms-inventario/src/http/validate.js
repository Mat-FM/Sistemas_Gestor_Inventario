const { e } = require('../errors');

// Validadores de entrada. Cada uno devuelve el valor ya convertido o lanza e.datosNoValidos([{ campo, mensaje }]) (422).
// Los valores de un cuerpo JSON ya vienen tipados (`entero`); los de la cadena de consulta llegan como texto (`...Query`).

// Techo por defecto de los enteros: el INTEGER de PostgreSQL (D2). Por encima, la base lanzaría un error 22003 y la
// petición acabaría en un 500.
const ENTERO_MAXIMO = 2147483647;

const rechazo = (campo, mensaje) => e.datosNoValidos([{ campo, mensaje }]);
const mensajeRango = (min, max) => `debe ser un número entero entre ${min} y ${max}`;

/**
 * Entero de un cuerpo JSON. Solo vale un número entero seguro dentro del rango: el texto ("5"), los decimales, null y los
 * campos ausentes son 422.
 * @param {{min?: number, max?: number}} [opciones] min = 1 y max = 2147483647 por defecto
 */
function entero(valor, campo, { min = 1, max = ENTERO_MAXIMO } = {}) {
  if (valor === undefined) throw rechazo(campo, 'es obligatorio');
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < min || valor > max) {
    throw rechazo(campo, mensajeRango(min, max));
  }
  return valor;
}

/**
 * Entero de la cadena de consulta (llega como texto). Parámetro ausente → undefined; un valor repetido (arreglo), vacío o
 * que no sea un entero decimal estricto es 422.
 */
function enteroQuery(valor, campo, { min = 1, max = ENTERO_MAXIMO } = {}) {
  if (valor === undefined) return undefined;
  if (typeof valor !== 'string' || !/^-?\d+$/.test(valor)) throw rechazo(campo, 'debe ser un número entero');
  const numero = Number(valor);
  if (!Number.isSafeInteger(numero) || numero < min || numero > max) throw rechazo(campo, mensajeRango(min, max));
  return numero;
}

const FORMATO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

const esBisiesto = (anio) => (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;

function diasDelMes(anio, mes) {
  if (mes === 2) return esBisiesto(anio) ? 29 : 28;
  return [4, 6, 9, 11].includes(mes) ? 30 : 31;
}

/**
 * Fecha `YYYY-MM-DD` que exista en el calendario (no acepta el 30 de febrero, ni la hora, ni el año 0000). La devuelve tal cual.
 * Se valida con aritmética de calendario y no con `new Date()`, que corrige en silencio las fechas imposibles.
 */
function fecha(valor, campo) {
  const partes = typeof valor === 'string' ? FORMATO_FECHA.exec(valor) : null;
  if (partes) {
    const [anio, mes, dia] = partes.slice(1).map(Number);
    if (anio >= 1 && mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasDelMes(anio, mes)) return valor;
  }
  throw rechazo(campo, 'debe ser una fecha válida con el formato AAAA-MM-DD');
}

/** Valor que debe estar en `lista` (comparación exacta, sensible a mayúsculas). */
function enumerado(valor, campo, lista) {
  if (typeof valor !== 'string' || !lista.includes(valor)) {
    throw rechazo(campo, `debe ser uno de: ${lista.join(', ')}`);
  }
  return valor;
}

/** Booleano de la cadena de consulta: solo "true" o "false". Parámetro ausente → undefined. */
function booleanoQuery(valor, campo) {
  if (valor === undefined) return undefined;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  throw rechazo(campo, 'debe ser true o false');
}

module.exports = { ENTERO_MAXIMO, entero, enteroQuery, fecha, enumerado, booleanoQuery };
