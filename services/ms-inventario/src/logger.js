const { SERVICIO } = require('./config/env');

// Un registro JSON por línea (RNF10). Cada método recibe un único objeto con los campos del registro.
function escribir(nivel, registro) {
  process.stdout.write(`${JSON.stringify({ servicio: SERVICIO, nivel, ...registro })}\n`);
}

const logger = {
  info: (registro) => escribir('info', registro),
  error: (registro) => escribir('error', registro),
};

module.exports = { logger };
