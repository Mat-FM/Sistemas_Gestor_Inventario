const http = require('node:http');
const { AppError } = require('../src/errors');
const { createResilientClient } = require('../src/clients/resilientClient');

// El cliente resiliente contra un servidor HTTP real (node:http en 127.0.0.1, puerto efímero) y el fetch nativo: lo que
// los fakes no pueden demostrar (plazo sobre el cuerpo, sockets que se cortan, redirecciones que de verdad no se siguen).

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
const temporizadoresActivos = () => process.getActiveResourcesInfo().filter((tipo) => tipo === 'Timeout').length;

let servidor;
let url;
const peticiones = []; // { metodo, ruta, headers, cuerpo }
const conexionesCerradas = []; // rutas cuya respuesta terminó (o se cortó) del lado del servidor
let manejadores = {};

beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    const registro = { metodo: req.method, ruta: req.url, headers: req.headers, cuerpo: '' };
    peticiones.push(registro);
    res.on('close', () => conexionesCerradas.push(req.url));
    req.on('data', (trozo) => { registro.cuerpo += trozo; });
    req.on('end', () => {
      const manejador = manejadores[req.url.split('?')[0]];
      if (!manejador) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"codigo":"NO_EXISTE"}}');
        return;
      }
      manejador(req, res, registro);
    });
  });
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  url = `http://127.0.0.1:${servidor.address().port}`;
});

afterAll(async () => {
  // Un manejador que nunca responde deja su conexión abierta: sin esto close() esperaría para siempre.
  servidor.closeAllConnections();
  await new Promise((resolver) => servidor.close(resolver));
});

beforeEach(() => {
  peticiones.length = 0;
  conexionesCerradas.length = 0;
  manejadores = {};
});

// Esperas de reintento de 5 ms y fetch/reloj reales.
const crear = (opciones = {}) => createResilientClient({ baseUrl: url, nombre: 'ms-real', timeoutMs: 2000, backoffMs: [5, 5, 5], ...opciones });

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

async function hasta(condicion, ms = 2000) {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('La condición no se cumplió a tiempo');
    await dormir(5);
  }
}

