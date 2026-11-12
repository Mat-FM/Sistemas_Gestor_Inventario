// Configuración leída del entorno (RNF14): nada de direcciones ni contraseñas escritas en el código.

function entero(nombre, porDefecto) {
  const valor = process.env[nombre];
  if (valor === undefined || valor === '') return porDefecto;
  const numero = Number.parseInt(valor, 10);
  if (Number.isNaN(numero)) throw new Error(`La variable ${nombre} debe ser un número`);
  return numero;
}

const config = {
  servicio: process.env.SERVICE_NAME || 'ms-compras',
  puerto: entero('PORT', 3000),
  nivelLog: process.env.LOG_LEVEL || 'info',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: entero('DB_PORT', 5434),
    database: process.env.DB_NAME || 'compras_db',
    user: process.env.DB_USER || 'compras',
    password: process.env.DB_PASSWORD || 'change_me',
    max: entero('DB_POOL_MAX', 10),
  },

  servicios: {
    inventario: process.env.MS_INVENTARIO_URL || 'http://ms-inventario:3000',
    notificaciones: process.env.MS_NOTIFICACIONES_URL || 'http://ms-notificaciones:5000',
  },

  // Llamadas entre servicios (RNF18): espera máxima, reintentos y cortacircuito.
  llamadas: {
    timeoutMs: entero('CALL_TIMEOUT_MS', 3000),
    esperasReintentoMs: [200, 400, 800],
    fallosParaAbrir: 5,
    tiempoAbiertoMs: 30000,
  },
};

module.exports = config;
