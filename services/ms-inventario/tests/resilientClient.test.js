const { AppError } = require('../src/errors');
const { createResilientClient } = require('../src/clients/resilientClient');

// Pruebas del cliente HTTP resiliente (RNF18) con fetch, sleep y reloj falsos: son deterministas y no tocan el reloj global.
// Solo las de plazo usan temporizadores reales, con plazos de milisegundos. La suite con un servidor HTTP real está en
// resilientClientHttp.test.js.

const BASE = 'http://servicio-falso:8000';

const json = (status, cuerpo) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });
const texto = (status, cuerpo) => new Response(cuerpo, { status });
const vacia = (status) => new Response(null, { status });
const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * fetch falso: la llamada n consume el paso n y el último se repite. Cada paso es una función que devuelve una Response
 * NUEVA (un cuerpo solo se lee una vez) o lanza para simular un fallo de red.
 */
function fetchSecuencia(...pasos) {
  let n = 0;
  return jest.fn(async (url, init) => {
    const paso = pasos[Math.min(n, pasos.length - 1)];
    n += 1;
    return paso(url, init);
  });
}

const r503 = () => json(503, { error: { codigo: 'ERROR' } });
const r200 = () => json(200, { ok: true });
const caidaDeRed = () => {
  throw new TypeError('fetch failed');
};

/** Cliente con reloj manual (`avanzar`), sleep falso, logger espía y, por defecto, un servicio que siempre da 503. */
function crearCliente({ fetchImpl = jest.fn(async () => r503()), ...opciones } = {}) {
  let ahora = 1_000_000;
  const sleep = jest.fn(async () => {});
  const logger = { info: jest.fn(), error: jest.fn() };
  const cliente = createResilientClient({
    baseUrl: BASE,
    nombre: 'ms-falso',
    timeoutMs: 1000,
    sleep,
    now: () => ahora,
    logger,
    fetchImpl,
    ...opciones,
  });
  return { cliente, fetchImpl, sleep, logger, avanzar: (ms) => { ahora += ms; } };
}

/** Exige que la promesa se rechace con AppError 503 (si se resuelve, la prueba falla) y devuelve el error. */
async function esperarNoDisponible(promesa) {
  const error = await promesa.then(
    () => {
      throw new Error('Se esperaba un rechazo y la llamada se resolvió');
    },
    (err) => err,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status: 503, codigo: 'SERVICIO_NO_DISPONIBLE' });
  return error;
}

/** Hace n llamadas que deben fallar con 503 (sin reintentos, salvo que se pida) y comprueba cada rechazo. */
async function fallar(cliente, n, { metodo = 'POST', reintentable = false } = {}) {
  for (let i = 0; i < n; i += 1) {
    await esperarNoDisponible(cliente.request(metodo, '/x', { reintentable }));
  }
}

const temporizadoresActivos = () => process.getActiveResourcesInfo().filter((tipo) => tipo === 'Timeout').length;

