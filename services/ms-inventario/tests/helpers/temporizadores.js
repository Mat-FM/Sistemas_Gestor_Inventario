// Medidor de los temporizadores que crea el CÓDIGO BAJO PRUEBA (ÚNICA fuente; probado en tests/temporizadores.test.js). Lo usan las
// pruebas del cliente resiliente para comprobar que su temporizador de plazo SIEMPRE se limpia (RNF18).
//
// Por qué no contar los `Timeout` de `process.getActiveResourcesInfo()`: esa lista es del PROCESO entero. Con `--runInBand` todas
// las suites comparten proceso, y Jest, `fetch` (undici) y Node crean y destruyen sus propios temporizadores en cualquier momento:
// «antes == después» fallaba al azar (Expected 2, Received 3), más con la caché fría o en una CI lenta.
//
// REGLA: un temporizador es del código bajo prueba si (1) se creó con `setTimeout` DESDE EL CÓDIGO DE LA SUITE (el global del
// sandbox de Jest, que es el que parchea este medidor) (2) DENTRO de la ventana (entre `iniciar()` y `restaurar()`) y (3) con el
// retardo pedido (el `timeoutMs` con el que el cliente arma su plazo). Es inmune a lo de fuera porque:
//   · Jest, undici/fetch y los internos de Node corren fuera del sandbox y NUNCA pasan por el `setTimeout` parcheado;
//   · los temporizadores de otras suites o creados antes de la ventana no se ven (solo se registran los que nacen dentro);
//   · los de la propia prueba con otro retardo (un `dormir(30)`, el `sleep` de los reintentos) no cuadran con el retardo.
// Un temporizador está VIVO si no se limpió con `clearTimeout` ni disparó (se envuelve el callback para saber si disparó).
// El parche vive solo durante la ventana y se restaura siempre (conRastreo lo hace en un `finally`).

/**
 * @param {{retardo: number}} opciones el retardo, en ms, de los temporizadores a rastrear (entero positivo)
 * @returns {{iniciar(): void, restaurar(): void, creados(): number, vivos(): number, disparados(): number}}
 */
function rastrearTemporizadores({ retardo } = {}) {
  if (!Number.isSafeInteger(retardo) || retardo < 1) throw new TypeError('rastrearTemporizadores exige `retardo`, un entero positivo de ms');
  const registros = [];
  const porManija = new Map();
  let originales = null;

  function iniciar() {
    if (originales) throw new Error('El rastreo ya está iniciado: restaurar() antes de volver a iniciar');
    const { setTimeout: setTimeoutReal, clearTimeout: clearTimeoutReal } = globalThis;
    originales = { setTimeout: setTimeoutReal, clearTimeout: clearTimeoutReal };

    globalThis.setTimeout = function setTimeoutRastreado(callback, ms, ...argumentos) {
      if (typeof callback !== 'function' || ms !== retardo) return setTimeoutReal.call(this, callback, ms, ...argumentos);
      const registro = { disparado: false, limpiado: false };
      const manija = setTimeoutReal.call(this, function disparo(...recibidos) {
        registro.disparado = true; // antes del callback: si lanza, igual disparó
        return callback.apply(this, recibidos);
      }, ms, ...argumentos);
      registros.push(registro);
      porManija.set(manija, registro);
      return manija;
    };
    globalThis.clearTimeout = function clearTimeoutRastreado(manija) {
      const registro = porManija.get(manija);
      if (registro) registro.limpiado = true;
      return clearTimeoutReal.call(this, manija);
    };
  }

  function restaurar() {
    if (!originales) return;
    globalThis.setTimeout = originales.setTimeout;
    globalThis.clearTimeout = originales.clearTimeout;
    originales = null;
  }

  return {
    iniciar,
    restaurar,
    creados: () => registros.length,
    vivos: () => registros.filter((registro) => !registro.disparado && !registro.limpiado).length,
    disparados: () => registros.filter((registro) => registro.disparado).length,
  };
}

/**
 * Rastrea los temporizadores de `retardo` ms que cree `cuerpo(rastro)` y restaura SIEMPRE los globales (también si `cuerpo`
 * lanza o rechaza, y el error se propaga tal cual). Devuelve el rastro para consultarlo después.
 * @param {number} retardo
 * @param {(rastro: ReturnType<typeof rastrearTemporizadores>) => Promise<void>|void} cuerpo
 */
async function conRastreo(retardo, cuerpo) {
  const rastro = rastrearTemporizadores({ retardo });
  rastro.iniciar();
  try {
    await cuerpo(rastro);
  } finally {
    rastro.restaurar();
  }
  return rastro;
}

module.exports = { conRastreo, rastrearTemporizadores };
