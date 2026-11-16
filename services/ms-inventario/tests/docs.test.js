const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const supertest = require('supertest');
const { createApp } = require('../src/app');
const { crearRutasDocs } = require('../src/routes/docs');
const { rutasDeclaradas } = require('../src/routes');
const { buildTestApp } = require('./helpers/app');
const { headers } = require('./helpers/fixtures');
const { rutaNoExiste } = require('./helpers/respuestas');

// Documentación OpenAPI del servicio (RNF08): GET /docs (Swagger UI) y GET /docs/openapi.yaml (el documento en crudo). Son rutas
// del servicio, no pasan por el Gateway: sin base de datos y sin autenticación, y no forman parte de rutasDeclaradas (que es lo
// que registrarRutas protege con identidad).

const RAIZ = path.join(__dirname, '..');
const RUTA_OPENAPI = path.join(RAIZ, 'openapi.yaml');
const RUTA_PAGINA = path.join(RAIZ, 'src', 'docs', 'swagger-ui.html');

// Oráculo independiente de la página: la versión fija de Swagger UI y sus hashes SRI (sha384), los mismos que aprobó la revisión
// del Gateway y de ms-catalogo. Si se actualiza la versión hay que recalcular los dos hashes (ver el comentario de la página).
const VERSION_SWAGGER_UI = 'swagger-ui-dist@5.34.0';
const SRI_CSS = 'sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF';
const SRI_JS = 'sha384-9Td7MKiIr2S83E1kZyyVi8KdJw/S8CpAvu0llLyMeg0xq/hDGiZJfVn0fV4llCmK';

// Una aplicación cuya base de datos no se puede usar: si /docs la tocara, la petición fallaría.
function appSinBase() {
  const db = () => { throw new Error('/docs no debe consultar la base de datos'); };
  db.transaction = db;
  db.raw = db;
  const logger = { info() {}, error() {} };
  const clients = { catalogo: {}, notificaciones: {} };
  const env = {
    DB_HOST: 'h', DB_PORT: '1', DB_NAME: 'n', DB_USER: 'u', MS_CATALOGO_URL: 'http://c:1', MS_NOTIFICACIONES_URL: 'http://n:1',
  };
  return supertest(createApp({ db, clients, logger, env }));
}

// supertest solo guarda `res.text` para texto, JSON y formularios: el YAML se pide como binario para comparar byte a byte.
const comoBuffer = (res, callback) => {
  const trozos = [];
  res.on('data', (trozo) => trozos.push(trozo));
  res.on('end', () => callback(null, Buffer.concat(trozos)));
};

