const { createServer } = require('../src/server');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { headers } = require('./helpers/fixtures');
const { esError } = require('./helpers/respuestas');

// Tamaño del cuerpo (D18, D34(c)): todas las rutas admiten hasta 100 kB y SOLO la carga inicial de saldos admite hasta 1 MB (una
// fila ocupa ~110 bytes: con 100 kB solo caben ~900 de las 1 000 filas que admite). El analizador de 1 MB se monta con método y
// ruta (`app.post(RUTA, …)`) antes del global, que no vuelve a leer un cuerpo que ya se leyó. El comportamiento de la ruta
// misma está en cargaInicial.test.js; aquí solo se fija el LÍMITE, con un cuerpo que no es una carga real.

const RUTA = '/internas/saldos/carga-inicial';
const GLOBAL = 100 * 1024; // express.json({ limit: '100kb' })
const CARGA = 1024 * 1024; // express.json({ limit: '1mb' })
const ADM = { ...headers('ADMINISTRADOR'), 'Idempotency-Key': 'k-limite', 'Content-Type': 'application/json' };

/** Un cuerpo JSON válido de EXACTAMENTE `bytes` bytes (todo ASCII): {"relleno":"xxx…"}. */
function cuerpoDe(bytes) {
  const vacio = JSON.stringify({ relleno: '' });
  return JSON.stringify({ relleno: 'x'.repeat(bytes - vacio.length) });
}

let request;
let db;

beforeAll(() => {
  ({ request, db } = buildTestApp());
});
afterAll(() => db.destroy());

// El cuerpo de las pruebas es `{ relleno }`, que no es una carga ni un movimiento: si el ANALIZADOR lo dejó pasar, la respuesta es
// la de la ruta, y es siempre un 422 DATOS_NO_VALIDOS (falta `filas`, o faltan los campos del movimiento). Un 413 del analizador,
// un 400 de un JSON mal leído o un 500 de la ruta NO pasan.
function llegoAlServicio(res) {
  expect(res.status).toBe(422);
  expect(res.body.error.codigo).toBe('DATOS_NO_VALIDOS');
}

describe('la carga inicial admite hasta 1 MB (D34(c))', () => {
  it('500 kB y exactamente 1 MiB pasan el analizador; 1 MiB + 1 byte → 413 PETICION_MAL_FORMADA', async () => {
    /* Control positivo antes del rechazo: el tope es `>` y no `>=`, y está en 1 MiB. */
    llegoAlServicio(await request.post(RUTA).set(ADM).send(cuerpoDe(500 * 1000)));
    llegoAlServicio(await request.post(RUTA).set(ADM).send(cuerpoDe(CARGA)));
    const res = await request.post(RUTA).set(ADM).send(cuerpoDe(CARGA + 1));
    esError(res, 413, 'PETICION_MAL_FORMADA');
    expect(res.body.error.mensaje).toBe('El cuerpo de la petición supera el tamaño máximo permitido');
  });

  it('un cuerpo mayor de 100 kB y menor de 1 MB ya NO es 413 en esta ruta, y sí lo es en cualquier otra', async () => {
    /* La diferencia entre las dos rutas es lo único que cambió. */
    const cuerpo = cuerpoDe(GLOBAL + 1);
    llegoAlServicio(await request.post(RUTA).set(ADM).send(cuerpo));
    esError(await request.post('/movimientos').set(ADM).send(cuerpo), 413, 'PETICION_MAL_FORMADA');
  });

  it('las variantes de la misma ruta siguen la regla del enrutador de Express (barra final, mayúsculas): el analizador y la ruta coinciden', async () => {
    /* Con app.post(RUTA, …) el analizador usa el mismo emparejamiento que la ruta; con un `if (req.path === …)` a mano no. */
    for (const variante of [`${RUTA}/`, RUTA.toUpperCase()]) {
      llegoAlServicio(await request.post(variante).set(ADM).send(cuerpoDe(500 * 1000)));
    }
  });

  it('JSON mal formado (300 kB) → 400 y charset no soportado → 415, ambos PETICION_MAL_FORMADA: el manejo de D18 se conserva', async () => {
    /* Un analizador propio mal montado perdería el 400/415 o los respondería con otro código. */
    const malFormado = `{"filas": [${'1,'.repeat(150 * 1000)}`;
    const mal = await request.post(RUTA).set(ADM).send(malFormado);
    esError(mal, 400, 'PETICION_MAL_FORMADA');
    expect(mal.body.error.mensaje).toBe('El cuerpo de la petición no es un JSON válido');
    expect(mal.text).not.toMatch(/Unexpected|position|1,1,1/);
    const charset = await request.post(RUTA).set(ADM).set('Content-Type', 'application/json; charset=iso-8859-1').send('{}');
    esError(charset, 415, 'PETICION_MAL_FORMADA');
  });

  it('la identidad se comprueba ANTES de leer el cuerpo: un X-User-Id inválido con un cuerpo de más de 1 MiB lo responde el SERVIDOR con 401, no con 413', async () => {
    /* El analizador de 1 MB va después de `identity`, como el global. El servidor responde sin leer el cuerpo y puede cortar la
       conexión antes de que el cliente termine de enviar 1 MiB (ECONNRESET en el cliente, según la carrera): por eso se mira lo
       que respondió el servidor (su registro de la petición), no lo que vio el cliente. */
    const registros = [];
    const otra = buildTestApp({ logger: { info: (registro) => registros.push(registro), error() {} } });
    try {
      await otra.request.post(RUTA).set({ ...ADM, 'X-User-Id': 'abc' }).send(cuerpoDe(CARGA + 1)).then(() => {}, () => {});
      const limite = Date.now() + 5000;
      while (!registros.some((registro) => registro.ruta === RUTA) && Date.now() < limite) {
        await new Promise((resolver) => setTimeout(resolver, 10));
      }
      expect(registros.filter((registro) => registro.ruta === RUTA).map((registro) => registro.estado)).toEqual([401]);
    } finally {
      await otra.db.destroy();
    }
  });
});

