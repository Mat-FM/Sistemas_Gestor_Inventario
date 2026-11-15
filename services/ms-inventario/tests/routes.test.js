const { registrarRutas, rutasDeclaradas } = require('../src/routes');
const { buildTestApp } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { headers } = require('./helpers/fixtures');
const { miniApp } = require('./helpers/miniapp');

// Lista de rutas de negocio (rutasDeclaradas) y su montaje (registrarRutas). Estas pruebas recorren TODAS las rutas
// declaradas, así que cubren solas las que añadan las tareas siguientes (saldos, movimientos, lotes, traslados, conteos).

const ADM = headers('ADMINISTRADOR');
const BODEGAS = [
  ['get', '/bodegas'],
  ['get', '/bodegas/:id'],
  ['post', '/bodegas'],
  ['put', '/bodegas/:id'],
  ['post', '/bodegas/:id/inactivar'],
  ['post', '/bodegas/:id/activar'],
];

let request;
let db;
let deps;

beforeAll(() => {
  ({ request, db } = buildTestApp());
  deps = { db, clients: {}, logger: { info() {}, error() {} } };
});
beforeEach(() => truncateAll(db));
afterAll(() => db.destroy());

// '/bodegas/:id/activar' → '/bodegas/1/activar'
const concretar = (ruta) => ruta.replace(/:[A-Za-z_]+/g, '1');

describe('rutasDeclaradas', () => {
  it('devuelve { metodo, ruta, handler } por cada ruta, con el método en minúsculas y la ruta en sintaxis de Express', () => {
    const rutas = rutasDeclaradas(deps);
    expect(rutas.length).toBeGreaterThan(0);
    for (const entrada of rutas) {
      expect(Object.keys(entrada).sort()).toEqual(['handler', 'metodo', 'ruta']);
      expect(['get', 'post', 'put', 'patch', 'delete']).toContain(entrada.metodo);
      expect(entrada.ruta).toMatch(/^\/[a-z0-9\-/:_]*$/);
      expect(typeof entrada.handler).toBe('function');
    }
  });

  it('incluye las seis operaciones de bodegas de la Tabla 9 y ninguna repetida', () => {
    const rutas = rutasDeclaradas(deps).map(({ metodo, ruta }) => [metodo, ruta]);
    for (const esperada of BODEGAS) expect(rutas).toContainEqual(esperada);
    expect(new Set(rutas.map(([metodo, ruta]) => `${metodo} ${ruta}`)).size).toBe(rutas.length);
  });

  it('excluye /health y /docs: no son rutas de negocio ni pasan por el Gateway', () => {
    for (const { ruta } of rutasDeclaradas(deps)) {
      expect(ruta).not.toMatch(/^\/health/);
      expect(ruta).not.toMatch(/^\/docs/);
    }
  });

  it('se puede llamar sin dependencias (la Tarea 14 la usa para comparar con el OpenAPI): no abre conexiones', () => {
    expect(() => rutasDeclaradas()).not.toThrow();
    expect(() => rutasDeclaradas({})).not.toThrow();
    expect(rutasDeclaradas({}).length).toBe(rutasDeclaradas(deps).length);
  });

  it('las rutas internas (/internas/*) no usan el prefijo /api', () => {
    for (const { ruta } of rutasDeclaradas(deps)) expect(ruta).not.toMatch(/^\/api(\/|$)/);
  });
});

describe('registrarRutas', () => {
  it('monta cada ruta declarada: ninguna responde "la ruta no existe"', async () => {
    for (const { metodo, ruta } of rutasDeclaradas(deps)) {
      const res = await request[metodo](concretar(ruta)).set(ADM).send(['post', 'put'].includes(metodo) ? {} : undefined);
      // Una bodega inexistente es 404 NO_EXISTE con el mensaje del recurso; el 404 de "ruta" lo da rutaNoEncontrada.
      expect(res.body.error?.mensaje).not.toBe('La ruta solicitada no existe');
    }
  });

  it('TODA ruta que no es una lectura exige X-User-Id (D8, D22): sin él, 401 NO_AUTENTICADO', async () => {
    const escrituras = rutasDeclaradas(deps).filter(({ metodo }) => metodo !== 'get');
    expect(escrituras.length).toBeGreaterThan(0);
    for (const { metodo, ruta } of escrituras) {
      const res = await request[metodo](concretar(ruta)).send({});
      expect({ metodo, ruta, estado: res.status, codigo: res.body.error?.codigo }).toEqual({ metodo, ruta, estado: 401, codigo: 'NO_AUTENTICADO' });
    }
  });

  it('las lecturas (GET) son válidas sin X-User-Id: nunca 401 (llamadas internas de ms-reportes y ms-notificaciones)', async () => {
    const lecturas = rutasDeclaradas(deps).filter(({ metodo }) => metodo === 'get');
    expect(lecturas.length).toBeGreaterThan(0);
    for (const { ruta } of lecturas) {
      const res = await request.get(concretar(ruta));
      expect({ ruta, estado: res.status }).not.toEqual({ ruta, estado: 401 });
    }
  });

  it('monta las rutas declaradas en cualquier app que ya tenga la identidad y el analizador de JSON', async () => {
    const { request: otra } = miniApp((app) => registrarRutas(app, deps), { logger: { info() {}, error() {} } });
    const lectura = await otra.get('/bodegas');
    expect(lectura.status).toBe(200);
    expect(lectura.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
    expect((await otra.post('/bodegas').send({})).status).toBe(401);
    expect((await otra.post('/bodegas').set(ADM).send({})).status).toBe(422);
  });

  it('el montaje no exige X-User-Id a /health, que sigue respondiendo, ni cambia el 404 de una ruta desconocida', async () => {
    expect((await request.get('/health')).status).toBe(200);
    const res = await request.get('/ruta-que-no-existe').set(ADM);
    expect(res.status).toBe(404);
    expect(res.body.error.codigo).toBe('NO_EXISTE');
    // Una escritura a una ruta desconocida es 404 (no hay nada que proteger), no 401.
    expect((await request.post('/ruta-que-no-existe')).status).toBe(404);
  });
});
