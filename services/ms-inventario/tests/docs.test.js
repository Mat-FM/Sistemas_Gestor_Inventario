const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const supertest = require('supertest');
const { createApp } = require('../src/app');
const { crearRutasDocs } = require('../src/routes/docs');
const { rutasDeclaradas } = require('../src/routes');
const { buildTestApp } = require('./helpers/app');
const { headers } = require('./helpers/fixtures');
const { aRutaOpenapi, cargarDocumento, esquemaJson, operaciones, resolver } = require('./helpers/openapi');
const { resolverRef, revisarEsquema, validar } = require('./helpers/esquemaOpenapi');
const { TIPOS, TIPOS_PERMITIDOS_POR_API } = require('../src/domain/tipos');
const { ROLES } = require('../src/middleware/identity');
const { MAX_LINEAS_CONTEO } = require('../src/services/conteoService');
const { MAX_FILAS_CARGA_INICIAL } = require('../src/services/cargaInicialService');
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

// ---------------------------------------------------------------------------------------------------------------------------
// El documento openapi.yaml no puede desfasarse del código (RNF08): paridad con las rutas, estructura y coherencia con las
// constantes del servicio. Que cada respuesta REAL cumpla su esquema lo comprueba docsConformidad.test.js.
// ---------------------------------------------------------------------------------------------------------------------------

// Las 24 operaciones de negocio de la Tabla 9 más la sonda de salud, escritas a mano: un oráculo independiente. Una ruta nueva
// obliga a tocar esta lista, el documento y las pruebas de conformidad, así que no puede quedar sin documentar.
const OPERACIONES_ESPERADAS = [
  'GET /health',
  'GET /bodegas', 'GET /bodegas/{id}', 'POST /bodegas', 'PUT /bodegas/{id}', 'POST /bodegas/{id}/inactivar', 'POST /bodegas/{id}/activar',
  'GET /saldos', 'GET /saldos/bajo-umbral',
  'GET /umbrales', 'PUT /umbrales/{id_producto}',
  'POST /movimientos', 'GET /movimientos', 'GET /movimientos/{id}',
  'GET /lotes', 'GET /lotes/sugerencia-salida',
  'POST /traslados', 'GET /traslados', 'POST /traslados/{id}/recepcion',
  'POST /conteos', 'GET /conteos', 'GET /conteos/{id}', 'PUT /conteos/{id}/detalles', 'POST /conteos/{id}/aprobacion',
  'POST /internas/saldos/carga-inicial',
];

describe('openapi.yaml: paridad con las rutas del servicio', () => {
  let prueba;
  let documento;
  beforeAll(() => {
    prueba = buildTestApp();
    documento = cargarDocumento();
  });
  afterAll(() => prueba.db.destroy());

  const declaradas = () => rutasDeclaradas({ db: prueba.db, clients: prueba.clients, logger: { info() {}, error() {} } })
    .map(({ metodo, ruta }) => `${metodo.toUpperCase()} ${aRutaOpenapi(ruta)}`);

  it('el conjunto MÉTODO /ruta del documento es exactamente el de rutasDeclaradas más GET /health', () => {
    const documentadas = operaciones(documento).map(({ clave }) => clave).sort();
    // /health no está en rutasDeclaradas (se monta aparte, como /docs): se suma de forma explícita.
    expect(documentadas).toEqual([...declaradas(), 'GET /health'].sort());
  });

  it('coincide además con la lista escrita a mano en esta prueba (24 operaciones y la sonda)', () => {
    expect(declaradas()).toHaveLength(24);
    expect(operaciones(documento).map(({ clave }) => clave).sort()).toEqual([...OPERACIONES_ESPERADAS].sort());
    expect(new Set(OPERACIONES_ESPERADAS).size).toBe(25);
  });

  it('no hay claves repetidas ni operaciones que el servicio no declare (el documento no inventa rutas)', () => {
    const documentadas = operaciones(documento).map(({ clave }) => clave);
    expect(new Set(documentadas).size).toBe(documentadas.length);
    const permitidas = new Set([...declaradas(), 'GET /health']);
    expect(documentadas.filter((clave) => !permitidas.has(clave))).toEqual([]);
  });

  it('el documento no declara las rutas de documentación (/docs): las sirve el servicio, no son una operación de negocio', () => {
    expect(Object.keys(documento.paths).filter((ruta) => ruta.startsWith('/docs'))).toEqual([]);
  });

  it('cada :parámetro de la ruta tiene su parámetro in: path, obligatorio, y no sobra ninguno', () => {
    const rutas = [...rutasDeclaradas({ db: prueba.db, clients: prueba.clients }).map(({ metodo, ruta }) => ({ metodo, ruta })), { metodo: 'get', ruta: '/health' }];
    let conParametros = 0;
    for (const { metodo, ruta } of rutas) {
      const nombresDeRuta = [...ruta.matchAll(/:(\w+)/g)].map(([, nombre]) => nombre).sort();
      const { parametros } = operaciones(documento).find(({ clave }) => clave === `${metodo.toUpperCase()} ${aRutaOpenapi(ruta)}`);
      const enRuta = parametros.filter((parametro) => parametro.in === 'path');
      expect(enRuta.map(({ name }) => name).sort()).toEqual(nombresDeRuta);
      expect(enRuta.every(({ required }) => required === true)).toBe(true);
      if (nombresDeRuta.length > 0) conParametros += 1;
    }
    expect(conParametros).toBe(10); // control: la comprobación recorrió las 10 operaciones con un parámetro en la dirección
  });

  it('cada {parámetro} de una ruta del documento también está en la ruta que declara el servicio (no hay parámetros inventados)', () => {
    for (const ruta of Object.keys(documento.paths)) {
      for (const [, nombre] of ruta.matchAll(/\{(\w+)\}/g)) expect(ruta).toContain(`{${nombre}}`);
    }
    const dirigidas = rutasDeclaradas({ db: prueba.db, clients: prueba.clients }).map(({ ruta }) => ruta);
    for (const ruta of Object.keys(documento.paths).filter((r) => r !== '/health')) {
      expect(dirigidas).toContain(ruta.replace(/\{(\w+)\}/g, ':$1'));
    }
  });
});

