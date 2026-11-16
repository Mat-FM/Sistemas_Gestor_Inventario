const { buildTestApp, entornoValido } = require('./helpers/app');
const { configDePrueba, createTestDb, prepararBaseDePrueba, verificarBaseDePrueba } = require('./helpers/db');

const VARIABLES = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'MS_CATALOGO_URL', 'MS_NOTIFICACIONES_URL'];

// Cuerpo único del 503: no distingue qué variable falla (D17).
const CUERPO_503 = {
  error: { codigo: 'SERVICIO_NO_DISPONIBLE', mensaje: 'El servicio no está disponible', detalles: [] },
};

const basesAbiertas = [];

// Arma la aplicación con un logger espía y vigila que /health nunca pida una conexión a la base.
function construir(opciones = {}) {
  const logger = { info: jest.fn(), error: jest.fn() };
  const prueba = buildTestApp({ logger, ...opciones });
  basesAbiertas.push(prueba.db);
  const conexiones = jest.spyOn(prueba.db.client, 'acquireConnection');
  return { ...prueba, logger, conexiones };
}

afterAll(() => Promise.all(basesAbiertas.map((db) => db.destroy())));

// Nada de lo que el entorno trae (valores centinela) debe aparecer en el registro.
function valoresEnElRegistro(logger, extra = []) {
  const registro = JSON.stringify(logger.error.mock.calls);
  return [...Object.values(entornoValido()), ...extra].filter((valor) => valor.trim() !== '' && registro.includes(valor));
}

