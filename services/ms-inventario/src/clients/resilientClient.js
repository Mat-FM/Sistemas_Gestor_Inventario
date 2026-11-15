const { e } = require('../errors');

// Cliente HTTP hacia otro servicio con las garantías de RNF18: espera máxima por intento, reintentos con esperas
// crecientes (solo en operaciones que no se duplican) y cortacircuitos. Solo usa fetch y AbortController nativos.

const SIN_REGISTRO = { info() {}, error() {} };

const dormirPorDefecto = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Un fallo del servicio destino (red, plazo, 5xx, redirección, respuesta defectuosa) devuelve { ok: false, … } y llega
// a e.noDisponible; un error de programación (ruta, cabeceras o cuerpo inválidos) lanza TypeError ANTES de empezar:
// no se reintenta, no cuenta para el cortacircuitos y no se disfraza de 503.
const falloReintentable = (motivo, extra = {}) => ({ ok: false, reintentable: true, motivo, ...extra });
const falloDefinitivo = (motivo, extra = {}) => ({ ok: false, reintentable: false, motivo, ...extra });

/** Base sin barras finales, o null si no es una URL http(s) utilizable (se detecta al llamar, no al construir). */
function normalizarBase(baseUrl) {
  if (typeof baseUrl !== 'string') return null;
  const base = baseUrl.trim().replace(/\/+$/, '');
  // Exige un nombre de servidor pegado al `//` (WHATWG URL acepta `http:///host` y lo corrige en silencio).
  if (!/^https?:\/\/[^/\s]/i.test(base)) return null;
  try {
    const url = new URL(base);
    // Una consulta o un fragmento en la base rompería la concatenación con la ruta.
    return url.search === '' && url.hash === '' ? base : null;
  } catch {
    return null;
  }
}

/** Cabeceras en minúsculas, con Accept fijo y sin valores nulos. new Headers lanza TypeError con nombres o valores inválidos (CR/LF). */
function armarCabeceras(headers, hayCuerpo) {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new TypeError('Las cabeceras deben ser un objeto');
  }
  const cabeceras = new Headers();
  for (const [nombre, valor] of Object.entries(headers)) {
    if (valor === undefined || valor === null) continue;
    if (typeof valor !== 'string' && typeof valor !== 'number') {
      throw new TypeError(`El valor de la cabecera ${nombre} debe ser texto o número`);
    }
    try {
      cabeceras.set(nombre, String(valor));
    } catch {
      // Headers rechaza nombres y valores con saltos de línea u otros caracteres prohibidos. El mensaje no cita el valor (puede ser un dato del cliente).
      throw new TypeError(`La cabecera ${JSON.stringify(nombre)} tiene un nombre o un valor no válido`);
    }
  }
  // Van al final para que el llamador no pueda cambiarlos.
  cabeceras.set('Accept', 'application/json');
  if (hayCuerpo) cabeceras.set('Content-Type', 'application/json');
  return Object.fromEntries(cabeceras.entries());
}

function serializarCuerpo(body) {
  let texto;
  try {
    texto = JSON.stringify(body);
  } catch {
    throw new TypeError('El cuerpo no se puede serializar a JSON');
  }
  if (typeof texto !== 'string') throw new TypeError('El cuerpo no se puede serializar a JSON');
  return texto;
}

/** Valida y arma todo lo que no depende de la red. Lanza TypeError ante un error de programación. */
function prepararLlamada(metodo, ruta, headers, body) {
  if (typeof metodo !== 'string' || !/^[A-Z]+$/.test(metodo)) throw new TypeError('El método HTTP no es válido');
  // La ruta se concatena como texto: no empieza por "//" ni por un esquema, así que nunca puede cambiar el host.
  if (typeof ruta !== 'string' || !ruta.startsWith('/') || ruta.startsWith('//')) {
    throw new TypeError('La ruta debe empezar por "/" (y no por "//")');
  }
  const hayCuerpo = body !== undefined && body !== null;
  if (hayCuerpo && (metodo === 'GET' || metodo === 'HEAD')) throw new TypeError(`Un ${metodo} no lleva cuerpo`);
  const init = { method: metodo, headers: armarCabeceras(headers, hayCuerpo) };
  if (hayCuerpo) init.body = serializarCuerpo(body);
  return { ruta, init };
}

/** Causa breve y de solo texto para el registro (nunca el mensaje completo ni datos de la respuesta). */
function describirCausa(err) {
  const causa = err?.cause?.code ?? err?.code ?? err?.name;
  return typeof causa === 'string' ? causa.slice(0, 60) : 'desconocida';
}

/** Libera la conexión de una respuesta cuyo cuerpo no se va a leer. */
function descartarCuerpo(respuesta) {
  try {
    const cancelacion = respuesta.body?.cancel?.();
    if (cancelacion && typeof cancelacion.catch === 'function') cancelacion.catch(() => {});
  } catch {
    // el cuerpo ya estaba cerrado: nada que liberar
  }
}