// Recorridos del documento. Un "esquema raíz" es el que cuelga de components.schemas, de un parámetro o de un tipo de contenido
// (cuerpo de petición o de respuesta); los de adentro (propiedades, items) los recorren esquemaOpenapi y `esquemasInternos`.
function esquemasRaiz(documento) {
  const raices = Object.entries(documento.components.schemas).map(([nombre, esquema]) => ({ donde: `components.schemas.${nombre}`, esquema }));
  const medios = [];
  const parametros = [];
  const recoger = (contenido, donde) => {
    for (const [tipo, medio] of Object.entries(contenido ?? {})) {
      medios.push({ donde: `${donde}.content.${tipo}`, medio });
      if (medio.schema) raices.push({ donde: `${donde}.content.${tipo}.schema`, esquema: medio.schema });
    }
  };
  const recogerParametro = (parametro, donde) => {
    if (!parametro.$ref) {
      parametros.push({ donde, parametro });
      if (parametro.schema) raices.push({ donde: `${donde}.schema`, esquema: parametro.schema });
    }
  };
  for (const [nombre, parametro] of Object.entries(documento.components.parameters)) recogerParametro(parametro, `components.parameters.${nombre}`);
  for (const [nombre, respuesta] of Object.entries(documento.components.responses)) recoger(respuesta.content, `components.responses.${nombre}`);
  for (const [ruta, item] of Object.entries(documento.paths)) {
    (item.parameters ?? []).forEach((parametro, i) => recogerParametro(parametro, `paths.${ruta}.parameters[${i}]`));
    for (const operacion of operaciones(documento).filter((op) => op.ruta === ruta)) {
      const base = `paths.${ruta}.${operacion.metodo}`;
      (operacion.operacion.parameters ?? []).forEach((parametro, i) => recogerParametro(parametro, `${base}.parameters[${i}]`));
      recoger(operacion.operacion.requestBody?.content ? { ...operacion.operacion.requestBody.content } : undefined, `${base}.requestBody`);
      for (const [estado, respuesta] of Object.entries(operacion.operacion.responses)) if (!respuesta.$ref) recoger(respuesta.content, `${base}.responses.${estado}`);
    }
  }
  return { raices, medios, parametros };
}

// Cada esquema (raíz o interno) con su ruta, para encontrar los `example` anidados.
function esquemasInternos(esquema, donde, lista = []) {
  if (!esquema || typeof esquema !== 'object') return lista;
  lista.push({ donde, esquema });
  if (esquema.$ref) return lista;
  for (const [nombre, propiedad] of Object.entries(esquema.properties ?? {})) esquemasInternos(propiedad, `${donde}.${nombre}`, lista);
  if (esquema.items) esquemasInternos(esquema.items, `${donde}[]`, lista);
  if (typeof esquema.additionalProperties === 'object') esquemasInternos(esquema.additionalProperties, `${donde}{}`, lista);
  return lista;
}

// Toda referencia `$ref` que hay bajo un nodo, con el lugar donde está.
function referenciasEn(nodo, donde = '$', lista = []) {
  if (Array.isArray(nodo)) nodo.forEach((hijo, i) => referenciasEn(hijo, `${donde}[${i}]`, lista));
  else if (nodo && typeof nodo === 'object') {
    for (const [clave, hijo] of Object.entries(nodo)) {
      if (clave === '$ref') lista.push({ donde, ref: hijo });
      else referenciasEn(hijo, `${donde}.${clave}`, lista);
    }
  }
  return lista;
}

