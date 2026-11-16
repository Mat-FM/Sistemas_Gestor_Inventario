const http = require('node:http');
const { pedir } = require('./helpers/red');

// `pedir` (helpers/red.js) existe para que una prueba no deje una conexión keep-alive en el depósito del `fetch` global: la
// siguiente petición al mismo puerto (startup.test.js reutiliza uno) podría reutilizarla cuando su servidor ya se cerró y fallar
// con `fetch failed / ECONNRESET` (entre 1 de cada 25 y 1 de cada 6 corridas de startup.test.js; el rastro: la petición que falla
// sale por el mismo socket local que la de una prueba anterior, y el cliente ve el cierre del servidor DESPUÉS de escribir en él).
// Aquí no se intenta reproducir esa carrera (depende de que el bucle de eventos no llegue a leer el cierre entre dos pruebas):
// se fija lo que la evita, que es una propiedad determinista del servidor: tras la respuesta, quién cierra la conexión.

const ESPERA_MS = 1500; // muy por debajo del keep-alive del cliente (4 s) y del servidor (5 s): si cierra antes, la cierra `pedir`

let servidor;
let sockets;
let conexiones;
beforeEach(async () => {
  sockets = [];
  conexiones = 0;
  servidor = http.createServer((req, res) => {
    res.end(JSON.stringify({ connection: req.headers.connection }));
  });
  servidor.on('connection', (socket) => {
    conexiones += 1;
    sockets.push({ socket, cerrado: new Promise((resolver) => { socket.once('close', resolver); }) });
  });
  await new Promise((resolver) => { servidor.listen(0, '127.0.0.1', resolver); });
});
afterEach(async () => {
  servidor.closeAllConnections();
  await new Promise((resolver) => { servidor.close(resolver); });
});

const url = () => `http://127.0.0.1:${servidor.address().port}/`;
const plazo = (ms) => new Promise((resolver) => { setTimeout(() => resolver('plazo'), ms); });
/** ¿Se cierra la conexión (sin que el servidor la cierre) antes de ESPERA_MS? */
const seCierraSola = async (socketRegistrado) => (await Promise.race([socketRegistrado.cerrado.then(() => 'cerrada'), plazo(ESPERA_MS)])) === 'cerrada';

describe('pedir: un fetch que no deja conexiones keep-alive', () => {
  it('envía Connection: close y la conexión se cierra al terminar la respuesta, sin que el servidor la cierre', async () => {
    const respuesta = await pedir(url());
    expect(await respuesta.json()).toEqual({ connection: 'close' });
    expect(conexiones).toBe(1);
    expect(await seCierraSola(sockets[0])).toBe(true);
  });

  it('control: un fetch normal SÍ deja la conexión abierta y disponible (por eso el problema existe)', async () => {
    const respuesta = await fetch(url());
    expect(await respuesta.json()).toEqual({ connection: 'keep-alive' });
    expect(await seCierraSola(sockets[0])).toBe(false);
  });

  it('conserva el método, el cuerpo y las cabeceras que se le piden, y añade solo la suya', async () => {
    const recibido = new Promise((resolver) => {
      servidor.removeAllListeners('request');
      servidor.on('request', (req, res) => {
        let cuerpo = '';
        req.on('data', (trozo) => { cuerpo += trozo; });
        req.on('end', () => {
          resolver({ metodo: req.method, cuerpo, usuario: req.headers['x-user-id'], connection: req.headers.connection });
          res.end('ok');
        });
      });
    });
    const respuesta = await pedir(url(), { method: 'POST', body: 'hola', headers: { 'X-User-Id': '7' } });
    expect(await respuesta.text()).toBe('ok');
    expect(await recibido).toEqual({ metodo: 'POST', cuerpo: 'hola', usuario: '7', connection: 'close' });
  });
});