describe('GET /docs (la página de Swagger UI)', () => {
  it('responde 200 text/html con la página del servicio, tal como está en src/docs/swagger-ui.html', async () => {
    const res = await appSinBase().get('/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toBe(fs.readFileSync(RUTA_PAGINA, 'utf8'));
    expect(res.text).toContain('<title>ms-inventario - Documentación</title>');
  });

  it('carga el documento desde /docs/openapi.yaml y no activa el validador en línea de terceros', async () => {
    const { text } = await appSinBase().get('/docs');
    expect(text).toContain("url: '/docs/openapi.yaml'");
    expect(text).toContain('validatorUrl: null');
  });

  it('carga Swagger UI con versión exacta y con el hash SRI fijo de cada recurso', async () => {
    const { text } = await appSinBase().get('/docs');
    expect(text).toContain(`https://cdn.jsdelivr.net/npm/${VERSION_SWAGGER_UI}/swagger-ui.css" integrity="${SRI_CSS}" crossorigin="anonymous"`);
    expect(text).toContain(`https://cdn.jsdelivr.net/npm/${VERSION_SWAGGER_UI}/swagger-ui-bundle.js" integrity="${SRI_JS}" crossorigin="anonymous"`);
  });

  it('todo recurso externo de la página sale del CDN con versión exacta y lleva integrity (nada sin fijar)', async () => {
    const { text } = await appSinBase().get('/docs');
    const recursos = [...text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:[^"]+)"[^>]*>/g)];
    expect(recursos).toHaveLength(2);
    for (const [etiqueta, url] of recursos) {
      expect(url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/swagger-ui-dist@\d+\.\d+\.\d+\//);
      expect(etiqueta).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    }
  });

  it('funciona sin cabeceras de identidad y con ellas, y no toca la base de datos', async () => {
    const request = appSinBase();
    expect((await request.get('/docs')).status).toBe(200);
    expect((await request.get('/docs').set(headers('ADMINISTRADOR'))).status).toBe(200);
  });

  it('lleva el X-Request-Id de toda respuesta del servicio', async () => {
    const res = await appSinBase().get('/docs').set('X-Request-Id', 'prueba-docs-1');
    expect(res.headers['x-request-id']).toBe('prueba-docs-1');
  });
});

describe('GET /docs/openapi.yaml (el documento)', () => {
  it('responde 200 application/yaml con el contenido de openapi.yaml byte a byte', async () => {
    const res = await appSinBase().get('/docs/openapi.yaml').buffer(true).parse(comoBuffer);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/yaml; charset=utf-8');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.equals(fs.readFileSync(RUTA_OPENAPI))).toBe(true);
  });

  it('es un documento OpenAPI 3.0.3 que js-yaml sabe leer', async () => {
    const res = await appSinBase().get('/docs/openapi.yaml').buffer(true).parse(comoBuffer);
    const documento = yaml.load(res.body.toString('utf8'));
    expect(documento.openapi).toBe('3.0.3');
    expect(documento.info).toEqual(expect.objectContaining({ title: expect.stringContaining('ms-inventario'), version: expect.any(String) }));
    expect(documento.paths).toEqual(expect.any(Object));
  });

  it('funciona sin cabeceras de identidad y con ellas', async () => {
    const request = appSinBase();
    expect((await request.get('/docs/openapi.yaml')).status).toBe(200);
    expect((await request.get('/docs/openapi.yaml').set(headers('OPERADOR_BODEGA', { idBodega: 3 }))).status).toBe(200);
  });
});

describe('lo que NO es documentación sigue siendo el 404 normal del servicio', () => {
  it.each([
    ['POST', '/docs'],
    ['PUT', '/docs'],
    ['DELETE', '/docs'],
    ['POST', '/docs/openapi.yaml'],
    ['GET', '/docs/otra-cosa'],
    ['GET', '/docs/openapi.json'],
    ['GET', '/docs/openapi.yaml/otra-cosa'],
    ['GET', '/openapi.yaml'],
  ])('%s %s → 404 NO_EXISTE', async (metodo, ruta) => {
    const res = await appSinBase()[metodo.toLowerCase()](ruta).set(headers('ADMINISTRADOR'));
    rutaNoExiste(res);
  });

  it('con GET /docs funcionando como control: el 404 de arriba no es porque la app esté rota', async () => {
    const request = appSinBase();
    expect((await request.get('/docs')).status).toBe(200);
    rutaNoExiste(await request.post('/docs').set(headers('ADMINISTRADOR')));
  });
});

describe('cómo se montan', () => {
  it('no forman parte de rutasDeclaradas (registrarRutas les exigiría identidad en las escrituras)', () => {
    const rutas = rutasDeclaradas({}).map(({ ruta }) => ruta);
    expect(rutas.filter((ruta) => ruta.startsWith('/docs'))).toEqual([]);
    expect(rutas).not.toContain('/health');
  });

  it('createApp lee openapi.yaml y la página UNA vez al construirse y no vuelve a leer el disco al atender', async () => {
    const lecturas = jest.spyOn(fs, 'readFileSync');
    try {
      const request = appSinBase();
      const alConstruir = lecturas.mock.calls.map(([ruta]) => String(ruta)).filter((ruta) => ruta === RUTA_OPENAPI || ruta === RUTA_PAGINA);
      expect(alConstruir.sort()).toEqual([RUTA_OPENAPI, RUTA_PAGINA].sort());
      lecturas.mockClear();
      await request.get('/docs');
      await request.get('/docs/openapi.yaml');
      await request.get('/docs/openapi.yaml');
      expect(lecturas).not.toHaveBeenCalled();
    } finally {
      lecturas.mockRestore();
    }
  });

  it('un archivo que falta hace fallar la construcción (falla pronto, no en la primera petición)', () => {
    expect(() => crearRutasDocs({ rutaOpenapi: path.join(RAIZ, 'no-existe.yaml') })).toThrow(/no-existe\.yaml/);
    expect(() => crearRutasDocs({ rutaPagina: path.join(RAIZ, 'src', 'docs', 'no-existe.html') })).toThrow(/no-existe\.html/);
    // Control: con los archivos reales no lanza.
    expect(() => crearRutasDocs()).not.toThrow();
  });
});

describe('con la base de pruebas real', () => {
  let prueba;
  beforeAll(() => { prueba = buildTestApp(); });
  afterAll(() => prueba.db.destroy());

  it('createApp con sus dependencias normales también sirve las dos rutas', async () => {
    expect((await prueba.request.get('/docs')).status).toBe(200);
    expect((await prueba.request.get('/docs/openapi.yaml')).status).toBe(200);
  });
});
