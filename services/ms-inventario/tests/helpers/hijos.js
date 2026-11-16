// Higiene de las pruebas con procesos hijos y plazos (ÚNICA fuente): un hijo sin plazo propio vive hasta que Knex se rinde (60 s)
// si la base no responde, y un `setTimeout` de un Promise.race que nadie cancela mantiene vivo el temporizador tras la prueba.
// Probado en tests/hijos.test.js.
const { execFile, spawn } = require('node:child_process');

// Menos que el plazo de cada prueba de Jest (30 s, jest.config.js): si el hijo se cuelga, la prueba falla con SU mensaje y no
// con el genérico de Jest, y el hijo ya está muerto.
const PLAZO_HIJO_MS = 20000;

/**
 * Ejecuta `node <argumentos>` como proceso hijo con un plazo propio. Si no termina en `plazoMs` se le manda SIGKILL (no se puede
 * ignorar) y la promesa RECHAZA con un mensaje claro: nunca pasa en silencio ni deja el hijo vivo.
 * - Éxito: resuelve `{ stdout, stderr }` (texto).
 * - Salida con error: rechaza con el mensaje de Node y el stderr del hijo.
 * - Plazo vencido: rechaza «El proceso hijo no terminó en N ms y se mató con SIGKILL»; el error lleva `stdout` y `stderr`.
 * @param {string[]} argumentos los de `node` (p. ej. `['-e', guion, ...]`)
 * @param {{env?: object, cwd?: string, plazoMs?: number}} [opciones]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function ejecutarHijo(argumentos, { env, cwd, plazoMs = PLAZO_HIJO_MS } = {}) {
  return new Promise((resolver, rechazar) => {
    execFile(process.execPath, argumentos, { env, cwd, encoding: 'utf8', timeout: plazoMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (!error) {
        resolver({ stdout, stderr });
        return;
      }
      const causa = error.killed
        ? new Error(`El proceso hijo no terminó en ${plazoMs} ms y se mató con SIGKILL (¿la base no responde?)\n${stderr}`)
        : new Error(`${error.message}\n${stderr}`);
      Object.assign(causa, { stdout, stderr });
      rechazar(causa);
    });
  });
}

/**
 * Lanza `node <argumentos>` como proceso hijo SIN esperar a que termine: para las pruebas que le mandan una señal a mitad (SIGTERM)
 * o leen su salida mientras vive, que `ejecutarHijo` no permite. Lleva SIEMPRE un plazo propio (`plazoMs`, 20 s por defecto) desde que
 * nace: si para entonces no ha cerrado se le manda SIGKILL y `cierre` RECHAZA con el mismo mensaje que `ejecutarHijo`, así que ni queda
 * vivo ni la prueba espera hasta el plazo de Jest. El temporizador se cancela en cuanto el hijo cierra.
 * - `stdout` y `stderr` se van llenando mientras el hijo vive; `codigo` y `senal` quedan fijados al cerrar.
 * - `cierre` resuelve con este mismo objeto cuando el hijo cierra dentro del plazo, sea cual sea su código (quien llama lo comprueba).
 * - Quien lanza el hijo debe matarlo en un `finally`: si la prueba falla antes de esperar el cierre, el plazo es la última defensa.
 * @param {string[]} argumentos los de `node` (p. ej. `[rutaDelServidor]`)
 * @param {{env?: object, cwd?: string, plazoMs?: number}} [opciones]
 * @returns {{hijo: import('node:child_process').ChildProcess, stdout: string, stderr: string, codigo?: number|null, senal?: string|null, cierre: Promise<object>}}
 */
function lanzarHijo(argumentos, { env, cwd, plazoMs = PLAZO_HIJO_MS } = {}) {
  const hijo = spawn(process.execPath, argumentos, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const proceso = { hijo, stdout: '', stderr: '', codigo: undefined, senal: undefined };
  let agotado = false;
  const temporizador = setTimeout(() => {
    agotado = true;
    hijo.kill('SIGKILL');
  }, plazoMs);
  hijo.stdout.on('data', (trozo) => { proceso.stdout += trozo; });
  hijo.stderr.on('data', (trozo) => { proceso.stderr += trozo; });
  proceso.cierre = new Promise((resolver, rechazar) => {
    hijo.once('error', (error) => { // no se pudo ni lanzar: no habrá 'close'
      clearTimeout(temporizador);
      rechazar(error);
    });
    hijo.once('close', (codigo, senal) => {
      clearTimeout(temporizador);
      proceso.codigo = codigo;
      proceso.senal = senal;
      if (agotado) rechazar(new Error(`El proceso hijo no terminó en ${plazoMs} ms y se mató con SIGKILL\nstdout: ${proceso.stdout}\nstderr: ${proceso.stderr}`));
      else resolver(proceso);
    });
  });
  proceso.cierre.catch(() => {}); // si nadie la espera cuando vence el plazo, no es un rechazo sin manejar
  return proceso;
}

// Lo que devuelve esperarConPlazo cuando vence el plazo: un símbolo, que ninguna promesa real puede devolver.
const AGOTADO = Symbol('plazo agotado');

/**
 * `Promise.race` entre `promesa` y un plazo de `ms`: devuelve lo que dé la promesa, o AGOTADO si vence antes. El temporizador se
 * cancela SIEMPRE (también si la promesa rechaza), así que no queda vivo tras la prueba. No cancela la promesa: quien la creó
 * debe liberar lo que la mantenga pendiente (un bloqueo de fila, una conexión).
 * @template T
 * @param {Promise<T>} promesa
 * @param {number} ms
 * @returns {Promise<T | typeof AGOTADO>}
 */
async function esperarConPlazo(promesa, ms) {
  let temporizador;
  const plazo = new Promise((resolver) => { temporizador = setTimeout(() => resolver(AGOTADO), ms); });
  try {
    return await Promise.race([promesa, plazo]);
  } finally {
    clearTimeout(temporizador);
  }
}

module.exports = { AGOTADO, PLAZO_HIJO_MS, ejecutarHijo, lanzarHijo, esperarConPlazo };