describe('el resto de las rutas conserva los 100 kB (D18)', () => {
  it('POST /movimientos: exactamente 100 KiB pasa el analizador y 101 KiB → 413 PETICION_MAL_FORMADA', async () => {
    /* Control positivo antes del rechazo; el analizador de 1 MB no se aplica a todas las rutas. */
    llegoAlServicio(await request.post('/movimientos').set(ADM).send(cuerpoDe(GLOBAL)));
    const res = await request.post('/movimientos').set(ADM).send(cuerpoDe(101 * 1024));
    esError(res, 413, 'PETICION_MAL_FORMADA');
  });

  it.each([
    ['otro método sobre la misma ruta (PUT)', 'put', RUTA],
    ['una subruta de la carga inicial', 'post', `${RUTA}/otra`],
    ['el prefijo /internas/saldos', 'post', '/internas/saldos'],
    ['una ruta parecida', 'post', '/internas/saldos/carga-inicial-2'],
    ['POST /bodegas', 'post', '/bodegas'],
    ['POST /conteos', 'post', '/conteos'],
    ['una ruta que no existe', 'post', '/no-existe'],
  ])('%s: 500 kB → 413 (no hereda el 1 MB)', async (_descripcion, metodo, ruta) => {
    esError(await request[metodo](ruta).set(ADM).send(cuerpoDe(500 * 1000)), 413, 'PETICION_MAL_FORMADA');
  });
});

describe('la misma regla en el servidor real (createServer, HTTP de verdad)', () => {
  it('500 kB y 1 MiB a la carga inicial llegan a la ruta (422 por falta de `filas`); 1 MiB + 1 byte da 413; POST /movimientos con 101 KiB también da 413', async () => {
    const env = { ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', PORT: '3457' };
    const { server, db: dbReal } = createServer(env, { info() {}, error() {} });
    try {
      await new Promise((resolver) => server.listen(0, '127.0.0.1', resolver));
      const base = `http://127.0.0.1:${server.address().port}`;
      const enviar = (ruta, cuerpo) => fetch(`${base}${ruta}`, { method: 'POST', headers: ADM, body: cuerpo });
      for (const bytes of [500 * 1000, CARGA]) expect((await enviar(RUTA, cuerpoDe(bytes))).status).toBe(422); // pasó el analizador y la ruta pidió `filas`
      expect((await enviar(RUTA, cuerpoDe(CARGA + 1))).status).toBe(413);
      expect((await enviar('/movimientos', cuerpoDe(101 * 1024))).status).toBe(413);
    } finally {
      await new Promise((resolver) => server.close(resolver));
      await dbReal.destroy();
    }
  });
});