describe('openapi.yaml: estructura del documento', () => {
  let documento;
  beforeAll(() => { documento = cargarDocumento(); });

  it('es OpenAPI 3.0.3, con título, versión, descripción y un servidor relativo', () => {
    expect(documento.openapi).toBe('3.0.3');
    expect(documento.info).toMatchObject({ title: 'ms-inventario', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(documento.info.description.length).toBeGreaterThan(1000);
    expect(documento.servers).toEqual([expect.objectContaining({ url: '/' })]);
  });

  it('todo $ref resuelve (y es local)', () => {
    const referencias = referenciasEn(documento);
    expect(referencias.length).toBeGreaterThan(300); // control: el recorrido sí encontró referencias
    for (const { donde, ref } of referencias) {
      expect({ donde, resuelve: (() => { try { return resolverRef(documento, ref) !== undefined; } catch { return false; } })() }).toEqual({ donde, resuelve: true });
    }
  });

  it('todo $ref de una respuesta, un parámetro o un esquema apunta a una sección del mismo tipo', () => {
    for (const { donde, ref } of referenciasEn(documento)) {
      if (/\.responses\.'?\d{3}'?$/.test(donde)) expect({ donde, ref }).toEqual({ donde, ref: expect.stringMatching(/^#\/components\/responses\//) });
      if (/\.parameters\[\d+\]$/.test(donde)) expect({ donde, ref }).toEqual({ donde, ref: expect.stringMatching(/^#\/components\/parameters\//) });
    }
  });

  it('todo operationId existe y es único', () => {
    const ids = operaciones(documento).map(({ operacion }) => operacion.operationId);
    expect(ids.every((id) => typeof id === 'string' && /^[a-z][A-Za-z0-9]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('toda operación tiene tags declarados, summary, description y al menos una respuesta 2xx', () => {
    const etiquetas = new Set(documento.tags.map(({ name }) => name));
    for (const { clave, operacion } of operaciones(documento)) {
      expect({ clave, tags: operacion.tags?.length > 0 && operacion.tags.every((tag) => etiquetas.has(tag)) }).toEqual({ clave, tags: true });
      expect({ clave, summary: typeof operacion.summary === 'string' && operacion.summary.length > 0 }).toEqual({ clave, summary: true });
      expect({ clave, description: typeof operacion.description === 'string' && operacion.description.length > 20 }).toEqual({ clave, description: true });
      expect({ clave, exito: Object.keys(operacion.responses).some((estado) => /^2\d\d$/.test(estado)) }).toEqual({ clave, exito: true });
    }
  });

  it('todo tag declarado se usa, y tiene descripción', () => {
    const usados = new Set(operaciones(documento).flatMap(({ operacion }) => operacion.tags));
    for (const { name, description } of documento.tags) {
      expect({ name, usado: usados.has(name), descripcion: typeof description === 'string' && description.length > 0 }).toEqual({ name, usado: true, descripcion: true });
    }
  });

  it('toda respuesta declarada tiene descripción y un estado HTTP válido; las de error llevan el esquema de error de su estado', () => {
    const esquemaPorEstado = {
      400: 'ErrorPeticionMalFormada', 413: 'ErrorPeticionMalFormada', 415: 'ErrorPeticionMalFormada', 401: 'ErrorNoAutenticado', 403: 'ErrorSinPermiso',
      404: 'ErrorNoExiste', 409: 'ErrorConflicto', 422: 'ErrorDatosNoValidos', 500: 'ErrorInterno', 503: 'ErrorNoDisponible',
    };
    for (const { clave, operacion } of operaciones(documento)) {
      for (const [estado, declarada] of Object.entries(operacion.responses)) {
        const respuesta = resolver(documento, declarada);
        expect({ clave, estado, descripcion: typeof respuesta.description === 'string' && respuesta.description.length > 0 }).toEqual({ clave, estado, descripcion: true });
        expect(estado).toMatch(/^[1-5]\d\d$/);
        const esquema = esquemaJson(respuesta);
        if (Number(estado) >= 400) {
          expect({ clave, estado, esquema: esquema?.$ref }).toEqual({ clave, estado, esquema: `#/components/schemas/${esquemaPorEstado[estado]}` });
        } else {
          expect({ clave, estado, tieneCuerpo: esquema !== undefined }).toEqual({ clave, estado, tieneCuerpo: true });
        }
      }
    }
  });

  it('cada operación documenta los estados que su forma obliga: 401 y 500 siempre; 404 con {id}; 400/413/415 en toda escritura; 422 con cuerpo o consulta; 400 con Idempotency-Key', () => {
    // express.json lee el cuerpo de TODA petición con Content-Type JSON antes de llegar a la ruta: una escritura, tenga o no cuerpo
    // útil, puede dar 400 (JSON mal formado), 413 (más de 100 kB; 1 MB en la carga inicial) y 415 (otro charset). Los GET no los
    // declaran: lo dice la descripción general («Límites del cuerpo»).
    const ESCRITURAS_SIN_CUERPO = ['POST /bodegas/{id}/inactivar', 'POST /bodegas/{id}/activar', 'POST /conteos/{id}/aprobacion'];
    for (const { clave, metodo, operacion, parametros } of operaciones(documento)) {
      const estados = new Set(Object.keys(operacion.responses));
      const obligados = ['401', '500'];
      if (parametros.some((p) => p.in === 'path')) obligados.push('404');
      if (metodo !== 'get') obligados.push('400', '413', '415');
      if (operacion.requestBody) obligados.push('422');
      if (parametros.some((p) => p.name === 'Idempotency-Key')) obligados.push('400');
      if (parametros.some((p) => p.in === 'query')) obligados.push('422');
      expect({ clave, declaraCuerpo: Boolean(operacion.requestBody) }).toEqual({ clave, declaraCuerpo: metodo !== 'get' && !ESCRITURAS_SIN_CUERPO.includes(clave) });
      expect({ clave, faltan: obligados.filter((estado) => !estados.has(estado)) }).toEqual({ clave, faltan: [] });
      if (metodo === 'get') expect({ clave, declaraErroresDeCuerpo: ['413', '415'].filter((estado) => estados.has(estado)) }).toEqual({ clave, declaraErroresDeCuerpo: [] });
    }
  });

  it('todo texto libre de un cuerpo de petición declara minLength 1 y maxLength: el servicio lo recorta y rechaza el vacío con 422', () => {
    // Los textos pasan por validate.texto (trim, mínimo 1, máximo el de la columna). Un enum o una fecha no son texto libre.
    let revisados = 0;
    for (const { clave, operacion } of operaciones(documento)) {
      const esquema = esquemaJson(operacion.requestBody);
      if (!esquema) continue;
      for (const { donde, esquema: nodo } of esquemasInternos(resolverRef(documento, esquema.$ref), clave)) {
        if (nodo.type !== 'string' || nodo.enum || nodo.format) continue;
        revisados += 1;
        expect({ donde, minLength: nodo.minLength, maxLength: nodo.maxLength }).toEqual({ donde, minLength: 1, maxLength: expect.any(Number) });
      }
    }
    expect(revisados).toBeGreaterThanOrEqual(12); // control: bodegas (7), movimientos (3), recepción (1), carga inicial (1)
  });

  it('un 2xx de una operación con Idempotency-Key declara también el 200 de la repetición donde hay una operación nueva (201)', () => {
    for (const { clave, operacion } of operaciones(documento)) {
      if (operacion.responses['201'] && operacion.parameters?.some((p) => p.$ref?.endsWith('/ClaveIdempotencia'))) {
        expect({ clave, repeticion: Boolean(operacion.responses['200']) }).toEqual({ clave, repeticion: true });
      }
    }
  });

  it('en cada operación, las cabeceras de escritura son obligatorias y las de lectura opcionales; nunca hay un parámetro repetido', () => {
    for (const { clave, metodo, operacion, parametros } of operaciones(documento)) {
      const identificadores = parametros.map((p) => `${p.in}:${p.name}`);
      expect({ clave, repetidos: identificadores.filter((id, i) => identificadores.indexOf(id) !== i) }).toEqual({ clave, repetidos: [] });
      const id = parametros.find((p) => p.name === 'X-User-Id');
      const rol = parametros.find((p) => p.name === 'X-User-Rol');
      const esEscritura = metodo !== 'get';
      expect({ clave, idObligatorio: id?.required === true, rolObligatorio: rol?.required === true }).toEqual({ clave, idObligatorio: esEscritura, rolObligatorio: esEscritura });
      expect(parametros.find((p) => p.name === 'X-User-Bodega')?.required).toBe(false);
      expect(parametros.find((p) => p.name === 'X-Request-Id')?.required).toBe(false);
      expect({ clave, ok: operacion.operationId !== undefined }).toEqual({ clave, ok: true });
    }
  });

  it('ningún parámetro de ruta comparte (nombre, in) con uno de la operación y ninguna operación repite uno: Swagger UI no aplica el reemplazo de la especificación', () => {
    // La especificación dice que el parámetro de la operación sustituye al de la ruta con el mismo (nombre, in), y las pruebas de
    // «parámetros efectivos» de arriba lo respetan; pero Swagger UI no lo aplica cuando vienen por referencias distintas y mostró las
    // cabeceras de identidad dos veces en las escrituras. Aquí se mira el documento YA RESUELTO, sin aplicar el reemplazo.
    const clave = (parametro) => `${parametro.in}:${parametro.name}`;
    const resueltos = (lista = []) => lista.map((parametro) => resolver(documento, parametro));
    const repetidos = (claves) => claves.filter((c, i) => claves.indexOf(c) !== i);
    const IDENTIDAD = ['X-User-Id', 'X-User-Rol', 'X-User-Bodega', 'X-Request-Id'];
    for (const [ruta, item] of Object.entries(documento.paths)) {
      const deRuta = resueltos(item.parameters);
      expect({ ruta, repetidosEnLaRuta: repetidos(deRuta.map(clave)) }).toEqual({ ruta, repetidosEnLaRuta: [] });
      expect({ ruta, aNivelDeRutaQueNoSonDeRuta: deRuta.filter((p) => p.in !== 'path').map(clave) }).toEqual({ ruta, aNivelDeRutaQueNoSonDeRuta: [] });
    }
    for (const { clave: operacionClave, ruta, operacion } of operaciones(documento)) {
      const deRuta = resueltos(documento.paths[ruta].parameters).map(clave);
      const deOperacion = resueltos(operacion.parameters).map(clave);
      expect({ operacionClave, repetidosEnLaOperacion: repetidos(deOperacion) }).toEqual({ operacionClave, repetidosEnLaOperacion: [] });
      expect({ operacionClave, tambienEnLaRuta: deOperacion.filter((c) => deRuta.includes(c)) }).toEqual({ operacionClave, tambienEnLaRuta: [] });
      // Cada operación declara sus cabeceras de identidad y el identificador de la petición UNA sola vez, ella misma.
      for (const cabecera of IDENTIDAD) {
        expect({ operacionClave, cabecera, veces: deOperacion.filter((c) => c === `header:${cabecera}`).length }).toEqual({ operacionClave, cabecera, veces: 1 });
      }
    }
  });

  it('todo esquema, parámetro y respuesta de components se usa desde alguna operación (directa o indirectamente)', () => {
    const alcanzadas = new Set();
    const pendientes = referenciasEn(documento.paths).map(({ ref }) => ref);
    while (pendientes.length > 0) {
      const ref = pendientes.pop();
      if (!alcanzadas.has(ref)) {
        alcanzadas.add(ref);
        pendientes.push(...referenciasEn(resolverRef(documento, ref)).map((r) => r.ref));
      }
    }
    const sinUsar = [];
    for (const tipo of ['schemas', 'parameters', 'responses']) {
      for (const nombre of Object.keys(documento.components[tipo])) if (!alcanzadas.has(`#/components/${tipo}/${nombre}`)) sinUsar.push(`${tipo}.${nombre}`);
    }
    expect(sinUsar).toEqual([]);
    expect(Object.keys(documento.components).sort()).toEqual(['parameters', 'responses', 'schemas']); // nada más sin revisar
  });

  it('todo esquema (el raíz y los de adentro) pasa la revisión estructural: solo palabras clave soportadas, required ⊆ properties', () => {
    const { raices } = esquemasRaiz(documento);
    expect(raices.length).toBeGreaterThan(100); // control
    for (const { donde, esquema } of raices) expect({ donde, problemas: revisarEsquema(documento, esquema, donde) }).toEqual({ donde, problemas: [] });
  });

  it('todo objeto de una RESPUESTA 2xx o de un error es cerrado (additionalProperties: false) y todas sus propiedades son obligatorias salvo las justificadas', () => {
    // Los campos opcionales de una respuesta son solo estos: meta.cantidad_total (solo con id_producto) y disponible/solicitado de
    // un error STOCK_INSUFICIENTE. Un campo nuevo en el código debe entrar en el documento (y en `required`) o la prueba de
    // conformidad falla.
    const OPCIONALES = { 'MetaSaldos': ['cantidad_total'], 'ErrorDetalle': ['disponible', 'solicitado'] };
    const esquemasDeRespuesta = new Set();
    const agregar = (esquema) => { if (esquema?.$ref) esquemasDeRespuesta.add(esquema.$ref.split('/').pop()); };
    for (const { operacion } of operaciones(documento)) {
      for (const declarada of Object.values(operacion.responses)) agregar(esquemaJson(resolver(documento, declarada)));
    }
    const alcanzados = new Set();
    const visitar = (nombre) => {
      if (alcanzados.has(nombre)) return;
      alcanzados.add(nombre);
      for (const { ref } of referenciasEn(documento.components.schemas[nombre])) visitar(ref.split('/').pop());
    };
    // Las respuestas que son un arreglo plano llevan el $ref en `items`: referenciasEn lo encuentra al visitar el esquema en línea.
    for (const { operacion } of operaciones(documento)) {
      for (const declarada of Object.values(operacion.responses)) {
        const esquema = esquemaJson(resolver(documento, declarada));
        for (const { ref } of referenciasEn(esquema ?? {})) visitar(ref.split('/').pop());
      }
    }
    for (const nombre of esquemasDeRespuesta) visitar(nombre);
    expect(alcanzados.size).toBeGreaterThan(25);
    for (const nombre of alcanzados) {
      for (const { donde, esquema } of esquemasInternos(documento.components.schemas[nombre], nombre)) {
        if (esquema.type !== 'object' || !esquema.properties) continue;
        const propias = Object.keys(esquema.properties);
        const opcionales = OPCIONALES[donde] ?? [];
        expect({ donde, cerrado: esquema.additionalProperties === false }).toEqual({ donde, cerrado: true });
        expect({ donde, obligatorias: [...(esquema.required ?? [])].sort() }).toEqual({ donde, obligatorias: propias.filter((p) => !opcionales.includes(p)).sort() });
      }
    }
  });

  it('todo ejemplo (de un esquema, un parámetro, un tipo de contenido o su lista de ejemplos) cumple el esquema que ilustra', () => {
    const { raices, medios, parametros } = esquemasRaiz(documento);
    let comprobados = 0;
    const comprobar = (donde, esquema, ejemplo) => {
      comprobados += 1;
      expect({ donde, errores: validar(documento, esquema, ejemplo, '$') }).toEqual({ donde, errores: [] });
    };
    for (const { donde, esquema } of raices) {
      for (const interno of esquemasInternos(esquema, donde)) if (interno.esquema.example !== undefined) comprobar(interno.donde, interno.esquema, interno.esquema.example);
    }
    for (const { donde, medio } of medios) {
      if (medio.example !== undefined) comprobar(`${donde}.example`, medio.schema, medio.example);
      for (const [nombre, ejemplo] of Object.entries(medio.examples ?? {})) comprobar(`${donde}.examples.${nombre}`, medio.schema, ejemplo.value);
    }
    for (const { donde, parametro } of parametros) if (parametro.example !== undefined) comprobar(`${donde}.example`, parametro.schema, parametro.example);
    expect(comprobados).toBeGreaterThan(40); // control: hay ejemplos y se comprobaron
  });

  it('los esquemas de petición no son cerrados (el servicio ignora los campos desconocidos) y declaran sus campos obligatorios', () => {
    for (const { clave, operacion } of operaciones(documento)) {
      const esquema = esquemaJson(operacion.requestBody);
      if (!esquema) continue;
      const resuelto = resolverRef(documento, esquema.$ref);
      expect({ clave, cerrado: resuelto.additionalProperties }).toEqual({ clave, cerrado: undefined });
      // El cuerpo de la recepción es opcional y todos sus campos también.
      expect({ clave, conObligatorios: Array.isArray(resuelto.required) && resuelto.required.length > 0 }).toEqual({ clave, conObligatorios: clave !== 'POST /traslados/{id}/recepcion' });
    }
  });
});

describe('openapi.yaml: coherente con las constantes y los límites del servicio', () => {
  let documento;
  beforeAll(() => { documento = cargarDocumento(); });
  const esquema = (nombre) => documento.components.schemas[nombre];

  it('los tipos de movimiento son los del dominio (los nueve del kardex y los seis que acepta POST /movimientos)', () => {
    expect(esquema('TipoMovimiento').enum).toEqual(TIPOS);
    expect(esquema('TipoMovimientoRegistrable').enum).toEqual(TIPOS_PERMITIDOS_POR_API);
  });

  it('los roles de X-User-Rol son los de identity.js', () => {
    expect(documento.components.parameters.UsuarioRol.schema.enum).toEqual(ROLES);
    expect(documento.components.parameters.UsuarioRolEscritura.schema.enum).toEqual(ROLES);
  });

  it('los topes de líneas son las constantes exportadas: 1 000 conteos y 1 000 filas de carga inicial', () => {
    expect(esquema('NuevoConteo').properties.ids_producto.maxItems).toBe(MAX_LINEAS_CONTEO);
    expect(esquema('LecturaConteo').properties.detalles.maxItems).toBe(MAX_LINEAS_CONTEO);
    expect(esquema('CargaInicial').properties.filas.maxItems).toBe(MAX_FILAS_CARGA_INICIAL);
    expect(MAX_LINEAS_CONTEO).toBe(1000);
    expect(MAX_FILAS_CARGA_INICIAL).toBe(1000);
  });

  it('el máximo de por_pagina es 100, el valor por defecto 20 y la página mínima 1 (los mismos números de la descripción)', () => {
    expect(documento.components.parameters.PorPagina.schema).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
    expect(documento.components.parameters.Pagina.schema).toMatchObject({ minimum: 1, default: 1 });
    expect(esquema('Meta').properties.por_pagina.maximum).toBe(100);
  });

  it('los límites de cuerpo documentados son 100 kB en general y 1 MB solo en la carga inicial', () => {
    expect(documento.info['x-tamano-maximo-cuerpo-bytes']).toBe(102400);
    const cargaInicial = operaciones(documento).find(({ clave }) => clave === 'POST /internas/saldos/carga-inicial');
    expect(cargaInicial.operacion.requestBody['x-tamano-maximo-cuerpo-bytes']).toBe(1048576);
    const otrosConLimite = operaciones(documento).filter(({ operacion }) => operacion.requestBody?.['x-tamano-maximo-cuerpo-bytes'] !== undefined);
    expect(otrosConLimite.map(({ clave }) => clave)).toEqual(['POST /internas/saldos/carga-inicial']);
  });

  it('las operaciones con Idempotency-Key son exactamente cinco (movimientos, traslados, recepción, aprobación y carga inicial)', () => {
    const conClave = operaciones(documento).filter(({ parametros }) => parametros.some((p) => p.name === 'Idempotency-Key')).map(({ clave }) => clave).sort();
    expect(conClave).toEqual([
      'POST /conteos/{id}/aprobacion', 'POST /internas/saldos/carga-inicial', 'POST /movimientos', 'POST /traslados', 'POST /traslados/{id}/recepcion',
    ]);
    expect(documento.components.parameters.ClaveIdempotencia.schema).toMatchObject({ minLength: 1, maxLength: 200 });
  });
});

// Lo que el encargo de la Tarea 14 pide que quede documentado (los «carry» de los rulings): cada punto se busca en la operación o en la
// descripción general que lo trata. No prueba que el texto sea correcto (eso lo hace la conformidad con el servicio): prueba que
// ningún punto se borra sin que alguien lo note.
describe('openapi.yaml: documenta lo que el encargo exige', () => {
  let documento;
  beforeAll(() => { documento = cargarDocumento(); });
  // Todo el texto de la operación (descripción, parámetros, respuestas…) en una sola línea: las expresiones no dependen de dónde
  // el documento parte las líneas.
  const cadenas = (nodo) => {
    if (typeof nodo === 'string') return [nodo];
    if (Array.isArray(nodo)) return nodo.flatMap(cadenas);
    return nodo && typeof nodo === 'object' ? Object.values(nodo).flatMap(cadenas) : [];
  };
  // Sin el formato Markdown (negritas y comillas invertidas): quitar una negrita no cambia el sentido y no debe romper la prueba.
  const texto = (donde) => {
    const origen = donde === 'info' ? documento.info.description : cadenas(operaciones(documento).find(({ operacion }) => operacion.operationId === donde).operacion).join(' ');
    return origen.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ');
  };

  it.each([
    ['D29: los filtros de fecha son días UTC (inferior 00:00, superior hasta 23:59:59.999)', 'info', [/días UTC/, /00:00:00\.000/, /23:59:59\.999/, /22:00 en Colombia/]],
    ['D29: fecha_desde y fecha_hasta en el kardex', 'listarMovimientos', [/días UTC/, /fecha_desde/, /todo ese día UTC/]],
    ['D31: la recepción puede fallar con el traslado EN_TRANSITO (destino inactivo, lote con otra fecha, desborde)', 'recibirTraslado',
      [/BODEGA_INACTIVA/, /CONFLICTO/, /otra fecha de vencimiento/, /La recepción puede fallar y el traslado sigue EN_TRANSITO/, /2 147 483 647/]],
    ['D31: la recepción tiene su propia clave y 409 si es de otro traslado', 'recibirTraslado', [/propia clave/, /otro traslado/, /TRASLADO_YA_RECIBIDO/]],
    ['D31: el movimiento de la recepción lleva el lote del DESTINO y el traslado el de origen', 'recibirTraslado', [/movimiento\.id_lote de la respuesta es el lote del DESTINO/, /id_lote del traslado es el de origen/]],
    ['D32: la aprobación ajusta con la diferencia guardada, con clave y estados', 'aprobarConteo', [/diferencia guardada al contar/, /CONTEO_ESTADO_INVALIDO/, /Idempotency-Key/, /EN_REVISION/, /otro conteo/]],
    ['D32: GET /conteos va sin detalles', 'listarConteos', [/sin sus líneas/]],
    ['D33: tope de 1 000 líneas al programar un conteo', 'programarConteo', [/1 000/, /ids_producto/, /por partes/]],
    ['D33: tope de 1 000 líneas al registrar lo contado, y el orden real de las comprobaciones (403 antes que 422)', 'registrarDetallesConteo', [/Tope de 1 000 líneas/, /alcance sin bodega y tope \(403, 422\)/]],
    ['D34: carga inicial (solo ms-reportes, 1 000 filas, 1 MB, base 1, clave por fila, sin catálogo ni umbral, identidad, medición)', 'cargarSaldosIniciales',
      [/solo ms-reportes/, /1 000/, /1 MB/, /base 1/, /<id_usuario>:ini:<Idempotency-Key>#<n>/, /X-User-Rol/, /no consulta ms-catalogo/, /ni evalúa el umbral/, /5 s/, /texto libre en español/, /siempre 200/]],
    ['D34/Ruling 61: una clave NUEVA vuelve a sumar las mismas filas; las rechazadas se releen del cuerpo nuevo', 'cargarSaldosIniciales',
      [/Una clave nueva vuelve a sumar/, /por clave y por posición de la fila, no por el contenido/, /uuid4 por importación/, /las que se habían rechazado se leen de nuevo del cuerpo nuevo/]],
    ['Lotes D26-D28: fecha obligatoria con lote, el signo decide, mayúsculas, FEFO', 'registrarMovimiento', [/obligatoria al enviar lote/, /signo/, /distingue mayúsculas/, /FEFO/, /CONFLICTO/]],
    ['Lotes: vence_antes_de y con_existencia', 'listarLotes', [/vence_antes_de/, /con_existencia/, /estricto/, /FEFO/]],
    ['Kardex: orden, total exacto y limitación de rendimiento (índice, COUNT, sin instantánea)', 'listarMovimientos',
      [/fecha descendente/, /id_movimiento descendente/, /meta\.total es exacto/, /movimientos_fecha_id_idx/, /instantánea/, /60 000/, /15 s/]],
    ['Alcance por bodega: 403, qué aplica (también el registro de movimientos) y qué no', 'info',
      [/X-User-Bodega/, /403/, /GET \/movimientos\/\{id\}/, /bajo-umbral/, /a los movimientos \(registro y kardex\)/]],
    ['Movimientos de otra bodega son 403 y no 404', 'obtenerMovimiento', [/403/, /no 404/]],
    ['Idempotencia (RNF17): alcance por usuario y operación, y qué devuelve una repetición (resultado ya registrado, con sus excepciones)', 'info',
      [/usuario y por operación/, /resultado ya registrado/, /sin repetir la operación/, /la creación de un traslado lo devuelve en su estado actual/, /la carga inicial es idempotente por fila/, /Los errores no se guardan/]],
    ['Resiliencia (RNF18): nombra CALL_TIMEOUT_MS, las esperas, el cortacircuitos, el estado por proceso y el 503 (también ante una respuesta que el contrato no prevé)', 'info',
      [/CALL_TIMEOUT_MS/, /3 s por defecto/, /hasta 3 veces/, /0,2, 0,4 y 0,8 s/, /5 llamadas fallidas seguidas/, /30 s/, /por proceso/, /503/, /algo que el contrato no prevé/]],
    ['Identidad: lecturas internas sin X-User-Id y X-User-Id sin X-User-Rol', 'info', [/Las lecturas/, /X-User-Id sin X-User-Rol/, /NetworkPolicy/]],
    ['Límites de cuerpo: 100 kB y 1 MB; el cuerpo de cualquier petición se lee antes que la falta de X-User-Id', 'info',
      [/100 kB/, /1 MB/, /413/, /cualquier petición que envíe un cuerpo JSON \(también un GET o \/health\)/, /un JSON mal formado, demasiado grande o en otro charset es 400, 413 o 415 antes que el 401/]],
    ['Formato: cantidades enteras; en la carga inicial una fila inválida se rechaza (no es 422)', 'info', [/Un decimal o un texto es 422/, /la fila se rechaza en rechazados/]],
    ['Orden de las comprobaciones de las escrituras con clave: el cuerpo se lee antes que la falta de X-User-Id', 'registrarMovimiento', [/el cuerpo se lee antes/, /400, 413 o 415 antes que la falta de X-User-Id/]],
    ['Orden de las comprobaciones de crearTraslado: ídem', 'crearTraslado', [/el cuerpo se lee antes/, /400, 413 o 415 antes que la falta de X-User-Id/]],
    ['Orden de las comprobaciones de recibirTraslado: ídem', 'recibirTraslado', [/el cuerpo se lee antes/, /400, 413 o 415 antes que la falta de X-User-Id/]],
    ['Escrituras sin cuerpo: un cuerpo ilegible igual es 400/413/415', 'inactivarBodega', [/No usa el cuerpo/, /400, 413 o 415/]],
    ['Escrituras sin cuerpo (activar): ídem', 'activarBodega', [/No usa el cuerpo/, /400, 413 o 415/]],
    ['Escrituras sin cuerpo (aprobar): ídem', 'aprobarConteo', [/No usa el cuerpo/, /400, 413 o 415/]],
    ['503 del catálogo: también ante una respuesta que el contrato no prevé (umbral, movimiento y traslado)', 'guardarUmbral', [/algo que el contrato no prevé/]],
    ['503 del catálogo en POST /movimientos', 'registrarMovimiento', [/algo que el contrato no prevé/]],
    ['503 del catálogo en POST /traslados', 'crearTraslado', [/algo que el contrato no prevé/]],
    ['Rutas internas: /internas y bajo-umbral solo ADM e internos', 'listarSaldosBajoUmbral', [/solo ADMINISTRADOR/, /internos/, /sin paginar/]],
    ['Traslado: nunca hace FEFO; conflicto de fecha al crear', 'crearTraslado', [/nunca hace FEFO/, /CONFLICTO/, /sin lote/, /en tránsito/]],
    ['Contrato: el 404 de un {id} que no es un entero positivo', 'obtenerBodega', [/entero positivo/, /404/]],
  ])('%s', (_titulo, donde, expresiones) => {
    const contenido = texto(donde);
    for (const expresion of expresiones) expect({ donde, expresion: String(expresion), cumple: expresion.test(contenido) }).toEqual({ donde, expresion: String(expresion), cumple: true });
  });
});
