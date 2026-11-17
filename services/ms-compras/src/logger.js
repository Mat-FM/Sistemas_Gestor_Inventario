// Registros en formato JSON, una línea por evento, a la salida estándar (RNF10).
// Se leen con `docker logs ms-compras` o `docker compose logs ms-compras`.
const config = require('./config');

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };
const minimo = NIVELES[config.nivelLog] ?? NIVELES.info;

function escribir(nivel, mensaje, datos = {}) {
  if (NIVELES[nivel] < minimo || process.env.NODE_ENV === 'test') return;
  const linea = {
    fecha: new Date().toISOString(),
    nivel,
    servicio: config.servicio,
    mensaje,
    ...datos,
  };
  const salida = nivel === 'error' || nivel === 'warn' ? process.stderr : process.stdout;
  salida.write(`${JSON.stringify(linea)}\n`);
}

module.exports = {
  debug: (m, d) => escribir('debug', m, d),
  info: (m, d) => escribir('info', m, d),
  warn: (m, d) => escribir('warn', m, d),
  error: (m, d) => escribir('error', m, d),
};
