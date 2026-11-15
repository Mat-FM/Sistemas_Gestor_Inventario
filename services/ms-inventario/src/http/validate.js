const { AppError, e } = require('../errors');

// Validadores de entrada. Cada uno devuelve el valor ya convertido o lanza e.datosNoValidos([{ campo, mensaje }]) (422).
// Los valores de un cuerpo JSON ya vienen tipados (`entero`, `texto`); los de la cadena de consulta llegan como texto (`...Query`).
// Excepción: `idRuta` (el {id} de la dirección) lanza 404 NO_EXISTE. `validarCampos` reúne varios 422 en uno solo.

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

const NUL = '\u0000';

// Cuenta caracteres (puntos de código), como el varchar(n) de PostgreSQL: .length cuenta unidades UTF-16 y un emoji ocuparía 2.
function largoEnCaracteres(cadena) {
  let largo = 0;
  for (const _caracter of cadena) largo += 1;
  return largo;
}

/**
 * Texto de un cuerpo JSON con el largo de su columna (si no, PostgreSQL lanzaría 22001 y la petición acabaría en un 500).
 * - Recorta los espacios de los extremos (trim) y DEVUELVE el texto recortado: el largo se mide sobre lo que se guarda.
 * - Sin transformar nada más (no cambia mayúsculas ni normaliza Unicode).
 * - Rechaza (422) lo que no sea una cadena (número, null, arreglo, objeto), el campo ausente, el texto con menos de `min`
 *   caracteres (con min = 1, vacío o solo espacios), con más de `max` caracteres y el que lleve el carácter nulo (U+0000):
 *   PostgreSQL no lo admite en un texto (22021) y también sería un 500.
 * - Rechaza el texto mal formado (un sustituto UTF-16 suelto, p. ej. "\ud800"): sin esto Node lo cambiaría en silencio por
 *   U+FFFD al enviarlo a la base y se guardaría un dato distinto del que mandó el cliente.
 * - `opcional` solo exime a la AUSENCIA del campo (undefined → undefined): null, "" y los tipos equivocados siguen siendo 422.
 * - `max` es obligatorio y debe ser el largo exacto de la columna; si falta es un error de programación (TypeError), no un
 *   límite que se desactiva en silencio.
 * @param {{max: number, min?: number, opcional?: boolean}} opciones
 */
function texto(valor, campo, { max, min = 1, opcional = false } = {}) {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TypeError('texto() exige `max`, un entero positivo: el largo de la columna');
  }
  if (valor === undefined) {
    if (opcional) return undefined;
    throw rechazo(campo, 'es obligatorio');
  }
  if (typeof valor !== 'string') throw rechazo(campo, 'debe ser un texto');
  if (valor.includes(NUL)) throw rechazo(campo, 'no puede contener caracteres nulos');
  if (!valor.isWellFormed()) throw rechazo(campo, 'no es un texto Unicode válido (lleva un carácter suelto de un par sustituto)');

  const recortado = valor.trim();
  const largo = largoEnCaracteres(recortado);
  if (largo < min) {
    throw rechazo(campo, min <= 1 ? 'no puede estar vacío' : `debe tener al menos ${min} caracteres`);
  }
  if (largo > max) throw rechazo(campo, `debe tener como máximo ${max} caracteres`);
  return recortado;
}

/**
 * Cuerpo JSON de una petición como objeto. Express 5 deja req.body en undefined cuando no hay cuerpo o el Content-Type no
 * es JSON: se trata como {} para que cada campo obligatorio informe su propio 422. Un arreglo (express.json() lo admite) o
 * cualquier otro valor que no sea un objeto es 422 sobre el campo "cuerpo".
 */
function cuerpoObjeto(cuerpo) {
  if (cuerpo === undefined) return {};
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    throw rechazo('cuerpo', 'debe ser un objeto JSON');
  }
  return cuerpo;
}

const FORMATO_ID_RUTA = /^[1-9]\d*$/;

/**
 * El {id} de una ruta (llega como texto) como entero. Lo que no sea un entero positivo canónico dentro del INTEGER de
 * PostgreSQL es 404 NO_EXISTE: ningún recurso vive en esa dirección, como en ms-catalogo (`{id}` restringido a dígitos), y
 * así un id enorme nunca llega a la base (error 22003 → 500).
 */
function idRuta(valor) {
  if (typeof valor !== 'string' || !FORMATO_ID_RUTA.test(valor) || Number(valor) > ENTERO_MAXIMO) throw e.noExiste();
  return Number(valor);
}

/**
 * Ejecuta una validación y, si es un 422, anota sus detalles en `detalles` y devuelve undefined en vez de lanzar: así se
 * informan todos los campos inválidos a la vez. Un error que no sea un 422 se relanza (es un fallo, no un dato inválido).
 */
function recoger(detalles, validar) {
  try {
    return validar();
  } catch (error) {
    if (!(error instanceof AppError) || error.codigo !== 'DATOS_NO_VALIDOS') throw error;
    detalles.push(...error.detalles);
    return undefined;
  }
}

/**
 * Valida varios campos y los informa todos: ejecuta cada validación en el orden dado y, si alguna es 422, lanza UN solo 422
 * con los detalles de todas. Si todas pasan devuelve { campo: valor } (solo con los campos nombrados: lo que el cliente
 * envíe de más se descarta).
 * @param {Record<string, () => unknown>} validaciones
 */
function validarCampos(validaciones) {
  const detalles = [];
  const valores = {};
  for (const [campo, validar] of Object.entries(validaciones)) valores[campo] = recoger(detalles, validar);
  if (detalles.length > 0) throw e.datosNoValidos(detalles);
  return valores;
}

module.exports = {
  ENTERO_MAXIMO, entero, enteroQuery, fecha, enumerado, booleanoQuery, texto, cuerpoObjeto, idRuta, recoger, validarCampos,
};