describe('cliente resiliente con servidor HTTP real', () => {
  it('respuesta normal: GET devuelve estado y JSON; POST envía el cuerpo y las cabeceras acordadas, y nada más', async () => {
    manejadores['/productos/1'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id_producto":1}');
    };
    manejadores['/eco'] = (_req, res, registro) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ recibido: registro.cuerpo }));
    };
    const cliente = crear();

    expect(await cliente.request('GET', '/productos/1', { headers: { 'X-Request-Id': 'req-1' }, reintentable: true })).toEqual({
      status: 200,
      body: { id_producto: 1 },
    });
    expect(peticiones[0].headers).toMatchObject({ 'x-request-id': 'req-1', accept: 'application/json' });
    expect(peticiones[0].headers).not.toHaveProperty('authorization');
    expect(peticiones[0].headers).not.toHaveProperty('cookie');

    const eco = await cliente.request('POST', '/eco', { body: { tipo: 'STOCK_BAJO' } });
    expect(eco.status).toBe(202);
    expect(JSON.parse(eco.body.recibido)).toEqual({ tipo: 'STOCK_BAJO' });
    expect(peticiones[1].headers['content-type']).toBe('application/json');
  });

  it('un 404 real se devuelve tal cual, sin reintentos', async () => {
    const cliente = crear();
    const resultado = await cliente.request('GET', '/no-existe', { reintentable: true });
    expect(resultado).toEqual({ status: 404, body: { error: { codigo: 'NO_EXISTE' } } });
    expect(peticiones).toHaveLength(1);
  });

  it('un 503 real se reintenta hasta 4 veces y acaba en AppError 503; el servicio que se recupera a tiempo sí responde', async () => {
    let n = 0;
    manejadores['/inestable'] = (_req, res) => {
      n += 1;
      res.writeHead(n < 3 ? 503 : 200, { 'content-type': 'application/json' });
      res.end(n < 3 ? '{"error":{}}' : '{"ok":true}');
    };
    manejadores['/caido'] = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{}}');
    };
    const cliente = crear();
    expect(await cliente.request('GET', '/inestable', { reintentable: true })).toEqual({ status: 200, body: { ok: true } });
    expect(n).toBe(3);

    await esperarNoDisponible(cliente.request('GET', '/caido', { reintentable: true }));
    expect(peticiones.filter((p) => p.ruta === '/caido')).toHaveLength(4);
  });

  it('un servidor que no responde: falla por plazo (timeoutMs pequeño) y la conexión se cierra del lado del servidor', async () => {
    manejadores['/mudo'] = () => {};
    const cliente = crear({ timeoutMs: 60 });
    const inicio = Date.now();
    await esperarNoDisponible(cliente.request('GET', '/mudo'));
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(peticiones).toHaveLength(1);
    // el cliente abortó la llamada: el servidor ve la conexión cerrada (no queda un socket colgado)
    await hasta(() => conexionesCerradas.includes('/mudo'));
  });

  it('un servidor que envía cabeceras y parte del cuerpo y se queda callado: falla por plazo, no se cuelga', async () => {
    manejadores['/a-medias'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"parcial":'); // el cuerpo nunca termina
    };
    const cliente = crear({ timeoutMs: 100 });
    const inicio = Date.now();
    await esperarNoDisponible(cliente.request('GET', '/a-medias'));
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(peticiones).toHaveLength(1);
    await hasta(() => conexionesCerradas.includes('/a-medias'));
  });

  it('con reintentos, cada intento tiene su propio plazo: un cuerpo que nunca termina se intenta 4 veces', async () => {
    manejadores['/a-medias'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"parcial":');
    };
    const cliente = crear({ timeoutMs: 40 });
    await esperarNoDisponible(cliente.request('GET', '/a-medias', { reintentable: true }));
    expect(peticiones).toHaveLength(4);
  });

  it('un servidor que cierra el socket sin responder: error de red, se reintenta si es reintentable y no si no lo es', async () => {
    manejadores['/corta'] = (req) => req.socket.destroy();
    const cliente = crear();

    await esperarNoDisponible(cliente.request('POST', '/corta', { body: {} }));
    expect(peticiones).toHaveLength(1);

    peticiones.length = 0;
    await esperarNoDisponible(cliente.request('GET', '/corta', { reintentable: true }));
    expect(peticiones.length).toBeGreaterThanOrEqual(4); // undici puede repetir por su cuenta un GET en un socket reutilizado
  });

  it('un servidor que corta el socket a mitad del cuerpo: falla (503) en vez de devolver un JSON truncado', async () => {
    manejadores['/truncada'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '50' });
      res.write('{"a":');
      setTimeout(() => res.socket.destroy(), 10);
    };
    const cliente = crear();
    await esperarNoDisponible(cliente.request('POST', '/truncada', { body: {} }));
    expect(peticiones).toHaveLength(1);
  });

  it('un 200 con cuerpo que no es JSON es una respuesta defectuosa (503), sin reintentos', async () => {
    manejadores['/html'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>proxy</html>');
    };
    const cliente = crear();
    await esperarNoDisponible(cliente.request('GET', '/html', { reintentable: true }));
    expect(peticiones).toHaveLength(1);
  });

  it('una redirección real no se sigue: el destino nunca recibe una petición y no se reintenta', async () => {
    manejadores['/redirige'] = (_req, res) => {
      res.writeHead(302, { location: '/destino-redirigido' });
      res.end();
    };
    manejadores['/destino-redirigido'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    const cliente = crear();
    await esperarNoDisponible(cliente.request('GET', '/redirige', { reintentable: true }));
    await dormir(30); // margen para que una redirección seguida llegara al servidor
    expect(peticiones.map((p) => p.ruta)).toEqual(['/redirige']);
  });

  it('el temporizador del plazo queda limpio tras una llamada normal, un 5xx y una que vence', async () => {
    manejadores['/ok'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    };
    manejadores['/caido'] = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
    };
    manejadores['/mudo'] = () => {};
    const base = temporizadoresActivos();

    // plazo largo: un temporizador que se quedara vivo se vería aquí
    await crear({ timeoutMs: 60_000 }).request('GET', '/ok');
    expect(temporizadoresActivos()).toBe(base);

    await esperarNoDisponible(crear({ timeoutMs: 60_000 }).request('GET', '/caido'));
    expect(temporizadoresActivos()).toBe(base);

    await esperarNoDisponible(crear({ timeoutMs: 30 }).request('GET', '/mudo'));
    expect(temporizadoresActivos()).toBe(base);
  });

  it('un puerto sin servidor es un error de red: cada llamada falla con 503 y cinco abren el circuito; la sexta ni lo intenta', async () => {
    // puerto efímero recién liberado: nadie escucha
    const temporal = http.createServer();
    await new Promise((resolver) => temporal.listen(0, '127.0.0.1', resolver));
    const puertoMuerto = temporal.address().port;
    await new Promise((resolver) => temporal.close(resolver));

    const logger = { info: jest.fn(), error: jest.fn() };
    const cliente = crear({ baseUrl: `http://127.0.0.1:${puertoMuerto}`, backoffMs: [], logger });
    const mensajes = () => logger.error.mock.calls.map(([registro]) => registro.mensaje);

    for (let i = 0; i < 5; i += 1) await esperarNoDisponible(cliente.request('GET', '/x'));
    // cada una de las cinco intentó conectar y falló por la red; la quinta además abrió el circuito
    expect(mensajes().filter((m) => m === 'Llamada a otro servicio fallida')).toHaveLength(5);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ motivo: 'red', intentos: 1 });
    expect(mensajes().filter((m) => m === 'Circuito abierto')).toHaveLength(1);

    // la sexta se rechaza sin intentar conectar: un intento fallido habría añadido otra línea «Llamada a otro servicio fallida»
    const antes = logger.error.mock.calls.length;
    await esperarNoDisponible(cliente.request('GET', '/x'));
    expect(logger.error.mock.calls).toHaveLength(antes);
  });
});
