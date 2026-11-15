// Configuración del servicio. Todo sale de variables de entorno (RNF14): no hay direcciones ni credenciales en el código.

const SERVICIO = 'ms-inventario';

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

// Se lee al arrancar (no al importar el módulo), para que las pruebas puedan pasar su propio entorno.
function cargarConfig(env = process.env) {
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
    callTimeoutMs: numero(env.CALL_TIMEOUT_MS, 3000),
  };
}

module.exports = { SERVICIO, VARIABLES_OBLIGATORIAS, cargarConfig, validarEntorno };
