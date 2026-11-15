const { registrarRutas, rutasDeclaradas } = require('../src/routes');
const { buildTestApp } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { headers } = require('./helpers/fixtures');
const { miniApp } = require('./helpers/miniapp');

// Una ruta con parámetro «oculta» a una estática declarada DESPUÉS: con el mismo método y el mismo número de segmentos, cada
// segmento de A es un parámetro o igual al de B, y A tiene un parámetro donde B es estático (p. ej. GET /saldos/:id declarada
// antes que GET /saldos/bajo-umbral). `idRuta` lanza 404 en vez de pasar a la siguiente ruta, así que la estática nunca
// se alcanzaría. Devuelve una descripción por cada ruta oculta; una lista bien ordenada devuelve [].
function rutasOcultas(rutas) {
  const segmentos = (ruta) => ruta.split('/').filter(Boolean);
  const esParametro = (segmento) => segmento.startsWith(':');
  const ocultas = [];
  rutas.forEach((posterior, indice) => {
    const sb = segmentos(posterior.ruta);
    for (const anterior of rutas.slice(0, indice)) {
      const sa = segmentos(anterior.ruta);
      if (anterior.metodo !== posterior.metodo || sa.length !== sb.length) continue;
      const cubre = sa.every((segmento, k) => esParametro(segmento) || segmento === sb[k]);
      const masGeneral = sa.some((segmento, k) => esParametro(segmento) && !esParametro(sb[k]));
      if (cubre && masGeneral) ocultas.push(`${posterior.metodo} ${posterior.ruta} queda oculta por ${anterior.metodo} ${anterior.ruta}`);
    }
  });
  return ocultas;
}

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
const SALDOS = [
  ['get', '/saldos/bajo-umbral'],
  ['get', '/saldos'],
];
const UMBRALES = [
  ['get', '/umbrales'],
  ['put', '/umbrales/:id_producto'],
];
const MOVIMIENTOS = [
  ['post', '/movimientos'],
  ['get', '/movimientos'],
  ['get', '/movimientos/:id'],
];
const LOTES = [
  ['get', '/lotes'],
  ['get', '/lotes/sugerencia-salida'],
];
const TRASLADOS = [
  ['post', '/traslados'],
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

  it('incluye las dos consultas de saldos de la Tabla 9 y ninguna repetida (el orden de las estáticas lo comprueba la prueba de orden)', () => {
    const rutas = rutasDeclaradas(deps).map(({ metodo, ruta }) => `${metodo} ${ruta}`);
    for (const [metodo, ruta] of SALDOS) expect(rutas).toContain(`${metodo} ${ruta}`);
    expect(new Set(rutas).size).toBe(rutas.length);
  });

  it('incluye las dos operaciones de umbrales de la Tabla 9, con el parámetro {id_producto} que nombra el contrato, y ninguna repetida', () => {
    const rutas = rutasDeclaradas(deps).map(({ metodo, ruta }) => `${metodo} ${ruta}`);
    for (const [metodo, ruta] of UMBRALES) expect(rutas).toContain(`${metodo} ${ruta}`);
    expect(new Set(rutas).size).toBe(rutas.length);
  });

  it('incluye las tres operaciones de movimientos de la Tabla 9 (POST y GET /movimientos, GET /movimientos/{id}) y ninguna repetida', () => {
    const rutas = rutasDeclaradas(deps).map(({ metodo, ruta }) => `${metodo} ${ruta}`);
    for (const [metodo, ruta] of MOVIMIENTOS) expect(rutas).toContain(`${metodo} ${ruta}`);
    expect(new Set(rutas).size).toBe(rutas.length);
  });

  it('incluye las dos consultas de lotes de la Tabla 9 (GET /lotes y GET /lotes/sugerencia-salida) y ninguna repetida', () => {
    const rutas = rutasDeclaradas(deps).map(({ metodo, ruta }) => `${metodo} ${ruta}`);
    for (const [metodo, ruta] of LOTES) expect(rutas).toContain(`${metodo} ${ruta}`);
    expect(new Set(rutas).size).toBe(rutas.length);
  });

  it('incluye las operaciones de traslados de la Tabla 9 y ninguna repetida', () => {
    const rutas = rutasDeclaradas(deps).map(({ metodo, ruta }) => `${metodo} ${ruta}`);
    for (const [metodo, ruta] of TRASLADOS) expect(rutas).toContain(`${metodo} ${ruta}`);
    expect(new Set(rutas).size).toBe(rutas.length);
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

describe('orden de las rutas (una estática antes que la /:id hermana)', () => {
  const ruta = (metodo, direccion) => ({ metodo, ruta: direccion, handler() {} });

  it('NINGUNA ruta declarada queda oculta por una más general declarada antes (las tareas siguientes la amplían sin tocar esto)', () => {
    expect(rutasOcultas(rutasDeclaradas(deps))).toEqual([]);
  });

  describe('el detector (rutasOcultas)', () => {
    it.each([
      ['una estática después de /:id', [ruta('get', '/saldos/:id'), ruta('get', '/saldos/bajo-umbral')], ['get /saldos/bajo-umbral queda oculta por get /saldos/:id']],
      ['una estática más profunda después de /:id/accion', [ruta('post', '/lotes/:id/cerrar'), ruta('post', '/lotes/sugerencia/cerrar')], ['post /lotes/sugerencia/cerrar queda oculta por post /lotes/:id/cerrar']],
      ['con otra ruta de por medio', [ruta('get', '/a/:id'), ruta('get', '/b'), ruta('get', '/a/estatica')], ['get /a/estatica queda oculta por get /a/:id']],
    ])('detecta %s', (_descripcion, rutas, esperado) => {
      expect(rutasOcultas(rutas)).toEqual(esperado);
    });

    it.each([
      ['la estática antes que /:id', [ruta('get', '/saldos/bajo-umbral'), ruta('get', '/saldos/:id')]],
      ['otro método (Express enruta por método)', [ruta('put', '/saldos/:id'), ruta('get', '/saldos/bajo-umbral')]],
      ['otro número de segmentos', [ruta('get', '/saldos/:id'), ruta('get', '/saldos/bajo-umbral/detalle')]],
      ['otro recurso', [ruta('get', '/bodegas/:id'), ruta('get', '/saldos/bajo-umbral')]],
      ['un parámetro intermedio distinto', [ruta('get', '/a/b/:id'), ruta('get', '/a/:x/c')]],
      ['rutas con la misma forma (no es un caso de orden)', [ruta('get', '/a/:id'), ruta('get', '/a/:otro')]],
      ['una lista vacía', []],
    ])('no marca %s', (_descripcion, rutas) => {
      expect(rutasOcultas(rutas)).toEqual([]);
    });
  });

  it('por qué importa: idRuta lanza 404 y no pasa a la siguiente ruta, así que el orden decide (una estática tras /:id nunca responde)', async () => {
    const { idRuta } = require('../src/http/validate');
    const montar = (primero, segundo) => miniApp((app) => {
      const porId = (req, res) => res.json({ id: idRuta(req.params.id) });
      const estatica = (_req, res) => res.json({ estatica: true });
      app.get(...primero === 'estatica' ? ['/cosas/resumen', estatica] : ['/cosas/:id', porId]);
      app.get(...segundo === 'estatica' ? ['/cosas/resumen', estatica] : ['/cosas/:id', porId]);
    }, { logger: { info() {}, error() {} } }).request;

    const bien = montar('estatica', 'id');
    expect((await bien.get('/cosas/resumen')).body).toEqual({ estatica: true });
    expect((await bien.get('/cosas/7')).body).toEqual({ id: 7 });

    const mal = montar('id', 'estatica');
    const oculta = await mal.get('/cosas/resumen');
    expect(oculta.status).toBe(404);
    expect(oculta.body.error.codigo).toBe('NO_EXISTE');
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
