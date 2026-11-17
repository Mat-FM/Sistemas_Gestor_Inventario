// Pruebas del cliente entre servicios: reintentos, espera máxima y cortacircuito (RNF18).
const http = require('node:http');
const { ClienteHttp, Cortacircuito, ServicioNoDisponible } = require('../src/clients/clienteHttp');

let servidor;
let llamadas;
let comportamiento;

beforeAll(
  () =>
    new Promise((resolver) => {
      servidor = http.createServer((req, res) => {
        llamadas += 1;
        comportamiento(req, res);
      });
      servidor.listen(3098, resolver);
    }),
);
afterAll(() => new Promise((resolver) => servidor.close(resolver)));
beforeEach(() => {
  llamadas = 0;
});

const nuevoCliente = (opciones = {}) =>
  new ClienteHttp('prueba', 'http://127.0.0.1:3098/', { esperasReintentoMs: [10, 10, 10], timeoutMs: 200, ...opciones });

test('devuelve el estado y el cuerpo, también en respuestas 4xx', async () => {
  comportamiento = (req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end('{"error":{"codigo":"X"}}');
  };
  const r = await nuevoCliente().peticion('POST', '/algo', { cuerpo: { a: 1 }, reintentar: true });
  expect(r).toEqual({ status: 409, cuerpo: { error: { codigo: 'X' } } });
  expect(llamadas).toBe(1); // un 4xx no se reintenta
});

test('reintenta tres veces ante un 5xx cuando la operación lo permite', async () => {
  comportamiento = (req, res) => {
    res.writeHead(llamadas < 3 ? 500 : 200);
    res.end(llamadas < 3 ? '' : 'texto plano');
  };
  const r = await nuevoCliente().peticion('GET', '/x', { reintentar: true });
  expect(r.status).toBe(200);
  expect(r.cuerpo).toEqual({ texto: 'texto plano' });
  expect(llamadas).toBe(3);
});

test('sin reintento falla a la primera y respeta la espera máxima', async () => {
  comportamiento = () => {}; // nunca responde
  const inicio = Date.now();
  await expect(nuevoCliente().peticion('GET', '/lento')).rejects.toBeInstanceOf(ServicioNoDisponible);
  expect(Date.now() - inicio).toBeLessThan(1000);
  expect(llamadas).toBe(1);
});

test('el cortacircuito se abre tras 5 fallos seguidos y deja de llamar', async () => {
  comportamiento = (req, res) => {
    res.writeHead(503);
    res.end();
  };
  const cliente = nuevoCliente({ fallosParaAbrir: 5, tiempoAbiertoMs: 60000 });
  await expect(cliente.peticion('GET', '/x', { reintentar: true })).rejects.toThrow(); // 4 fallos
  await expect(cliente.peticion('GET', '/x')).rejects.toThrow(); // 5.º: se abre
  expect(cliente.cortacircuito.estado).toBe('ABIERTO');
  const antes = llamadas;
  await expect(cliente.peticion('GET', '/x')).rejects.toThrow(/cortacircuito abierto/);
  expect(llamadas).toBe(antes);
});

test('el cortacircuito deja pasar una llamada de prueba al vencer el tiempo y se cierra si funciona', () => {
  const corta = new Cortacircuito('x', { fallosParaAbrir: 2, tiempoAbiertoMs: -1 });
  corta.fallo();
  corta.fallo();
  expect(corta.permite()).toBe(true); // el tiempo abierto ya venció
  corta.exito();
  expect(corta.fallosSeguidos).toBe(0);
});
