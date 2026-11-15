const { conRastreo, rastrearTemporizadores } = require('./helpers/temporizadores');

// El medidor de temporizadores (tests/helpers/temporizadores.js) que usan resilientClient.test.js y resilientClientHttp.test.js:
// cuenta SOLO los temporizadores que crea el código bajo prueba dentro de su ventana, con el retardo pedido, y dice cuáles siguen
// vivos (ni limpiados ni disparados). Aquí se prueba el medidor mismo: si mintiera, las pruebas de limpieza pasarían en vacío.

const dormir = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });
// Los originales, para comprobar que el medidor los devuelve (la identidad exacta, no una copia).
const setTimeoutOriginal = globalThis.setTimeout;
const clearTimeoutOriginal = globalThis.clearTimeout;
const PLAZO_LARGO = 60_000; // que nada dispare durante la prueba: un temporizador vivo se ve como vivo

describe('rastrearTemporizadores', () => {
  const pendientes = [];
  afterEach(() => {
    // Todo temporizador largo que una prueba deje a propósito se limpia aquí: ninguna prueba deja el proceso con algo vivo.
    for (const manija of pendientes.splice(0)) clearTimeoutOriginal(manija);
    expect(globalThis.setTimeout).toBe(setTimeoutOriginal);
    expect(globalThis.clearTimeout).toBe(clearTimeoutOriginal);
  });
  const largo = () => {
    const manija = setTimeout(() => {}, PLAZO_LARGO);
    pendientes.push(manija);
    return manija;
  };

  it('un temporizador que el código crea dentro de la ventana y NO limpia ni dispara se cuenta como creado y VIVO', async () => {
    await conRastreo(PLAZO_LARGO, async (rastro) => {
      expect({ creados: rastro.creados(), vivos: rastro.vivos() }).toEqual({ creados: 0, vivos: 0 }); // control: empieza en cero
      largo();
      expect({ creados: rastro.creados(), vivos: rastro.vivos(), disparados: rastro.disparados() }).toEqual({ creados: 1, vivos: 1, disparados: 0 });
    });
  });

  it('uno que se limpia con clearTimeout deja de estar vivo (pero sigue contando como creado)', async () => {
    await conRastreo(PLAZO_LARGO, async (rastro) => {
      const manija = largo();
      expect(rastro.vivos()).toBe(1); // control: antes de limpiarlo, vivo
      clearTimeout(manija);
      expect({ creados: rastro.creados(), vivos: rastro.vivos() }).toEqual({ creados: 1, vivos: 0 });
    });
  });

  it('uno que dispara deja de estar vivo y se cuenta como disparado; su callback sí se ejecuta con sus argumentos', async () => {
    await conRastreo(5, async (rastro) => {
      const llamadas = [];
      setTimeout((a, b) => llamadas.push([a, b]), 5, 'uno', 'dos');
      expect(rastro.vivos()).toBe(1); // control: mientras espera, vivo
      await dormir(40); // otro retardo (40): no cuenta
      expect(llamadas).toEqual([['uno', 'dos']]);
      expect({ creados: rastro.creados(), vivos: rastro.vivos(), disparados: rastro.disparados() }).toEqual({ creados: 1, vivos: 0, disparados: 1 });
    });
  });

  it('un temporizador AJENO no cuenta: creado ANTES de la ventana, con OTRO retardo, o DESPUÉS de restaurar', async () => {
    const anterior = largo(); // mismo retardo, pero creado antes de la ventana
    const rastro = rastrearTemporizadores({ retardo: PLAZO_LARGO });
    rastro.iniciar();
    try {
      const otroRetardo = setTimeout(() => {}, PLAZO_LARGO + 1); // dentro de la ventana, con otro retardo
      pendientes.push(otroRetardo);
      expect({ creados: rastro.creados(), vivos: rastro.vivos() }).toEqual({ creados: 0, vivos: 0 });
      const propio = largo(); // control: uno que SÍ cuenta
      expect({ creados: rastro.creados(), vivos: rastro.vivos() }).toEqual({ creados: 1, vivos: 1 });
      clearTimeout(anterior); // limpiar uno ajeno no altera la cuenta del propio
      expect(rastro.vivos()).toBe(1);
      clearTimeout(propio);
    } finally {
      rastro.restaurar();
    }
    largo(); // después de restaurar: ya no se rastrea
    expect(rastro.creados()).toBe(1);
  });

  it('limpiar un temporizador que no es del rastreo no lo marca ni lanza, y un clearTimeout(undefined) sigue siendo inocuo', async () => {
    await conRastreo(PLAZO_LARGO, async (rastro) => {
      const propio = largo();
      expect(() => clearTimeout(undefined)).not.toThrow();
      expect(() => clearTimeout(null)).not.toThrow();
      expect(rastro.vivos()).toBe(1);
      clearTimeout(propio);
      expect(rastro.vivos()).toBe(0);
    });
  });

  it('restaura setTimeout y clearTimeout AUNQUE la llamada lance, y conRastreo propaga el error original', async () => {
    const causa = new Error('la llamada falló');
    await expect(conRastreo(PLAZO_LARGO, async () => {
      expect(globalThis.setTimeout).not.toBe(setTimeoutOriginal); // control: dentro de la ventana está parcheado
      expect(globalThis.clearTimeout).not.toBe(clearTimeoutOriginal);
      throw causa;
    })).rejects.toBe(causa);
    expect(globalThis.setTimeout).toBe(setTimeoutOriginal);
    expect(globalThis.clearTimeout).toBe(clearTimeoutOriginal);
  });

  it('restaurar es idempotente y devuelve los originales; el rastro sigue consultable tras restaurar', async () => {
    const rastro = rastrearTemporizadores({ retardo: PLAZO_LARGO });
    rastro.iniciar();
    largo();
    rastro.restaurar();
    rastro.restaurar();
    expect(globalThis.setTimeout).toBe(setTimeoutOriginal);
    expect(globalThis.clearTimeout).toBe(clearTimeoutOriginal);
    expect({ creados: rastro.creados(), vivos: rastro.vivos() }).toEqual({ creados: 1, vivos: 1 });
  });

  it('el temporizador sigue siendo el de Node: se le puede hacer unref y limpiar con el clearTimeout original', async () => {
    await conRastreo(PLAZO_LARGO, async (rastro) => {
      const manija = setTimeout(() => {}, PLAZO_LARGO);
      expect(typeof manija.unref).toBe('function');
      manija.unref();
      clearTimeoutOriginal(manija); // con el original, no el parcheado: el medidor no lo ve limpiado
      expect(rastro.creados()).toBe(1);
    });
  });

  it('errores de programación: iniciar dos veces sin restaurar, y un retardo que no sea un entero positivo', () => {
    const rastro = rastrearTemporizadores({ retardo: 10 });
    rastro.iniciar();
    try {
      expect(() => rastro.iniciar()).toThrow(/ya está iniciado/);
    } finally {
      rastro.restaurar();
    }
    for (const invalido of [0, -1, 1.5, '10', NaN, undefined, null]) {
      expect(() => rastrearTemporizadores({ retardo: invalido })).toThrow(TypeError);
    }
    expect(globalThis.setTimeout).toBe(setTimeoutOriginal);
  });
});
