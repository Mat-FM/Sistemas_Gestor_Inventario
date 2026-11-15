const { AsyncLocalStorage } = require('node:async_hooks');
const { SERVICIO } = require('./config/env');

// El request_id de la petición en curso vive en un AsyncLocalStorage: nada se comparte entre peticiones (RNF05) y el
// logger lo añade a TODA línea que se escribe durante la petición, también las de error y las advertencias de los
// clientes de otros servicios (D19). Una variable de módulo mezclaría identificadores de peticiones concurrentes.
const contexto = new AsyncLocalStorage();

/** Ejecuta `funcion` (y todo lo asíncrono que nazca de ella) con ese request_id como contexto. */
function ejecutarEnPeticion(requestId, funcion) {
  return contexto.run({ requestId }, funcion);
}

/** request_id de la petición en curso, o undefined fuera de toda petición. */
function requestIdActual() {
  return contexto.getStore()?.requestId;
}

// Un registro JSON por línea (RNF10). Cada método recibe un único objeto con los campos del registro.
function escribir(nivel, registro) {
  // `servicio` y `nivel` van después del spread: un registro no puede sobrescribirlos.
  const linea = { ...registro, servicio: SERVICIO, nivel };
  // El contexto solo rellena el request_id que el registro no trae (o trae vacío).
  linea.request_id ??= requestIdActual();
  process.stdout.write(`${JSON.stringify(linea)}\n`);
}

const logger = {
  info: (registro) => escribir('info', registro),
  error: (registro) => escribir('error', registro),
};

module.exports = { logger, ejecutarEnPeticion, requestIdActual };
