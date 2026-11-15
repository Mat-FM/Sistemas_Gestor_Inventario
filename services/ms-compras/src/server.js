// Punto de entrada: aplica las migraciones pendientes y abre el puerto.
const config = require('./config');
const logger = require('./logger');
const { pool } = require('./config/db');
const { migrar } = require('../scripts/migrar');
const { crearApp } = require('./app');

async function iniciar() {
  await migrar({ silencioso: true });
  const servidor = crearApp().listen(config.puerto, () => {
    logger.info('servicio iniciado', { puerto: config.puerto });
  });

  // Al detener el contenedor se terminan las peticiones en curso antes de cerrar.
  const apagar = (senal) => {
    logger.info('apagando', { senal });
    servidor.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);
}

iniciar().catch((error) => {
  logger.error('no se pudo iniciar', { error: error.message });
  process.exit(1);
});