describe('createResilientClient: reintentos y esperas', () => {
  it('GET reintentable: 503, 503, 200 → resuelve con la respuesta y espera [200, 400]', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente({ fetchImpl: fetchSecuencia(r503, r503, r200) });
    const resultado = await cliente.request('GET', '/productos/1', { reintentable: true });
    expect(resultado).toEqual({ status: 200, body: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[200], [400]]);
  });

  it('GET reintentable que siempre da 503 → AppError 503 tras 4 llamadas y esperas [200, 400, 800]', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente();
    const error = await esperarNoDisponible(cliente.request('GET', '/productos/1', { reintentable: true }));
    expect(error.message).toBe('El servicio ms-falso no está disponible');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[200], [400], [800]]);
  });

  it('POST (reintentable falso por defecto) no reintenta: una falla → rechaza con 1 sola llamada', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente();
    await esperarNoDisponible(cliente.request('POST', '/x', { body: { a: 1 } }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await esperarNoDisponible(cliente.request('POST', '/x', { body: { a: 1 }, reintentable: false }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('un error de red se reintenta en un GET reintentable (red, red, 200) y no en un POST', async () => {
    const get = crearCliente({ fetchImpl: fetchSecuencia(caidaDeRed, caidaDeRed, r200) });
    expect(await get.cliente.request('GET', '/x', { reintentable: true })).toEqual({ status: 200, body: { ok: true } });
    expect(get.fetchImpl).toHaveBeenCalledTimes(3);
    expect(get.sleep.mock.calls).toEqual([[200], [400]]);

    const post = crearCliente({ fetchImpl: fetchSecuencia(caidaDeRed, r200) });
    await esperarNoDisponible(post.cliente.request('POST', '/x', { body: {} }));
    expect(post.fetchImpl).toHaveBeenCalledTimes(1);
    expect(post.sleep).not.toHaveBeenCalled();
  });

  it('un 404 no se reintenta: se devuelve tal cual con su cuerpo, tras una sola llamada', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente({ fetchImpl: jest.fn(async () => json(404, { error: { codigo: 'NO_EXISTE' } })) });
    const resultado = await cliente.request('GET', '/productos/9', { reintentable: true });
    expect(resultado).toEqual({ status: 404, body: { error: { codigo: 'NO_EXISTE' } } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('un 4xx con cuerpo que no es JSON se devuelve con body null (el servicio respondió, no es un fallo)', async () => {
    const { cliente } = crearCliente({ fetchImpl: jest.fn(async () => texto(404, '<html>no existe</html>')) });
    expect(await cliente.request('GET', '/x')).toEqual({ status: 404, body: null });
  });

  it('un 2xx con cuerpo vacío o 204 devuelve body null; uno con JSON lo devuelve parseado', async () => {
    const vacio = crearCliente({ fetchImpl: jest.fn(async () => vacia(204)) });
    expect(await vacio.cliente.request('POST', '/x', { body: {} })).toEqual({ status: 204, body: null });
    const accepted = crearCliente({ fetchImpl: jest.fn(async () => json(202, { aceptada: true })) });
    expect(await accepted.cliente.request('POST', '/x', { body: {} })).toEqual({ status: 202, body: { aceptada: true } });
  });

  it('el 5xx del servicio no se reenvía: el rechazo es un 503 propio sin el cuerpo recibido', async () => {
    const { cliente } = crearCliente({ fetchImpl: jest.fn(async () => json(500, { secreto: 'detalle-interno' })) });
    const error = await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(JSON.stringify({ mensaje: error.message, detalles: error.detalles })).not.toContain('detalle-interno');
  });

  it('descarta el cuerpo de un 5xx y de un 3xx sin leerlo (no deja la conexión ocupada)', async () => {
    const cancel = jest.fn(async () => {});
    const text = jest.fn(async () => '');
    const falsa = (status) => jest.fn(async () => ({ status, body: { cancel }, text }));

    const cincoXX = crearCliente({ fetchImpl: falsa(503) });
    await esperarNoDisponible(cincoXX.cliente.request('POST', '/x', { body: {} }));
    expect(cancel).toHaveBeenCalledTimes(1);

    const tresXX = crearCliente({ fetchImpl: falsa(302) });
    await esperarNoDisponible(tresXX.cliente.request('POST', '/x', { body: {} }));
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(text).not.toHaveBeenCalled();
  });
});

describe('createResilientClient: respuestas defectuosas y redirecciones', () => {
  it('un 2xx con cuerpo que no es JSON es una respuesta defectuosa: 503, sin reintento, y cuenta como fallo', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente({ fetchImpl: jest.fn(async () => texto(200, '<html>página del proxy</html>')) });
    await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    // cuenta para el cortacircuitos: tras 4 más (5 en total) el circuito abre y la sexta no llama
    await fallar(cliente, 4, { metodo: 'GET' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('un 3xx no se sigue ni se reintenta: 503, una sola llamada, con redirect manual', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente({
      fetchImpl: jest.fn(async () => new Response(null, { status: 302, headers: { location: 'http://otro-host/destino' } })),
    });
    await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('un 3xx cuenta como fallo del servicio destino (cinco seguidos abren el circuito)', async () => {
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => vacia(301)) });
    await fallar(cliente, 5);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});

describe('createResilientClient: plazo de espera', () => {
  it('fetch que nunca resuelve y ni mira la señal → AppError SERVICIO_NO_DISPONIBLE al agotarse timeoutMs', async () => {
    const { cliente, fetchImpl } = crearCliente({ timeoutMs: 20, fetchImpl: jest.fn(() => new Promise(() => {})) });
    const inicio = Date.now();
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(15);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // además de rechazar, aborta la llamada para liberar la conexión
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('un fetch que respeta la señal también falla por plazo (y reintenta si es reintentable: 4 llamadas)', async () => {
    const respetaSenal = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolver, rechazar) => {
          signal.addEventListener('abort', () => rechazar(signal.reason));
        }),
    );
    const { cliente, sleep } = crearCliente({ timeoutMs: 10, fetchImpl: respetaSenal });
    await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(respetaSenal).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[200], [400], [800]]);
  });

  it('el plazo cubre la lectura del cuerpo: cabeceras recibidas y cuerpo que nunca termina → falla por plazo', async () => {
    const sinFin = jest.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    const { cliente } = crearCliente({ timeoutMs: 30, fetchImpl: sinFin });
    const inicio = Date.now();
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect(sinFin.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('el plazo es por intento: cuatro intentos de 60 ms con timeoutMs 200 no vencen ninguno (juntos suman más que el plazo)', async () => {
    const lento = jest.fn(async () => {
      await dormir(60);
      return r503();
    });
    const { cliente, sleep } = crearCliente({ timeoutMs: 200, fetchImpl: lento });
    await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(lento).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[200], [400], [800]]);
    // control: ninguno se abortó (todos terminaron antes del plazo)
    for (const [, init] of lento.mock.calls) expect(init.signal.aborted).toBe(false);
  });

  it('una respuesta que llega antes del plazo no se corta', async () => {
    const { cliente } = crearCliente({
      timeoutMs: 200,
      fetchImpl: jest.fn(async () => {
        await dormir(10);
        return r200();
      }),
    });
    expect(await cliente.request('GET', '/x')).toEqual({ status: 200, body: { ok: true } });
  });

  it('por defecto espera 3000 ms por intento (RNF18)', async () => {
    const espia = jest.spyOn(globalThis, 'setTimeout');
    try {
      const { cliente } = crearCliente({ timeoutMs: undefined, fetchImpl: jest.fn(async () => r200()) });
      await cliente.request('GET', '/x');
      expect(espia.mock.calls.some(([, ms]) => ms === 3000)).toBe(true);
    } finally {
      espia.mockRestore();
    }
  });

  it('un timeoutMs que no es un número positivo falla al construir el cliente (no 1 ms en silencio)', () => {
    for (const invalido of [NaN, 0, -5, '3000', Infinity]) {
      expect(() => createResilientClient({ baseUrl: BASE, timeoutMs: invalido })).toThrow(TypeError);
    }
    expect(() => createResilientClient({ baseUrl: BASE, timeoutMs: 3000 })).not.toThrow();
  });
});

describe('createResilientClient: temporizadores', () => {
  // Con un plazo de 60 s, un temporizador que se quede vivo se vería en los recursos activos del proceso.
  const plazoLargo = { timeoutMs: 60_000 };

  it('el temporizador del plazo existe mientras la llamada está en vuelo (control del medidor)', async () => {
    const base = temporizadoresActivos();
    let durante;
    const { cliente } = crearCliente({
      ...plazoLargo,
      fetchImpl: jest.fn(async () => {
        durante = temporizadoresActivos();
        return r200();
      }),
    });
    await cliente.request('GET', '/x');
    expect(durante).toBe(base + 1);
  });

  it.each([
    ['éxito', () => r200(), 'GET'],
    ['4xx', () => json(404, {}), 'GET'],
    ['5xx', r503, 'POST'],
    ['3xx', () => vacia(302), 'POST'],
    ['cuerpo que no es JSON', () => texto(200, 'no json'), 'POST'],
    ['error de red', caidaDeRed, 'POST'],
  ])('no deja temporizadores vivos tras %s', async (_caso, paso, metodo) => {
    const base = temporizadoresActivos();
    const { cliente } = crearCliente({ ...plazoLargo, fetchImpl: fetchSecuencia(paso) });
    await cliente.request(metodo, '/x').catch(() => {});
    expect(temporizadoresActivos()).toBe(base);
  });

  it('tampoco los deja tras un fallo por plazo ni con reintentos', async () => {
    const base = temporizadoresActivos();
    const { cliente } = crearCliente({ timeoutMs: 10, fetchImpl: jest.fn(() => new Promise(() => {})) });
    await cliente.request('GET', '/x', { reintentable: true }).catch(() => {});
    expect(temporizadoresActivos()).toBe(base);
  });
});

describe('createResilientClient: cortacircuitos (D15)', () => {
  it('cinco llamadas fallidas seguidas abren el circuito: la sexta no llama a fetch', async () => {
    const { cliente, fetchImpl } = crearCliente();
    await fallar(cliente, 4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // control: con 4 fallos el circuito sigue cerrado y la quinta sí llama
    await fallar(cliente, 1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    const error = await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(error.message).toBe('El servicio ms-falso no está disponible');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('un fallo del circuito es una llamada que falla DESPUÉS de agotar sus reintentos, no cada intento', async () => {
    const { cliente, fetchImpl } = crearCliente();
    await fallar(cliente, 4, { metodo: 'GET', reintentable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(16); // 4 llamadas × 4 intentos: el circuito sigue cerrado
    await fallar(cliente, 1, { metodo: 'GET', reintentable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(20); // la quinta sí llamó (y abrió el circuito)
    await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it('una llamada rechazada por el circuito abierto no cuenta como fallo ni mueve el momento de reapertura', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente();
    await fallar(cliente, 5);
    avanzar(10_000);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    avanzar(19_999);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    avanzar(1); // 30 000 ms desde que abrió, no desde el último rechazo
    fetchImpl.mockImplementation(async () => r200());
    await expect(cliente.request('GET', '/x')).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('a los 29 999 ms sigue cerrado para las llamadas; a los 30 000 exactos deja pasar UNA de prueba que, si tiene éxito, lo cierra', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente();
    await fallar(cliente, 5);
    avanzar(29_999);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    avanzar(1);
    fetchImpl.mockImplementation(async () => r200());
    await expect(cliente.request('GET', '/x')).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    // cerrado de nuevo: las llamadas pasan sin esperar y el contador volvió a cero (4 fallos más no abren)
    await expect(cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    fetchImpl.mockImplementation(async () => r503());
    await fallar(cliente, 4);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    await fallar(cliente, 1);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it('si la llamada de prueba falla, reabre el circuito otros 30 s completos', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente();
    await fallar(cliente, 5);
    avanzar(30_000);
    await fallar(cliente, 1); // la de prueba: llama y falla
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    avanzar(29_999);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    avanzar(1);
    await fallar(cliente, 1); // nueva prueba
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('con la llamada de prueba en vuelo, las demás se rechazan sin llamar (no hay avalancha de pruebas)', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente();
    await fallar(cliente, 5);
    avanzar(30_000);

    let completarPrueba;
    fetchImpl.mockImplementation(() => new Promise((resolver) => { completarPrueba = () => resolver(r200()); }));
    const prueba = cliente.request('GET', '/x');
    const otra1 = esperarNoDisponible(cliente.request('GET', '/x'));
    const otra2 = esperarNoDisponible(cliente.request('POST', '/x', { body: {} }));
    await Promise.all([otra1, otra2]);
    expect(fetchImpl).toHaveBeenCalledTimes(6); // solo la de prueba

    completarPrueba();
    await expect(prueba).resolves.toEqual({ status: 200, body: { ok: true } });
    // la prueba cerró el circuito: la siguiente llamada pasa
    fetchImpl.mockImplementation(async () => r200());
    await expect(cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('si la llamada de prueba falla en vuelo, las concurrentes siguen rechazadas hasta que pasen otros 30 s', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente();
    await fallar(cliente, 5);
    avanzar(30_000);

    let fallarPrueba;
    fetchImpl.mockImplementation(() => new Promise((resolver) => { fallarPrueba = () => resolver(r503()); }));
    const prueba = esperarNoDisponible(cliente.request('POST', '/x', { body: {} }));
    await esperarNoDisponible(cliente.request('GET', '/x'));
    fallarPrueba();
    await prueba;
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('un éxito intercalado reinicia el contador: 4 fallos + 1 éxito + 4 fallos no abren; el quinto sí', async () => {
    const { cliente, fetchImpl } = crearCliente();
    await fallar(cliente, 4);
    fetchImpl.mockImplementation(async () => r200());
    await cliente.request('GET', '/x');
    fetchImpl.mockImplementation(async () => r503());
    await fallar(cliente, 4);
    expect(fetchImpl).toHaveBeenCalledTimes(9); // la novena llamada sí salió: sigue cerrado
    await fallar(cliente, 1);
    expect(fetchImpl).toHaveBeenCalledTimes(10); // la décima también (es el 5.º fallo seguido)
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(10); // ahora sí abierto
  });

  it('un 4xx cuenta como éxito: cinco 404 seguidos no abren el circuito y reinician los fallos acumulados', async () => {
    const { cliente, fetchImpl } = crearCliente();
    await fallar(cliente, 4);
    fetchImpl.mockImplementation(async () => json(404, {}));
    for (let i = 0; i < 5; i += 1) {
      expect(await cliente.request('GET', '/x')).toMatchObject({ status: 404 });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    fetchImpl.mockImplementation(async () => r503());
    await fallar(cliente, 4);
    expect(fetchImpl).toHaveBeenCalledTimes(13); // los 4 fallos previos al 404 ya no cuentan
  });

  it('el resultado de una llamada que salió con el circuito cerrado no cambia el circuito ya abierto', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente();
    let completarLenta;
    fetchImpl.mockImplementationOnce(() => new Promise((resolver) => { completarLenta = () => resolver(r200()); }));
    const lenta = cliente.request('GET', '/x'); // sale con el circuito cerrado y queda en vuelo
    await fallar(cliente, 5); // mientras tanto, el circuito abre
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    completarLenta();
    await expect(lenta).resolves.toMatchObject({ status: 200 }); // la lenta sí termina bien…
    await esperarNoDisponible(cliente.request('GET', '/x')); // …pero el circuito sigue abierto: solo la prueba lo cierra
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    avanzar(30_000);
    fetchImpl.mockImplementation(async () => r200());
    await expect(cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
  });

  it('un error inesperado durante la prueba libera el turno: no queda semiabierto para siempre', async () => {
    const { cliente, fetchImpl, sleep, avanzar } = crearCliente();
    await fallar(cliente, 5);
    avanzar(30_000);

    const roto = new Error('sleep roto');
    sleep.mockRejectedValueOnce(roto);
    await expect(cliente.request('GET', '/x', { reintentable: true })).rejects.toBe(roto); // no se disfraza de 503
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    // el turno se liberó y el error no contó como fallo: la siguiente llamada hace de prueba
    fetchImpl.mockImplementation(async () => r200());
    await expect(cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('cada cliente (cada servicio destino) lleva su propio circuito', async () => {
    const a = crearCliente();
    const b = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    await fallar(a.cliente, 5);
    await esperarNoDisponible(a.cliente.request('GET', '/x'));
    expect(a.fetchImpl).toHaveBeenCalledTimes(5);
    await expect(b.cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
    expect(b.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('respeta failureThreshold y openMs configurados', async () => {
    const { cliente, fetchImpl, avanzar } = crearCliente({ failureThreshold: 2, openMs: 500 });
    await fallar(cliente, 2);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    avanzar(499);
    await esperarNoDisponible(cliente.request('GET', '/x'));
    avanzar(1);
    await fallar(cliente, 1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('registra la apertura (error, con los fallos seguidos) y el cierre (info) del circuito', async () => {
    const { cliente, fetchImpl, logger, avanzar } = crearCliente();
    await fallar(cliente, 5);
    const apertura = logger.error.mock.calls.map(([registro]) => registro).filter((r) => r.mensaje === 'Circuito abierto');
    expect(apertura).toEqual([expect.objectContaining({ destino: 'ms-falso', fallos_seguidos: 5, espera_ms: 30_000 })]);

    avanzar(30_000);
    fetchImpl.mockImplementation(async () => r200());
    await cliente.request('GET', '/x');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ mensaje: 'Circuito cerrado', destino: 'ms-falso' }));
  });
});

describe('createResilientClient: cómo arma la petición', () => {
  it('envía solo las cabeceras que se le pasan más Accept; nunca Authorization ni Cookie por su cuenta', async () => {
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    await cliente.request('GET', '/productos/1', { headers: { 'X-Request-Id': 'req-1', 'X-User-Id': 7 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/productos/1`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ accept: 'application/json', 'x-request-id': 'req-1', 'x-user-id': '7' });
    expect(init).not.toHaveProperty('body');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('con body serializa a JSON y fija Content-Type, aunque el llamador pase otro; un Accept ajeno no se mezcla', async () => {
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => json(202, {})) });
    await cliente.request('POST', '/internas/notificaciones', {
      body: { tipo: 'STOCK_BAJO', n: 1 },
      headers: { 'content-type': 'text/plain', Accept: 'text/html', 'X-Request-Id': 'r' },
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"tipo":"STOCK_BAJO","n":1}');
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json', 'x-request-id': 'r' });
  });

  it('omite las cabeceras con valor null o undefined (no viajan como el texto "undefined")', async () => {
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    await cliente.request('GET', '/x', { headers: { 'X-Request-Id': 'r', 'X-User-Bodega': undefined, 'X-User-Rol': null } });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ accept: 'application/json', 'x-request-id': 'r' });
  });

  it.each([
    ['con barra final en baseUrl', 'http://h:8000/', '/productos/1', 'http://h:8000/productos/1'],
    ['con varias barras finales', 'http://h:8000///', '/productos/1', 'http://h:8000/productos/1'],
    ['sin barra final', 'http://h:8000', '/productos/1', 'http://h:8000/productos/1'],
    ['con prefijo de ruta', 'http://h:8000/api/', '/productos/1', 'http://h:8000/api/productos/1'],
    ['con espacios alrededor', '  http://h:8000  ', '/x', 'http://h:8000/x'],
  ])('une baseUrl y ruta sin dobles barras: %s', async (_caso, baseUrl, ruta, esperada) => {
    const { cliente, fetchImpl } = crearCliente({ baseUrl, fetchImpl: jest.fn(async () => r200()) });
    await cliente.request('GET', ruta);
    expect(fetchImpl.mock.calls[0][0]).toBe(esperada);
  });

  it('rechaza con TypeError (sin llamar, sin contar como fallo) una ruta que no empieza por "/" o que cambiaría el host', async () => {
    const { cliente, fetchImpl, sleep } = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    // control: una ruta válida sí llama
    await cliente.request('GET', '/valida');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    for (const ruta of ['productos/1', '', '//host-ajeno/x', 'http://host-ajeno/x', '@host-ajeno/x', undefined, 5]) {
      await expect(cliente.request('GET', ruta)).rejects.toThrow(TypeError);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('un error de programación no cuenta como fallo del servicio (cinco TypeError no abren el circuito)', async () => {
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    for (let i = 0; i < 5; i += 1) await expect(cliente.request('GET', 'sin-barra')).rejects.toThrow(TypeError);
    await expect(cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rechaza con TypeError, sin llamar, las cabeceras con saltos de línea, el cuerpo no serializable y un método inválido', async () => {
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    const circular = {};
    circular.yo = circular;
    const casos = [
      cliente.request('GET', '/x', { headers: { 'X-Request-Id': 'a\r\nX-Inyectada: 1' } }),
      cliente.request('GET', '/x', { headers: { 'X-Mala\nCabecera': 'a' } }),
      cliente.request('POST', '/x', { body: { n: 10n } }),
      cliente.request('POST', '/x', { body: circular }),
      cliente.request('GET', '/x', { body: { a: 1 } }),
      cliente.request('get', '/x'),
      cliente.request('GET', '/x', { headers: { 'X-Objeto': {} } }),
    ];
    const resultados = await Promise.allSettled(casos);
    expect(resultados).toHaveLength(7);
    for (const resultado of resultados) {
      expect(resultado.status).toBe('rejected');
      expect(resultado.reason).toBeInstanceOf(TypeError);
      expect(resultado.reason).not.toBeInstanceOf(AppError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // control: con datos válidos la misma llamada sale
    await cliente.request('POST', '/x', { body: { n: 10 }, headers: { 'X-Request-Id': 'ok' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createResilientClient: configuración y registro', () => {
  it('sin baseUrl válida el cliente se construye igual (createServer({}) no debe caerse) y request responde 503 sin llamar', async () => {
    for (const baseUrl of [undefined, '', '   ', 'catalogo:8000', 'ftp://h/', 'http://', 'http://h:8000/?x=1']) {
      const { cliente, fetchImpl, logger } = crearCliente({ baseUrl, fetchImpl: jest.fn(async () => r200()) });
      await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ mensaje: expect.stringContaining('URL') }));
    }
    // control: con una URL válida sí llama
    const { cliente, fetchImpl } = crearCliente({ fetchImpl: jest.fn(async () => r200()) });
    await cliente.request('GET', '/x');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('registra una línea por llamada fallida (tras sus reintentos) con campos de texto y sin cabeceras ni cuerpos', async () => {
    const { cliente, logger } = crearCliente({ fetchImpl: jest.fn(async () => json(503, { detalle: 'respuesta-secreta-9' })) });
    await esperarNoDisponible(
      cliente.request('POST', '/internas/notificaciones?clave=consulta-secreta-3', {
        body: { dato: 'cuerpo-secreto-7' },
        headers: { 'X-Token': 'cabecera-secreta-5' },
      }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [registro] = logger.error.mock.calls[0];
    expect(registro).toEqual({
      mensaje: 'Llamada a otro servicio fallida',
      destino: 'ms-falso',
      metodo: 'POST',
      ruta: '/internas/notificaciones',
      motivo: 'error_del_servicio',
      estado: 503,
      intentos: 1,
    });
    const volcado = JSON.stringify(logger.error.mock.calls);
    for (const secreto of ['respuesta-secreta-9', 'cuerpo-secreto-7', 'cabecera-secreta-5', 'consulta-secreta-3']) {
      expect(volcado).not.toContain(secreto);
    }
  });

  it.each([
    ['error de red', caidaDeRed, 'red'],
    ['respuesta no JSON', () => texto(200, 'x'), 'respuesta_invalida'],
    ['redirección', () => vacia(302), 'redireccion'],
  ])('el registro de un fallo por %s lleva su motivo', async (_caso, paso, motivo) => {
    const { cliente, logger } = crearCliente({ fetchImpl: jest.fn(async (...args) => paso(...args)) });
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(logger.error.mock.calls[0][0]).toMatchObject({ motivo, intentos: 1 });
  });

  it('el registro de un fallo por plazo lleva motivo tiempo_agotado y cuenta los intentos hechos', async () => {
    const { cliente, logger } = crearCliente({ timeoutMs: 5, fetchImpl: jest.fn(() => new Promise(() => {})) });
    await esperarNoDisponible(cliente.request('GET', '/x', { reintentable: true }));
    expect(logger.error.mock.calls[0][0]).toMatchObject({ motivo: 'tiempo_agotado', intentos: 4 });
  });

  it('un logger que lanza no cambia el resultado de la llamada', async () => {
    const logger = {
      info: jest.fn(() => { throw new Error('logger roto'); }),
      error: jest.fn(() => { throw new Error('logger roto'); }),
    };
    const { cliente, fetchImpl } = crearCliente({ logger });
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(logger.error).toHaveBeenCalled();
    fetchImpl.mockImplementation(async () => r200());
    await expect(cliente.request('GET', '/x')).resolves.toMatchObject({ status: 200 });
  });

  it('sin logger funciona igual', async () => {
    const cliente = createResilientClient({ baseUrl: BASE, fetchImpl: jest.fn(async () => r503()), sleep: async () => {} });
    await esperarNoDisponible(cliente.request('GET', '/x'));
  });

  it('sin nombre, el mensaje del 503 no revela el host del destino', async () => {
    const { cliente } = crearCliente({ nombre: undefined, baseUrl: 'http://host-interno-secreto:9999' });
    const error = await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(error.message).toBe('El servicio no está disponible');
  });
});