/** JSON de un cuerpo de texto: '' → null; texto que no es JSON → undefined (distinto de un `null` válido). */
function leerJson(texto) {
  if (texto.trim() === '') return null;
  try {
    return JSON.parse(texto);
  } catch {
    return undefined;
  }
}

/**
 * @param {object} opciones
 * @param {string} opciones.baseUrl dirección del servicio destino (viene de una variable de entorno; si falta o no es válida el
 *   cliente se construye igual y cada llamada responde 503, para que /health pueda avisar de la configuración, D17)
 * @param {string} [opciones.nombre] nombre del servicio destino para los registros y el mensaje del 503 (sin él, no se revela el host)
 * @param {number} [opciones.timeoutMs] espera máxima POR INTENTO, hasta terminar de leer el cuerpo (RNF18)
 * @param {number[]} [opciones.backoffMs] esperas antes de cada reintento; su longitud es el máximo de reintentos
 * @param {number} [opciones.failureThreshold] llamadas fallidas seguidas que abren el circuito
 * @param {number} [opciones.openMs] tiempo que el circuito abierto no llama al destino
 * @param {Function} [opciones.fetchImpl] reemplazo de fetch (pruebas)
 * @param {Function} [opciones.now] reloj en milisegundos (pruebas)
 * @param {Function} [opciones.sleep] espera entre reintentos (pruebas)
 * @param {{info: Function, error: Function}} [opciones.logger]
 */
