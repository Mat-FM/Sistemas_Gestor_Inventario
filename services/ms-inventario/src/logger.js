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

// El logger NUNCA lanza (Ruling 13): se llama desde el manejador de errores y desde listeners de eventos, donde una
// excepción tumbaría el proceso o dejaría que Express responda con la traza (D18).

/**
 * Reemplazo de JSON.stringify para UNA llamada: los BigInt salen como texto y un objeto que ya es ancestro de sí mismo
 * sale como "[Circular]". Se lleva la cadena de ancestros (no un conjunto de «objetos ya vistos»), para que una
 * referencia compartida que no es un ciclo se escriba completa las dos veces. El estado nace y muere con la llamada.
 */
function crearReemplazo() {
  const ancestros = [];
  // Función normal (no flecha): `this` es el objeto que contiene la propiedad que se está escribiendo.
  return function reemplazo(_clave, valor) {
    if (typeof valor === 'bigint') return valor.toString();
    if (typeof valor !== 'object' || valor === null) return valor;
    while (ancestros.length > 0 && ancestros[ancestros.length - 1] !== this) ancestros.pop();
    if (ancestros.includes(valor)) return '[Circular]';
    ancestros.push(valor);
    return valor;
  };
}

function serializar(nivel, registro) {
  // `servicio` y `nivel` van después del spread: un registro no puede sobrescribirlos.
  const linea = { ...registro, servicio: SERVICIO, nivel };
  // El contexto solo rellena el request_id que el registro no trae (o trae vacío).
  linea.request_id ??= requestIdActual();
  const texto = JSON.stringify(linea, crearReemplazo());
  // Un toJSON propio puede hacer que stringify devuelva undefined en vez de texto.
  if (typeof texto !== 'string') throw new TypeError('El registro no se pudo serializar');
  return texto;
}

// request_id para la línea de respaldo: el explícito del registro si es texto (leerlo puede lanzar: un getter) y, si no, el del contexto.
function requestIdParaRespaldo(registro) {
  try {
    const id = registro?.request_id;
    if (typeof id === 'string' && id !== '') return id;
  } catch {
    // un getter que lanza: se usa el del contexto
  }
  return requestIdActual();
}

// Línea mínima y siempre serializable: no vuelca nada del contenido que falló. Los campos fijos van al final (como en
// serializar) y, sin request_id, JSON.stringify omite la propiedad.
function lineaDeRespaldo(nivel, registro) {
  return JSON.stringify({ request_id: requestIdParaRespaldo(registro), aviso: 'registro_no_serializable', servicio: SERVICIO, nivel });
}

// Escribir en una tubería cerrada (EPIPE) no lanza: Node lo notifica después, como evento 'error' de process.stdout, y
// sin ningún listener es una excepción no capturada. Si stdout no sirve no hay dónde registrar, así que se ignora.
// La marca evita acumular un listener por cada registro de módulos (por ejemplo, uno por archivo de pruebas de Jest).
const MARCA_STDOUT = Symbol.for('ms-inventario.logger.stdout-error');
if (!process.stdout[MARCA_STDOUT]) {
  process.stdout[MARCA_STDOUT] = true;
  process.stdout.on('error', () => {});
}

// Un registro JSON por línea (RNF10). Cada método recibe un único objeto con los campos del registro.
function escribir(nivel, registro) {
  let texto;
  try {
    texto = serializar(nivel, registro);
  } catch {
    texto = lineaDeRespaldo(nivel, registro);
  }
  try {
    process.stdout.write(`${texto}\n`);
  } catch {
    // el logger nunca propaga un fallo de escritura
  }
}

const logger = {
  info: (registro) => escribir('info', registro),
  error: (registro) => escribir('error', registro),
};

module.exports = { logger, ejecutarEnPeticion, requestIdActual };
