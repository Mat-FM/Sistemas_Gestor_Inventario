// Configuración del servicio. Todo sale de variables de entorno (RNF14): no hay direcciones ni credenciales en el código.

const SERVICIO = 'ms-inventario';

/** Error de configuración (una variable de entorno con un valor inválido): se registra por su nombre y mensaje, sin pila. */
class ErrorDeConfiguracion extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorDeConfiguracion';
  }
}

// Plazo de cada llamada a otro servicio (CALL_TIMEOUT_MS, RNF18). ÚNICO sitio donde vive el rango: lo usan cargarConfig (el texto de
// la variable) y createResilientClient (el número). Por encima de 2^31-1 ms setTimeout se desborda y espera 1 ms; 60 s ya es mucho
// más que el RNF18 (3 s) y que cualquier tiempo de espera razonable de un cliente del Gateway.
const PLAZO_MIN_MS = 1;
const PLAZO_MAX_MS = 60000;

const plazoValido = (valor) => Number.isInteger(valor) && valor >= PLAZO_MIN_MS && valor <= PLAZO_MAX_MS;

function describirValor(valor) {
  try {
    return typeof valor === 'string' ? JSON.stringify(valor.slice(0, 50)) : String(valor);
  } catch {
    return '[valor no representable]';
  }
}

/** Mensaje de un plazo inválido; nombra la variable (no solo el parámetro) y el valor recibido, que no es secreto. */
function mensajePlazoInvalido(valor, nombre = 'CALL_TIMEOUT_MS') {
  return `${nombre} debe ser un número entero de milisegundos entre ${PLAZO_MIN_MS} y ${PLAZO_MAX_MS} (recibido: ${describirValor(valor)})`;
}

// Variables sin las que el servicio no puede trabajar. /health responde 503 si falta alguna o si una URL no es válida (D17).
const VARIABLES_OBLIGATORIAS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'MS_CATALOGO_URL', 'MS_NOTIFICACIONES_URL'];
const VARIABLES_URL = ['MS_CATALOGO_URL', 'MS_NOTIFICACIONES_URL'];

// Una variable vacía o solo con espacios cuenta como ausente.
function estaDefinida(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

function esUrlHttp(valor) {
  // Exige un nombre de servidor pegado al `//`: WHATWG URL acepta `https:///host` y lo corrige en silencio.
  if (!/^https?:\/\/[^/\s]/i.test(valor.trim())) return false;
  try {
    return new URL(valor.trim()).hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Revisa el entorno tal como llega (con los nombres literales, sin sustituir DB_NAME por TEST_DB_NAME).
 * Devuelve los NOMBRES de las variables que faltan y de las URL inválidas; nunca sus valores.
 */
function validarEntorno(env = process.env) {
  const faltantes = VARIABLES_OBLIGATORIAS.filter((nombre) => !estaDefinida(env[nombre]));
  const invalidas = VARIABLES_URL.filter((nombre) => estaDefinida(env[nombre]) && !esUrlHttp(env[nombre]));
  return { faltantes, invalidas };
}

// CALL_TIMEOUT_MS: ausente → 3000. Definida, tiene que ser un entero decimal entre PLAZO_MIN_MS y PLAZO_MAX_MS: una variable vacía,
// con decimales, en notación científica o fuera de rango es un error (Number('abc') daría NaN y setTimeout lo tomaría como 1 ms).
function leerPlazo(valor, porDefecto) {
  if (valor === undefined) return porDefecto;
  const texto = String(valor).trim();
  const plazo = /^[0-9]+$/.test(texto) ? Number(texto) : NaN;
  if (!plazoValido(plazo)) throw new ErrorDeConfiguracion(mensajePlazoInvalido(valor));
  return plazo;
}

// Se lee al arrancar (no al importar el módulo), para que las pruebas puedan pasar su propio entorno.
function cargarConfig(env = process.env) {
  // Con NODE_ENV=test no hay vuelta atrás a DB_NAME: sin base de pruebas se falla aquí, con un mensaje claro, y no más tarde con `database: undefined`.
  if (env.NODE_ENV === 'test' && !estaDefinida(env.TEST_DB_NAME)) {
    throw new Error('NODE_ENV=test requiere TEST_DB_NAME: las pruebas usan su propia base (cuyo nombre termina en _test) y nunca la de desarrollo.');
  }
  const numero = (valor, porDefecto) => (estaDefinida(valor) ? Number(valor) : porDefecto);
  return {
    servicio: SERVICIO,
    puerto: numero(env.PORT, 3000),
    db: {
      host: env.DB_HOST,
      port: numero(env.DB_PORT, undefined),
      // Con NODE_ENV=test el servicio nunca toca la base de desarrollo: usa la de pruebas (D21).
      database: env.NODE_ENV === 'test' ? env.TEST_DB_NAME : env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
    },
    catalogoUrl: env.MS_CATALOGO_URL,
    notificacionesUrl: env.MS_NOTIFICACIONES_URL,
    // Espera máxima por llamada a otro servicio (RNF18).
    callTimeoutMs: leerPlazo(env.CALL_TIMEOUT_MS, 3000),
  };
}

module.exports = {
  SERVICIO,
  VARIABLES_OBLIGATORIAS,
  PLAZO_MIN_MS,
  PLAZO_MAX_MS,
  ErrorDeConfiguracion,
  plazoValido,
  mensajePlazoInvalido,
  cargarConfig,
  validarEntorno,
};