function createResilientClient({
  baseUrl,
  nombre,
  timeoutMs = 3000,
  backoffMs = [200, 400, 800],
  failureThreshold = 5,
  openMs = 30000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = dormirPorDefecto,
  logger,
} = {}) {
  // Una variable de entorno mal escrita (CALL_TIMEOUT_MS=abc llega como NaN) dejaría el plazo en 1 ms: se falla al arrancar.
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs debe ser un número de milisegundos mayor que 0');
  }

  const base = normalizarBase(baseUrl);
  const destino = nombre ?? (base === null ? 'servicio-sin-url' : new URL(base).host);
  const mensajeNoDisponible = nombre ? `El servicio ${nombre} no está disponible` : undefined;

  // ---- Estado del cortacircuitos (D15). Es POR INSTANCIA de cliente (un cliente por servicio destino, cada uno con su
  // circuito) y POR PROCESO: con varias copias del servicio (RNF05) cada una lleva su propio contador, y no hay ningún dato de
  // sesión ni de petición aquí. abiertoHasta es null con el circuito cerrado; pasado ese instante, solo UNA llamada
  // (pruebaEnCurso) lo cierra si tiene éxito o lo reabre si falla, y mientras vuela las demás se rechazan sin llamar. ----
  let fallosSeguidos = 0;
  let abiertoHasta = null;
  let pruebaEnCurso = false;

  // Un logger roto o ausente nunca tumba una llamada.
  function registrar(nivel, registro) {
    try {
      (logger ?? SIN_REGISTRO)[nivel](registro);
    } catch {
      // se ignora: registrar es secundario
    }
  }

  const noDisponible = () => e.noDisponible(mensajeNoDisponible);

  /**
   * Decide si la llamada puede salir. Devuelve true si será la llamada de prueba (el turno se reclama aquí, de forma síncrona,
   * antes de cualquier await: dos llamadas simultáneas no pueden reclamarlo a la vez) y lanza 503 sin llamar si el circuito
   * está abierto o ya hay una prueba en vuelo. Un rechazo no cuenta como fallo ni mueve abiertoHasta.
   */
  function admitir() {
    if (abiertoHasta === null) return false;
    if (now() < abiertoHasta || pruebaEnCurso) throw noDisponible();
    pruebaEnCurso = true;
    return true;
  }

  /** Anota el resultado de una llamada ya terminada (tras sus reintentos). */
  function anotarResultado(exito, esPrueba) {
    // Una llamada que salió con el circuito cerrado y termina cuando ya se abrió no decide nada: solo la de prueba lo cierra.
    if (!esPrueba && abiertoHasta !== null) return;
    if (exito) {
      fallosSeguidos = 0;
      if (abiertoHasta !== null) {
        abiertoHasta = null;
        registrar('info', { mensaje: 'Circuito cerrado', destino });
      }
      return;
    }
    fallosSeguidos += 1;
    // El contador no se reinicia al abrir: por eso una llamada de prueba que falla (esPrueba) siempre supera el umbral y reabre.
    if (fallosSeguidos >= failureThreshold) {
      abiertoHasta = now() + openMs;
      registrar('error', { mensaje: 'Circuito abierto', destino, fallos_seguidos: fallosSeguidos, espera_ms: openMs });
    }
  }

  /** Lee la respuesta entera: estado, y cuerpo si hace falta. Va dentro del plazo (ver intentar). */
  async function leerRespuesta(url, init, signal) {
    // redirect: 'manual' → un 3xx se devuelve tal cual (en Node con su estado real) y nunca se sigue.
    const respuesta = await fetchImpl(url, { ...init, signal, redirect: 'manual' });
    const estado = respuesta.status;
    if (!Number.isInteger(estado) || estado < 200) {
      descartarCuerpo(respuesta);
      return falloDefinitivo('estado_inesperado', { estado });
    }
    if (estado >= 500) {
      descartarCuerpo(respuesta);
      return falloReintentable('error_del_servicio', { estado });
    }
    if (estado >= 300 && estado < 400) {
      descartarCuerpo(respuesta);
      return falloDefinitivo('redireccion', { estado });
    }
    const body = leerJson(await respuesta.text());
    // Un 4xx es una respuesta del servicio (no un fallo) aunque su cuerpo no sea JSON; un 2xx sin JSON válido sí es defectuoso.
    if (estado >= 400) return { ok: true, status: estado, body: body === undefined ? null : body };
    if (body === undefined) return falloDefinitivo('respuesta_invalida', { estado });
    return { ok: true, status: estado, body };
  }

  /**
   * Un intento con su plazo. El temporizador corre hasta terminar de leer el cuerpo (un servidor que envía las cabeceras y
   * se calla no cuelga la llamada) y SIEMPRE se limpia. Se compite contra el plazo además de abortar: así vence aunque el
   * fetch ignore la señal.
   */
  async function intentar(url, init) {
    const controlador = new AbortController();
    let vencido = false;
    let temporizador;
    const plazo = new Promise((_resolver, rechazar) => {
      temporizador = setTimeout(() => {
        vencido = true;
        rechazar(new Error('plazo agotado'));
        controlador.abort();
      }, timeoutMs);
    });
    const trabajo = leerRespuesta(url, init, controlador.signal);
    // La que pierde la carrera puede rechazarse después (el aborto hace fallar al fetch): sin esto sería un rechazo sin manejar.
    plazo.catch(() => {});
    trabajo.catch(() => {});
    try {
      return await Promise.race([trabajo, plazo]);
    } catch (err) {
      return falloReintentable(vencido ? 'tiempo_agotado' : 'red', { causa: describirCausa(err) });
    } finally {
      clearTimeout(temporizador);
    }
  }

  /**
   * @param {string} metodo GET, POST…
   * @param {string} ruta empieza por "/" (p. ej. /productos/3); se une a baseUrl como texto
   * @param {{headers?: object, body?: *, reintentable?: boolean}} [opciones]
   *   headers: SOLO estas cabeceras viajan (más Accept y, con body, Content-Type); body: se serializa a JSON.
   *   reintentable: true únicamente en operaciones que no se duplican (lecturas).
   * @returns {Promise<{status: number, body: *}>} cualquier 2xx o 4xx; body es el JSON o null si no hay cuerpo.
   * @throws {TypeError} error de programación (ruta, cabeceras, cuerpo o método inválidos)
   * @throws {AppError} 503 SERVICIO_NO_DISPONIBLE ante red, plazo, 5xx, 3xx, respuesta defectuosa o circuito abierto
   */
  async function request(metodo, ruta, { headers = {}, body, reintentable = false } = {}) {
    const { ruta: rutaFinal, init } = prepararLlamada(metodo, ruta, headers, body);
    if (base === null) {
      registrar('error', { mensaje: 'La URL del servicio destino no está configurada o no es válida', destino });
      throw noDisponible();
    }
    const url = `${base}${rutaFinal}`;
    if (new URL(url).origin !== new URL(base).origin) throw new TypeError('La ruta cambia el origen de la llamada');

    const esPrueba = admitir();
    try {
      const maximoDeIntentos = reintentable ? backoffMs.length + 1 : 1;
      let intentos = 0;
      let resultado;
      do {
        if (intentos > 0) await sleep(backoffMs[intentos - 1]);
        intentos += 1;
        resultado = await intentar(url, init);
      } while (!resultado.ok && resultado.reintentable && intentos < maximoDeIntentos);

      if (resultado.ok) {
        anotarResultado(true, esPrueba);
        return { status: resultado.status, body: resultado.body };
      }

      // Campos de texto y nada más: sin cabeceras, cuerpos de respuesta ni la consulta de la ruta.
      registrar('error', {
        mensaje: 'Llamada a otro servicio fallida',
        destino,
        metodo,
        ruta: rutaFinal.split('?')[0],
        motivo: resultado.motivo,
        ...(resultado.estado === undefined ? {} : { estado: resultado.estado }),
        ...(resultado.causa === undefined ? {} : { causa: resultado.causa }),
        intentos,
      });
      anotarResultado(false, esPrueba);
      throw noDisponible();
    } finally {
      // Si algo inesperado interrumpe la prueba (p. ej. un sleep que lanza), el turno se libera: no queda semiabierto para siempre.
      if (esPrueba) pruebaEnCurso = false;
    }
  }

  return { request };
}

module.exports = { createResilientClient };