it('GET /health responde 200 {estado:"ok", servicio:"ms-inventario"}', async () => {
  const { request, conexiones, logger } = construir();
  const res = await request.get('/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ estado: 'ok', servicio: 'ms-inventario' });
  expect(conexiones).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

it.each(VARIABLES)('GET /health con %s ausente → 503 SERVICIO_NO_DISPONIBLE sin revelar cuál', async (nombre) => {
  const { request, conexiones, logger } = construir({ env: { ...entornoValido(), [nombre]: undefined } });
  const res = await request.get('/health');
  expect(res.status).toBe(503);
  expect(res.body).toEqual(CUERPO_503);
  expect(res.text).not.toContain(nombre);
  // El registro nombra la variable que falta, nunca valores.
  expect(logger.error).toHaveBeenCalledTimes(1);
  const [registro] = logger.error.mock.calls[0];
  expect(registro.faltantes).toEqual([nombre]);
  expect(registro.invalidas).toEqual([]);
  expect(valoresEnElRegistro(logger)).toEqual([]);
  expect(conexiones).not.toHaveBeenCalled();
});

it('GET /health con NODE_ENV=test sigue exigiendo DB_NAME: TEST_DB_NAME no la sustituye', async () => {
  const env = { ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', DB_NAME: undefined };
  const { request, logger } = construir({ env });
  const res = await request.get('/health');
  expect(res.status).toBe(503);
  expect(logger.error.mock.calls[0][0].faltantes).toEqual(['DB_NAME']);
});

it.each(VARIABLES)('GET /health con %s vacía o solo con espacios cuenta como ausente → 503', async (nombre) => {
  for (const valor of ['', '   ']) {
    const { request, logger } = construir({ env: { ...entornoValido(), [nombre]: valor } });
    const res = await request.get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual(CUERPO_503);
    expect(logger.error.mock.calls[0][0].faltantes).toEqual([nombre]);
  }
});

it('GET /health con varias variables ausentes las nombra todas en el registro y responde lo mismo', async () => {
  const env = { ...entornoValido(), DB_HOST: undefined, MS_CATALOGO_URL: '' };
  const { request, logger } = construir({ env });
  const res = await request.get('/health');
  expect(res.status).toBe(503);
  expect(res.body).toEqual(CUERPO_503);
  expect(logger.error.mock.calls[0][0].faltantes).toEqual(['DB_HOST', 'MS_CATALOGO_URL']);
});

it.each([
  ['MS_CATALOGO_URL', 'catalogo-centinela:8000'],
  ['MS_CATALOGO_URL', 'ftp://catalogo-centinela'],
  ['MS_CATALOGO_URL', 'catalogo-centinela'],
  ['MS_NOTIFICACIONES_URL', 'localhost:5000'],
  ['MS_NOTIFICACIONES_URL', 'http://'],
  ['MS_NOTIFICACIONES_URL', 'https:///sin-host'],
  ['MS_NOTIFICACIONES_URL', 'http://notificaciones centinela:5000'],
])('GET /health con %s = %p (sin esquema http(s) válido) → 503', async (nombre, valor) => {
  const { request, conexiones, logger } = construir({ env: { ...entornoValido(), [nombre]: valor } });
  const res = await request.get('/health');
  expect(res.status).toBe(503);
  expect(res.body).toEqual(CUERPO_503);
  expect(res.text).not.toContain(nombre);
  expect(res.text).not.toContain(valor);
  const [registro] = logger.error.mock.calls[0];
  expect(registro.invalidas).toEqual([nombre]);
  expect(registro.faltantes).toEqual([]);
  expect(valoresEnElRegistro(logger, [valor])).toEqual([]);
  expect(conexiones).not.toHaveBeenCalled();
});

it.each(['http://ms-catalogo:8000', 'https://catalogo.ejemplo.co/base', 'HTTP://MS-CATALOGO:8000'])(
  'GET /health acepta la URL http(s) válida %p',
  async (url) => {
    const { request } = construir({ env: { ...entornoValido(), MS_CATALOGO_URL: url } });
    expect((await request.get('/health')).status).toBe(200);
  },
);

describe('el arnés se niega a correr con una base que no termina en _test o igual a DB_NAME', () => {
  const base = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'inventario_db' };

  it('sin TEST_DB_NAME no hay base de pruebas', () => {
    expect(() => verificarBaseDePrueba(base)).toThrow(/TEST_DB_NAME no está definida/);
    expect(() => verificarBaseDePrueba({ ...base, TEST_DB_NAME: '  ' })).toThrow(/TEST_DB_NAME no está definida/);
  });

  it('TEST_DB_NAME igual a DB_NAME → error (aunque termine en _test)', () => {
    expect(() => verificarBaseDePrueba({ ...base, DB_NAME: 'inventario_test', TEST_DB_NAME: 'inventario_test' })).toThrow(
      /coincide con DB_NAME/,
    );
  });

  it.each(['inventario_db', 'inventario', 'inventario_test_viejo', 'test'])('%p no termina en _test → error', (nombre) => {
    expect(() => verificarBaseDePrueba({ ...base, TEST_DB_NAME: nombre })).toThrow(/debe terminar en _test/);
  });

  it.each(['Inventario_test', 'inv-test_test', 'x"; DROP DATABASE y; --_test', 'con espacio_test', '_test'])(
    '%p tiene un formato no permitido (va a un CREATE DATABASE) → error',
    (nombre) => {
      expect(() => verificarBaseDePrueba({ ...base, TEST_DB_NAME: nombre })).toThrow(/solo puede llevar/);
    },
  );

  it('un nombre válido se devuelve tal cual', () => {
    expect(verificarBaseDePrueba({ ...base, TEST_DB_NAME: 'inventario_test' })).toBe('inventario_test');
  });

  it('configDePrueba y createTestDb pasan por la guardia, aun con NODE_ENV distinto de test', () => {
    const mala = { ...base, NODE_ENV: 'development', DB_NAME: 'inventario_test', TEST_DB_NAME: 'inventario_test' };
    expect(() => configDePrueba(mala)).toThrow(/coincide con DB_NAME/);
    expect(() => createTestDb(mala)).toThrow(/coincide con DB_NAME/);
    expect(configDePrueba({ ...base, NODE_ENV: 'development', TEST_DB_NAME: 'inventario_test' }).database).toBe('inventario_test');
  });

  it('prepararBaseDePrueba falla con el error de la guardia antes de intentar conectar', async () => {
    // El puerto 1 no tiene a nadie escuchando: si intentara conectar, el error sería ECONNREFUSED.
    await expect(prepararBaseDePrueba({ ...base, TEST_DB_NAME: 'inventario_db' })).rejects.toThrow(/debe terminar en _test/);
    await expect(prepararBaseDePrueba({ ...base, DB_NAME: 'x_test', TEST_DB_NAME: 'x_test' })).rejects.toThrow(/coincide con DB_NAME/);
  });
});
