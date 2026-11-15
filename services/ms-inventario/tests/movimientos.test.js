const tipos = require('../src/domain/tipos');
const stockService = require('../src/services/stockService');
const { buildTestApp } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const umbralRepository = require('../src/repositories/umbralRepository');
const { crearBodega, crearSaldo, crearUmbral, fakeCatalogo, headers } = require('./helpers/fixtures');
const { ISO_8601, datosNoValidos, esError, recursoNoExiste } = require('./helpers/respuestas');

// POST /movimientos de la Tabla 9 (RF04, RF10, RNF17) de punta a punta, contra PostgreSQL real y con clientes falsos. El motor
// (bloqueo, signos, saldo negativo, D24) se prueba a fondo en stock.test.js; aquí, lo que añade la ruta: idempotencia por
// usuario (D25), validación del cuerpo, permisos (D4, alcance del operador), catálogo y el orden en que se decide todo.

const MAXIMO = 2147483647;
const ADM = headers('ADMINISTRADOR');
const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];

let request;
let db;
let clients;
let logger;
// Segunda aplicación sobre la MISMA base con el catálogo caído: ms-catalogo no responde (503).
let requestCaido;
let dbCaido;
let catalogoCaido;
let b1;
let b2;

beforeAll(() => {
  logger = { info: jest.fn(), error: jest.fn() };
  ({ request, db, clients } = buildTestApp({ logger }));
  ({ request: requestCaido, db: dbCaido, clients: { catalogo: catalogoCaido } } = buildTestApp({ clients: { catalogo: fakeCatalogo({ caido: true }) } }));
});
beforeEach(async () => {
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
  b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
  clients.catalogo.obtenerProducto.mockClear();
  catalogoCaido.obtenerProducto.mockClear();
  // Cada prueba parte del doble por defecto: un aviso que se resuelve sin hacer nada.
  clients.notificaciones.notificarStockBajo.mockReset().mockResolvedValue(undefined);
  logger.error.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => Promise.all([db.destroy(), dbCaido.destroy()]));

let contador = 0;
const nuevaClave = () => `k-${(contador += 1)}`;
// POST /movimientos con las cabeceras y la clave dadas; `clave` null no envía la cabecera.
function post(cuerpo, cabeceras = ADM, clave = nuevaClave(), cliente = request) {
  const peticion = cliente.post('/movimientos').set(cabeceras);
  if (clave !== null) peticion.set('Idempotency-Key', clave);
  return peticion.send(cuerpo);
}
const entrada = (extra = {}) => ({ tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, cantidad: 10, ...extra });
const saldoDe = async (idProducto = 5, idBodega = b1) => (await db('saldos').where({ id_producto: idProducto, id_bodega: idBodega }).first())?.cantidad_disponible;
const movimientos = () => db('movimientos').select('*').orderBy('id_movimiento');
const catalogoSinLlamadas = () => expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
// 409 STOCK_INSUFICIENTE: sus detalles llevan, además de { campo, mensaje }, lo disponible y lo solicitado (esError exige solo los dos).
function stockInsuficiente(res, disponible, solicitado) {
  expect(res.status).toBe(409);
  expect(res.body).toEqual({
    error: { codigo: 'STOCK_INSUFICIENTE', mensaje: expect.any(String), detalles: [{ campo: 'cantidad', mensaje: expect.any(String), disponible, solicitado }] },
  });
}

// Control positivo antes de un rechazo: una ENTRADA válida que debe dar 201. Después limpia las llamadas al catálogo.
async function control(extra = {}, cabeceras = ADM) {
  const res = await post(entrada(extra), cabeceras);
  expect(res.status).toBe(201);
  clients.catalogo.obtenerProducto.mockClear();
  return res.body;
}

describe('POST /movimientos: registro (201)', () => {
  it('ENTRADA 10 y SALIDA 4 → 201 con saldo_resultante 10 y 6; el Movimiento tiene exactamente sus 13 campos y el saldo queda en 6', async () => {
    const primera = await post(entrada({ documento_referencia: '  FAC-1  ', observacion: 'Compra' }));
    expect(primera.status).toBe(201);
    expect(Object.keys(primera.body).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
    expect(primera.body).toEqual({
      id_movimiento: 1, tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, id_lote: null, id_traslado: null, id_conteo: null,
      cantidad: 10, saldo_resultante: 10, fecha: expect.stringMatching(ISO_8601), id_usuario: 7,
      documento_referencia: 'FAC-1', observacion: 'Compra',
    });
    const segunda = await post({ tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 4 });
    expect(segunda.status).toBe(201);
    expect(segunda.body).toMatchObject({ id_movimiento: 2, tipo: 'SALIDA', cantidad: 4, saldo_resultante: 6, documento_referencia: null, observacion: null });
    expect(await saldoDe()).toBe(6);
  });

  it('la respuesta es lo guardado: misma fecha, sin clave_idempotencia y con números (no texto)', async () => {
    const res = await post(entrada(), ADM, 'mi-clave');
    const [fila] = await movimientos();
    expect(res.body.fecha).toBe(fila.fecha.toISOString());
    expect(res.body).not.toHaveProperty('clave_idempotencia');
    expect(typeof res.body.cantidad).toBe('number');
    expect(typeof res.body.saldo_resultante).toBe('number');
    expect(fila.clave_idempotencia).toBe('7:mov:mi-clave'); // D25 y D25b: la clave se guarda con el usuario y la operación
  });

  it('tipos que suman y restan (D3): DEVOLUCION_CLIENTE y ENTRADA_COMPRA suman, DEVOLUCION_PROVEEDOR y SALIDA restan', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const pasos = [['DEVOLUCION_CLIENTE', 2, 12], ['ENTRADA_COMPRA', 3, 15], ['DEVOLUCION_PROVEEDOR', 4, 11], ['SALIDA', 1, 10]];
    for (const [tipo, cantidad, esperado] of pasos) {
      const res = await post({ tipo, id_producto: 5, id_bodega: b1, cantidad });
      expect({ tipo, estado: res.status, saldo: res.body.saldo_resultante }).toEqual({ tipo, estado: 201, saldo: esperado });
    }
    expect(await saldoDe()).toBe(10);
  });

  it('AJUSTE -2 → saldo 4 (la cantidad se guarda con su signo); AJUSTE +3 → 7; AJUSTE 0 → 422', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
    const negativo = await post({ tipo: 'AJUSTE', id_producto: 5, id_bodega: b1, cantidad: -2 });
    expect(negativo.status).toBe(201);
    expect(negativo.body).toMatchObject({ cantidad: -2, saldo_resultante: 4 });
    expect((await post({ tipo: 'AJUSTE', id_producto: 5, id_bodega: b1, cantidad: 3 })).body).toMatchObject({ cantidad: 3, saldo_resultante: 7 });
    datosNoValidos(await post({ tipo: 'AJUSTE', id_producto: 5, id_bodega: b1, cantidad: 0 }), ['cantidad']);
    expect(await saldoDe()).toBe(7);
  });

  it('ignora los campos que fija el servidor: id_usuario sale de X-User-Id, y saldo_resultante, fecha e id_movimiento del cuerpo no cuentan', async () => {
    const res = await post(entrada({ id_usuario: 99, saldo_resultante: 1000, fecha: '2000-01-01T00:00:00.000Z', id_movimiento: 77, id_traslado: 3, id_conteo: 4 }), headers('ADMINISTRADOR', { idUsuario: 12 }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id_usuario: 12, saldo_resultante: 10, id_movimiento: 1, id_traslado: null, id_conteo: null });
    expect(res.body.fecha).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('confirma el producto en ms-catalogo UNA vez, con las cabeceras de propagación', async () => {
    await post(entrada(), { ...ADM, 'X-Request-Id': 'req-mov-1' });
    expect(clients.catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
    expect(clients.catalogo.obtenerProducto).toHaveBeenCalledWith(5, { 'X-Request-Id': 'req-mov-1', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' });
  });

  it('un producto INACTIVO en el catálogo se acepta: el contrato solo exige que exista (404 si no)', async () => {
    const catalogo = { obtenerProducto: jest.fn(async (id) => ({ id_producto: id, estado: 'INACTIVO', activo: false })) };
    const otra = buildTestApp({ clients: { catalogo } });
    try {
      const res = await post(entrada(), ADM, nuevaClave(), otra.request);
      expect(res.status).toBe(201);
    } finally {
      await otra.db.destroy();
    }
  });

  it('el saldo puede llegar al máximo del INTEGER; uno más es 422 sobre "cantidad" (nunca un 500 por 22003) y el saldo queda intacto', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 1 });
    expect((await post(entrada({ cantidad: MAXIMO - 1 }))).body.saldo_resultante).toBe(MAXIMO); // control
    await db('saldos').update({ cantidad_disponible: 1 });
    datosNoValidos(await post(entrada({ cantidad: MAXIMO })), ['cantidad']);
    expect(await saldoDe()).toBe(1);
    expect(await movimientos()).toHaveLength(1);
  });
});

describe('POST /movimientos: rechazos de negocio', () => {
  it('SALIDA 7 con saldo 6 → 409 STOCK_INSUFICIENTE con disponible y solicitado; no hay movimiento nuevo', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
    const res = await post({ tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 7 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        codigo: 'STOCK_INSUFICIENTE',
        mensaje: expect.any(String),
        detalles: [{ campo: 'cantidad', mensaje: 'Disponible: 6; solicitado: 7', disponible: 6, solicitado: 7 }],
      },
    });
    expect(await saldoDe()).toBe(6);
    expect(await movimientos()).toEqual([]);
  });

  it('SALIDA sobre un producto SIN saldo en esa bodega → 409 y no queda ninguna fila de saldo', async () => {
    stockInsuficiente(await post({ tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 1 }), 0, 1);
    expect(await db('saldos')).toEqual([]);
  });

  it('bodega inexistente → 404 NO_EXISTE; producto 999 → 404 NO_EXISTE; nada se escribe', async () => {
    await control();
    recursoNoExiste(await post(entrada({ id_bodega: 9999 })));
    recursoNoExiste(await post(entrada({ id_producto: 999 })));
    expect(await movimientos()).toHaveLength(1);
    expect(await db('saldos')).toHaveLength(1);
  });

  it('bodega inactiva → 409 BODEGA_INACTIVA (D12) y el saldo no cambia', async () => {
    await control();
    await db('bodegas').where({ id_bodega: b1 }).update({ activa: false });
    esError(await post(entrada()), 409, 'BODEGA_INACTIVA');
    expect(await saldoDe()).toBe(10);
    expect(await movimientos()).toHaveLength(1);
  });

  it('catálogo caído → 503 SERVICIO_NO_DISPONIBLE; no hay movimiento ni cambio de saldo', async () => {
    await control();
    esError(await post(entrada(), ADM, nuevaClave(), requestCaido), 503, 'SERVICIO_NO_DISPONIBLE');
    expect(catalogoCaido.obtenerProducto).toHaveBeenCalledTimes(1);
    expect(await saldoDe()).toBe(10);
    expect(await movimientos()).toHaveLength(1);
  });
});

describe('POST /movimientos: tipos reservados (D4)', () => {
  it.each(['TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL'])('%s por esta ruta → 403 SIN_PERMISO, antes que el catálogo y sin escribir nada', async (tipo) => {
    await control();
    esError(await post(entrada({ tipo })), 403, 'SIN_PERMISO');
    catalogoSinLlamadas();
    expect(await movimientos()).toHaveLength(1);
  });

  it('el 403 del tipo reservado va antes que la validación del resto del cuerpo', async () => {
    esError(await post({ tipo: 'CARGA_INICIAL', cantidad: 'x' }), 403, 'SIN_PERMISO');
  });

  it('ENTRADA_COMPRA y DEVOLUCION_PROVEEDOR se aceptan con las cabeceras de un usuario (ms-compras usa las mismas)', async () => {
    expect((await post(entrada({ tipo: 'ENTRADA_COMPRA', cantidad: 5 }))).status).toBe(201);
    expect((await post(entrada({ tipo: 'DEVOLUCION_PROVEEDOR', cantidad: 2 }), headers('OPERADOR_BODEGA', { idBodega: b1 }))).status).toBe(201);
    expect(await saldoDe()).toBe(3);
  });

  it('un tipo inventado, en minúsculas, null o ausente → 422 sobre "tipo" (no 403)', async () => {
    for (const tipo of ['REGALO', 'entrada', null, undefined]) {
      datosNoValidos(await post(entrada({ tipo })), ['tipo']);
    }
    catalogoSinLlamadas();
  });
});

describe('POST /movimientos: validación del cuerpo (422)', () => {
  it.each([
    [0], [-1], [1.5], ['abc'], ['5'], [null], [undefined], [MAXIMO + 1], [true], [[5]], [{ valor: 5 }],
  ])('ENTRADA con cantidad %p → 422 sobre "cantidad", sin llamar al catálogo', async (cantidad) => {
    datosNoValidos(await post(entrada({ cantidad })), ['cantidad']);
    catalogoSinLlamadas();
  });

  it('cantidad -0 (JSON) → 422: no es un entero positivo; en AJUSTE es 0', async () => {
    const cuerpo = (tipo) => `{"tipo":"${tipo}","id_producto":5,"id_bodega":${b1},"cantidad":-0}`;
    datosNoValidos(await request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave()).set('Content-Type', 'application/json').send(cuerpo('ENTRADA')), ['cantidad']);
    datosNoValidos(await request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave()).set('Content-Type', 'application/json').send(cuerpo('AJUSTE')), ['cantidad']);
  });

  it('cantidad 5.0 y 1e3 en el JSON son los enteros 5 y 1000 (JSON no los distingue) → 201', async () => {
    const enviar = (literal) => request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave()).set('Content-Type', 'application/json')
      .send(`{"tipo":"ENTRADA","id_producto":5,"id_bodega":${b1},"cantidad":${literal}}`);
    expect((await enviar('5.0')).body).toMatchObject({ cantidad: 5, saldo_resultante: 5 });
    expect((await enviar('1e3')).body).toMatchObject({ cantidad: 1000, saldo_resultante: 1005 });
  });

  it.each([[1.5], [-MAXIMO - 1], ['-2'], [null]])('AJUSTE con cantidad %p → 422 sobre "cantidad"', async (cantidad) => {
    datosNoValidos(await post(entrada({ tipo: 'AJUSTE', cantidad })), ['cantidad']);
  });

  it.each(['id_producto', 'id_bodega'])('%s: "5", 0, -1, 1.5, fuera del INTEGER, null o ausente → 422 sobre ese campo', async (campo) => {
    for (const valor of ['5', 0, -1, 1.5, MAXIMO + 1, null, undefined]) datosNoValidos(await post(entrada({ [campo]: valor })), [campo]);
    catalogoSinLlamadas();
  });

  it.each([['documento_referencia', 100], ['observacion', 500]])('%s: acepta %p caracteres (el largo de la columna) y rechaza uno más con 422, nunca el 22001', async (campo, largo) => {
    const exacto = await post(entrada({ [campo]: 'x'.repeat(largo) }));
    expect(exacto.status).toBe(201);
    expect(exacto.body[campo]).toBe('x'.repeat(largo));
    datosNoValidos(await post(entrada({ [campo]: 'x'.repeat(largo + 1) })), [campo]);
    // Se mide en caracteres, como varchar(n): un emoji ocupa dos unidades UTF-16 pero es un carácter.
    expect((await post(entrada({ [campo]: '😀'.repeat(largo) }))).status).toBe(201);
  });

  it.each(['documento_referencia', 'observacion'])('%s: null se acepta (se guarda null); vacío, solo espacios o un número → 422', async (campo) => {
    expect((await post(entrada({ [campo]: null }))).body[campo]).toBeNull();
    for (const valor of ['', '   ', 5, ['x'], 'a\u0000b']) datosNoValidos(await post(entrada({ [campo]: valor })), [campo]);
  });

  it('informa a la vez todos los campos inválidos, en el orden del contrato', async () => {
    datosNoValidos(await post({ tipo: 'X', id_producto: 0, id_bodega: 'b', cantidad: 0, documento_referencia: '', observacion: 7 }), ['tipo', 'id_producto', 'id_bodega', 'cantidad', 'documento_referencia', 'observacion']);
  });

  it('cuerpo vacío → 422 con los cuatro obligatorios; un arreglo → 422 sobre "cuerpo"; texto, null o JSON roto → 400', async () => {
    datosNoValidos(await post(undefined), ['tipo', 'id_producto', 'id_bodega', 'cantidad']);
    datosNoValidos(await post({}), ['tipo', 'id_producto', 'id_bodega', 'cantidad']);
    datosNoValidos(await post([entrada()]), ['cuerpo']);
    const crudo = (texto) => request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave()).set('Content-Type', 'application/json').send(texto);
    // express.json() es estricto: un JSON cuyo valor raíz no es objeto ni arreglo es 400, como el JSON mal formado.
    esError(await crudo('"ENTRADA"'), 400, 'PETICION_MAL_FORMADA');
    esError(await crudo('null'), 400, 'PETICION_MAL_FORMADA');
    esError(await crudo('{"tipo":'), 400, 'PETICION_MAL_FORMADA');
    catalogoSinLlamadas();
    expect(await movimientos()).toEqual([]);
  });

  // Los lotes (id_lote, lote: D27) se prueban en movimientosLotes.test.js.

  it.each([
    ['__proto__ en el cuerpo', '{"__proto__":{"tipo":"ENTRADA"},"tipo":"ENTRADA","id_producto":5,"id_bodega":1,"cantidad":1}'],
    ['constructor', '{"constructor":{"prototype":{"x":1}},"tipo":"ENTRADA","id_producto":5,"id_bodega":1,"cantidad":1}'],
    ['un objeto anidado en cada campo', '{"tipo":{"$ne":null},"id_producto":{"a":1},"id_bodega":[1],"cantidad":{"valueOf":1}}'],
    ['números enormes', '{"tipo":"ENTRADA","id_producto":1e400,"id_bodega":-1e400,"cantidad":123456789012345678901234567890}'],
    ['inyección SQL en los textos', '{"tipo":"ENTRADA\'; DROP TABLE movimientos;--","id_producto":5,"id_bodega":1,"cantidad":1,"observacion":"\'); DELETE FROM saldos;--"}'],
    ['un sustituto UTF-16 suelto', '{"tipo":"ENTRADA","id_producto":5,"id_bodega":1,"cantidad":1,"observacion":"\\ud800"}'],
  ])('entrada hostil (%s) → nunca un 5xx', async (_caso, texto) => {
    const res = await request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave()).set('Content-Type', 'application/json').send(texto);
    expect(res.status).toBeLessThan(500);
    expect(await db('bodegas')).toHaveLength(2); // nada se ejecutó como SQL
  });

  it('la inyección SQL en observacion se guarda como texto literal y no ejecuta nada', async () => {
    const res = await post(entrada({ observacion: "'); DELETE FROM saldos;--" }));
    expect(res.status).toBe(201);
    expect(res.body.observacion).toBe("'); DELETE FROM saldos;--");
    expect(await saldoDe()).toBe(10);
  });
});

describe('POST /movimientos: identidad y alcance de bodega', () => {
  it('sin X-User-Id → 401 NO_AUTENTICADO (antes que la clave), sin llamar al catálogo ni escribir', async () => {
    esError(await request.post('/movimientos').set('Idempotency-Key', 'k').send(entrada()), 401, 'NO_AUTENTICADO');
    esError(await request.post('/movimientos').send(entrada()), 401, 'NO_AUTENTICADO');
    catalogoSinLlamadas();
    expect(await movimientos()).toEqual([]);
  });

  it('OPERADOR_BODEGA en su bodega → 201; en otra → 403 SIN_PERMISO sin llamar al catálogo', async () => {
    const operador = headers('OPERADOR_BODEGA', { idBodega: b1 });
    expect((await post(entrada(), operador)).status).toBe(201);
    clients.catalogo.obtenerProducto.mockClear();
    esError(await post(entrada({ id_bodega: b2 }), operador), 403, 'SIN_PERMISO');
    catalogoSinLlamadas();
    expect(await saldoDe(5, b2)).toBeUndefined();
  });

  it('OPERADOR_BODEGA sin X-User-Bodega → 403 SIN_PERMISO', async () => {
    await control({}, headers('OPERADOR_BODEGA', { idBodega: b1 }));
    esError(await post(entrada(), headers('OPERADOR_BODEGA')), 403, 'SIN_PERMISO');
    catalogoSinLlamadas();
  });

  it('ADMINISTRADOR en cualquier bodega → 201 (también con una X-User-Bodega distinta)', async () => {
    expect((await post(entrada({ id_bodega: b1 }))).status).toBe(201);
    expect((await post(entrada({ id_bodega: b2 }), headers('ADMINISTRADOR', { idBodega: b1 }))).status).toBe(201);
  });

  it('el cuerpo inválido (422) se informa antes que el alcance de bodega (403)', async () => {
    datosNoValidos(await post(entrada({ id_bodega: b2, cantidad: 0 }), headers('OPERADOR_BODEGA', { idBodega: b1 })), ['cantidad']);
  });
});

describe('POST /movimientos: Idempotency-Key (RNF17, D7, D25)', () => {
  describe('cabecera (400 PETICION_MAL_FORMADA)', () => {
    it.each([
      ['ausente', null],
      ['vacía', ''],
      ['solo espacios', '    '],
      ['de 201 caracteres', 'k'.repeat(201)],
    ])('%s → 400, sin llamar al catálogo ni escribir', async (_caso, clave) => {
      await control();
      esError(await post(entrada(), ADM, clave), 400, 'PETICION_MAL_FORMADA');
      catalogoSinLlamadas();
      expect(await movimientos()).toHaveLength(1);
    });

    it('con "#" → 400 (D25c: chocaría con una clave derivada); el control "abc-1" sí pasa', async () => {
      expect((await post(entrada(), ADM, 'abc-1')).status).toBe(201);
      clients.catalogo.obtenerProducto.mockClear();
      for (const clave of ['abc#1', '#', 'a#', 'centinela#9']) esError(await post(entrada(), ADM, clave), 400, 'PETICION_MAL_FORMADA');
      // El mensaje no repite el valor recibido.
      expect((await post(entrada(), ADM, 'centinela#9')).body.error.mensaje).not.toContain('centinela');
      catalogoSinLlamadas();
      expect(await movimientos()).toHaveLength(1);
    });

    it('de 200 caracteres → 201 (y se guarda con el prefijo del usuario y la operación: cabe en varchar(255))', async () => {
      expect((await post(entrada(), ADM, 'k'.repeat(200))).status).toBe(201);
      expect((await movimientos())[0].clave_idempotencia).toBe(`7:mov:${'k'.repeat(200)}`);
    });

    it('sin espacios en los extremos: " abc " y "abc" son la MISMA clave', async () => {
      expect((await post(entrada(), ADM, 'abc')).status).toBe(201);
      expect((await post(entrada(), ADM, ' abc ')).status).toBe(200);
    });

    it('repetida en dos líneas llega unida con ", " y se le aplica la misma regla de largo', async () => {
      const dos = (a, b) => request.post('/movimientos').set(ADM).set('Idempotency-Key', [a, b]).send(entrada());
      const corta = await dos('a', 'b');
      expect(corta.status).toBe(201);
      expect((await movimientos())[0].clave_idempotencia).toBe('7:mov:a, b');
      esError(await dos('x'.repeat(100), 'y'.repeat(100)), 400, 'PETICION_MAL_FORMADA');
    });

    it('la clave se distingue entre mayúsculas y minúsculas', async () => {
      expect((await post(entrada(), ADM, 'Clave')).status).toBe(201);
      expect((await post(entrada(), ADM, 'clave')).status).toBe(201);
    });
  });

  describe('repetición', () => {
    it('misma clave del MISMO usuario: 201 y luego 200 con el mismo movimiento; el saldo cambia UNA vez', async () => {
      const primera = await post(entrada(), ADM, 'k1');
      const segunda = await post(entrada(), ADM, 'k1');
      expect(primera.status).toBe(201);
      expect(segunda.status).toBe(200);
      expect(segunda.body).toEqual(primera.body);
      expect(await saldoDe()).toBe(10);
      expect(await movimientos()).toHaveLength(1);
    });

    it('misma clave con OTRO cuerpo (cantidad 99, otra bodega) → 200 con el movimiento original (D7)', async () => {
      const primera = await post(entrada(), ADM, 'k1');
      const segunda = await post(entrada({ cantidad: 99, id_bodega: b2, tipo: 'SALIDA' }), ADM, 'k1');
      expect(segunda.status).toBe(200);
      expect(segunda.body).toEqual(primera.body);
      expect(await saldoDe(5, b2)).toBeUndefined();
    });

    it('OTRO usuario con la MISMA clave → 201 y su propio movimiento (D25: la clave es por usuario)', async () => {
      const uno = await post(entrada(), headers('ADMINISTRADOR', { idUsuario: 7 }), 'k1');
      const otro = await post(entrada({ cantidad: 3 }), headers('ADMINISTRADOR', { idUsuario: 8 }), 'k1');
      expect([uno.status, otro.status]).toEqual([201, 201]);
      expect(otro.body.id_movimiento).not.toBe(uno.body.id_movimiento);
      expect(otro.body).toMatchObject({ id_usuario: 8, cantidad: 3, saldo_resultante: 13 });
      expect((await movimientos()).map((fila) => fila.clave_idempotencia)).toEqual(['7:mov:k1', '8:mov:k1']);
    });

    it('D25b: un movimiento de OTRA operación del mismo usuario con la misma clave (7:tras:k) NO es una repetición de POST /movimientos', async () => {
      const { OPERACIONES, claveAlmacenada } = require('../src/services/idempotencia');
      const movimientoRepository = require('../src/repositories/movimientoRepository');
      const deTraslado = claveAlmacenada(7, OPERACIONES.TRASLADO, 'k');
      expect(deTraslado).not.toBe(claveAlmacenada(7, OPERACIONES.MOVIMIENTO, 'k'));
      const sembrado = await movimientoRepository.insert(db, {
        tipo: 'TRASLADO_ENTRADA', idProducto: 5, idBodega: b1, cantidad: 2, saldoResultante: 2, idUsuario: 7, claveIdempotencia: deTraslado,
      });
      const res = await post(entrada(), ADM, 'k');
      expect(res.status).toBe(201);
      expect(res.body.id_movimiento).not.toBe(sembrado.id_movimiento);
      expect(res.body.tipo).toBe('ENTRADA');
      expect((await movimientos()).map((fila) => fila.clave_idempotencia)).toEqual(['7:tras:k', '7:mov:k']);
      expect((await post(entrada(), ADM, 'k')).status).toBe(200); // la suya sí se repite
    });

    it('la clave almacenada es inyectiva: el usuario 1 con la clave "2:x" y el usuario 12 con la clave "x" no chocan', async () => {
      expect((await post(entrada(), headers('ADMINISTRADOR', { idUsuario: 1 }), '2:x')).status).toBe(201);
      expect((await post(entrada(), headers('ADMINISTRADOR', { idUsuario: 12 }), 'x')).status).toBe(201);
      expect((await post(entrada(), headers('ADMINISTRADOR', { idUsuario: 12 }), ':x')).status).toBe(201);
    });

    it('la repetición se responde ANTES que el cuerpo, los permisos y el catálogo: un 200 aunque ahora el cuerpo sea inválido, el tipo reservado o la bodega inactiva', async () => {
      const primera = await post(entrada(), ADM, 'k1');
      clients.catalogo.obtenerProducto.mockClear();
      await db('bodegas').where({ id_bodega: b1 }).update({ activa: false });
      for (const cuerpo of [{}, entrada({ cantidad: -5 }), entrada({ tipo: 'CARGA_INICIAL' }), entrada({ id_lote: 0 }), [1]]) {
        const res = await post(cuerpo, ADM, 'k1');
        expect({ estado: res.status, cuerpo: res.body }).toEqual({ estado: 200, cuerpo: primera.body });
      }
      catalogoSinLlamadas();
    });

    it('un reintento tras un éxito con ms-catalogo CAÍDO sigue dando 200 (la repetición se resuelve en local)', async () => {
      const primera = await post(entrada(), ADM, 'k1');
      const reintento = await post(entrada(), ADM, 'k1', requestCaido);
      expect(reintento.status).toBe(200);
      expect(reintento.body).toEqual(primera.body);
      expect(catalogoCaido.obtenerProducto).not.toHaveBeenCalled();
    });

    it('los errores NO se guardan: un 409 no deja la clave y el reintento con la misma clave tras reponer stock da 201', async () => {
      const salida = { tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 4 };
      stockInsuficiente(await post(salida, ADM, 'k-salida'), 0, 4);
      expect(await movimientos()).toEqual([]);
      await control({ cantidad: 5 });
      const reintento = await post(salida, ADM, 'k-salida');
      expect(reintento.status).toBe(201);
      expect(reintento.body.saldo_resultante).toBe(1);
    });

    it.each([
      ['422', (clave) => post(entrada({ cantidad: 0 }), ADM, clave)],
      ['403', (clave) => post(entrada({ id_bodega: b2 }), headers('OPERADOR_BODEGA', { idBodega: b1 }), clave)],
      ['404', (clave) => post(entrada({ id_producto: 999 }), ADM, clave)],
      ['503', (clave) => post(entrada(), ADM, clave, requestCaido)],
    ])('un %s tampoco guarda la clave: el reintento corregido con la misma clave da 201', async (_estado, fallar) => {
      const res = await fallar('k-err');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await movimientos()).toEqual([]);
      expect((await post(entrada(), ADM, 'k-err')).status).toBe(201);
    });
  });

  describe('concurrencia', () => {
    it('22 peticiones idénticas a la vez con la misma clave → un 201, veintiún 200, un solo movimiento y el saldo cambia una vez', async () => {
      const respuestas = await Promise.all(Array.from({ length: 22 }, () => post(entrada(), ADM, 'k-race')));
      const estados = respuestas.map((res) => res.status);
      expect(estados.filter((estado) => estado === 201)).toHaveLength(1);
      expect(estados.filter((estado) => estado === 200)).toHaveLength(21);
      expect(new Set(respuestas.map((res) => res.body.id_movimiento)).size).toBe(1);
      expect(await movimientos()).toHaveLength(1);
      expect(await saldoDe()).toBe(10);
    });

    it('misma clave a la vez con cuerpos sobre saldos DISTINTOS (otra bodega) → un 201, un 200 y un solo movimiento', async () => {
      const [a, b] = await Promise.all([post(entrada({ id_bodega: b1 }), ADM, 'k-dos'), post(entrada({ id_bodega: b2 }), ADM, 'k-dos')]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id_movimiento).toBe(b.body.id_movimiento);
      expect(await movimientos()).toHaveLength(1);
      expect(await db('saldos')).toHaveLength(1); // la que perdió deshizo también el saldo que había creado
    });

    it('misma clave a la vez con una SALIDA que agota el stock → un 201 y el resto 200 (nunca un 409 para la repetición)', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
      const salida = { tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 3 };
      const respuestas = await Promise.all(Array.from({ length: 6 }, () => post(salida, ADM, 'k-agota')));
      expect(respuestas.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(await saldoDe()).toBe(0);
      expect(await movimientos()).toHaveLength(1);
    });

    it('cinco SALIDA de 3 a la vez (claves distintas) con saldo 10 → exactamente tres 201 y dos 409; saldo final 1 y tres filas en el kardex', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
      const respuestas = await Promise.all([1, 2, 3, 4, 5].map((i) => post({ tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: 3 }, ADM, `c${i}`)));
      expect(respuestas.filter((res) => res.status === 201)).toHaveLength(3);
      expect(respuestas.filter((res) => res.status === 409)).toHaveLength(2);
      for (const res of respuestas.filter((r) => r.status === 409)) expect(res.body.error.codigo).toBe('STOCK_INSUFICIENTE');
      expect(await saldoDe()).toBe(1);
      expect(await movimientos()).toHaveLength(3);
    });

    it('D24 por HTTP: doce movimientos concurrentes ordenados por (fecha, id_movimiento) encadenan sus saldo_resultante', async () => {
      await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 30 });
      const pedidos = [5, -3, 4, -1, 7, -2, 3, -6, 1, -4, 2, -5].map((n) => (n > 0
        ? { tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, cantidad: n }
        : { tipo: 'SALIDA', id_producto: 5, id_bodega: b1, cantidad: -n }));
      const respuestas = await Promise.all(pedidos.map((cuerpo) => post(cuerpo)));
      expect(respuestas.map((res) => res.status)).toEqual(Array(12).fill(201));
      let esperado = 30;
      for (const fila of await db('movimientos').orderBy([{ column: 'fecha' }, { column: 'id_movimiento' }])) {
        esperado += tipos.delta(fila.tipo, fila.cantidad);
        expect(fila.saldo_resultante).toBe(esperado);
      }
      expect(await saldoDe()).toBe(esperado);
      expect(esperado).toBe(31);
    });
  });

  describe('la carrera que pierde el INSERT (23505)', () => {
    it('23505 de la clave sin movimiento que leer (no debería ocurrir) → 500 ERROR_INTERNO genérico y registrado con el error original', async () => {
      jest.spyOn(stockService, 'aplicarMovimiento').mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'movimientos_clave_idempotencia_key' }));
      esError(await post(entrada(), ADM, 'k-fantasma'), 500, 'ERROR_INTERNO');
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ estado: 500, error: expect.objectContaining({ mensaje: 'duplicate key' }) }));
    });

    it('un 23505 de OTRA restricción no es una repetición: el error original llega al manejador (500) tal cual', async () => {
      const original = Object.assign(new Error('otro duplicado'), { code: '23505', constraint: 'saldos_id_producto_id_bodega_key' });
      jest.spyOn(stockService, 'aplicarMovimiento').mockRejectedValue(original);
      esError(await post(entrada(), ADM, 'k-otro'), 500, 'ERROR_INTERNO');
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ estado: 500, error: expect.objectContaining({ mensaje: 'otro duplicado' }) }));
    });

    it('si el INSERT pierde contra una clave ya confirmada, se responde 200 con el movimiento guardado', async () => {
      const primera = await post(entrada(), ADM, 'k1');
      // Simula la carrera: la búsqueda inicial no lo ve (llegó antes del commit del otro) y el motor choca con la unicidad.
      const movimientoRepository = require('../src/repositories/movimientoRepository');
      const real = movimientoRepository.findByClave;
      jest.spyOn(movimientoRepository, 'findByClave').mockImplementationOnce(async () => undefined).mockImplementation(real);
      const res = await post(entrada({ cantidad: 4 }), ADM, 'k1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(primera.body);
      expect(await saldoDe()).toBe(10); // la transacción que perdió deshizo su saldo
    });
  });
});

describe('POST /movimientos: aviso de stock bajo (D13)', () => {
  const aviso = () => clients.notificaciones.notificarStockBajo;
  const salida = (cantidad, idBodega = b1) => ({ tipo: 'SALIDA', id_producto: 5, id_bodega: idBodega, cantidad });

  it('umbral 5: la SALIDA que deja el total en 5 no avisa; la que lo deja en 4 avisa UNA vez con los datos exactos y las cabeceras de propagación', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 5 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
    expect((await post(salida(1))).status).toBe(201); // total 5 = mínimo: no es «por debajo»
    expect(aviso()).not.toHaveBeenCalled();
    const res = await post(salida(1), { ...ADM, 'X-Request-Id': 'req-aviso' });
    expect(res.status).toBe(201);
    expect(aviso()).toHaveBeenCalledTimes(1);
    expect(aviso()).toHaveBeenCalledWith(
      { idProducto: 5, idBodega: b1, cantidadTotal: 4, cantidadMinima: 5 },
      { 'X-Request-Id': 'req-aviso', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' },
    );
  });

  it('el umbral suma TODAS las bodegas: 3 + 3 y 3 + 2 contra mínimo 5 no avisan; 3 + 1 = 4 sí, con cantidadTotal 4', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 5 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 4 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 3 });
    expect((await post(salida(1))).status).toBe(201); // 3 + 3 = 6
    expect(aviso()).not.toHaveBeenCalled();
    expect((await post(salida(1, b2))).status).toBe(201); // 3 + 2 = 5
    expect(aviso()).not.toHaveBeenCalled();
    expect((await post(salida(1, b2))).status).toBe(201); // 3 + 1 = 4 < 5, aunque la bodega b2 sola tenga 1
    expect(aviso()).toHaveBeenCalledTimes(1);
    expect(aviso().mock.calls[0][0]).toEqual({ idProducto: 5, idBodega: b2, cantidadTotal: 4, cantidadMinima: 5 });
  });

  it('sin umbral no avisa nunca, ni con el saldo en 0', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 1 });
    expect((await post(salida(1))).status).toBe(201);
    expect(aviso()).not.toHaveBeenCalled();
  });

  it('un umbral de 0 no avisa nunca (nada es menor que 0)', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 0 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 1 });
    expect((await post(salida(1))).status).toBe(201);
    expect(aviso()).not.toHaveBeenCalled();
  });

  it('se evalúa tras CADA movimiento (D13): una ENTRADA o un AJUSTE que dejan el total aún bajo el mínimo también avisan', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 50 });
    expect((await post(entrada({ cantidad: 10 }))).status).toBe(201);
    expect((await post(entrada({ tipo: 'AJUSTE', cantidad: -1 }))).status).toBe(201);
    expect(aviso().mock.calls.map(([datos]) => datos.cantidadTotal)).toEqual([10, 9]);
  });

  it('solo avisa del producto del movimiento: el umbral de otro producto no cuenta', async () => {
    await crearUmbral(db, { idProducto: 6, cantidadMinima: 100 });
    await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 1 });
    expect((await post(entrada())).status).toBe(201);
    expect(aviso()).not.toHaveBeenCalled();
  });

  it('una repetición (200) no vuelve a avisar, ni un rechazo (409)', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 50 });
    await post(entrada(), ADM, 'k1');
    expect(aviso()).toHaveBeenCalledTimes(1);
    expect((await post(entrada(), ADM, 'k1')).status).toBe(200);
    stockInsuficiente(await post(salida(99)), 10, 99);
    expect(aviso()).toHaveBeenCalledTimes(1);
  });

  it('el aviso NO se espera: con ms-notificaciones colgado (una promesa que nunca se resuelve) el movimiento responde 201', async () => {
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 50 });
    aviso().mockReturnValue(new Promise(() => {}));
    const res = await post(entrada());
    expect(res.status).toBe(201);
    expect(aviso()).toHaveBeenCalledTimes(1);
  });

  describe('un fallo del aviso o de la lectura del umbral no cambia el 201 (se registra y nunca se propaga)', () => {
    const descripcion = expect.objectContaining({ nombre: 'Error', mensaje: expect.any(String), pila: expect.any(String) });

    beforeEach(() => crearUmbral(db, { idProducto: 5, cantidadMinima: 50 }));

    it('ms-notificaciones RECHAZA → 201, el fallo queda registrado y el rechazo tiene manejador (ningún unhandledRejection)', async () => {
      // Dentro del sandbox de Jest `process.on('unhandledRejection')` no recibe nada (Jest intercepta esos rechazos y hace
      // fallar la prueba en curso). Por eso se comprueba directamente que la promesa rechazada recibe un manejador de rechazo.
      const rechazada = Promise.reject(new Error('ms-notificaciones caído'));
      const then = jest.spyOn(rechazada, 'then');
      aviso().mockReturnValue(rechazada);
      const res = await post(entrada());
      expect(res.status).toBe(201);
      await new Promise((resolver) => setImmediate(resolver));
      expect(then.mock.calls.some(([, alRechazar]) => typeof alRechazar === 'function')).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ mensaje: expect.any(String), id_producto: 5, id_bodega: b1, error: expect.objectContaining({ mensaje: 'ms-notificaciones caído' }) }));
      expect(await saldoDe()).toBe(10);
    });

    it('ms-notificaciones LANZA de forma síncrona → 201 y registrado', async () => {
      aviso().mockImplementation(() => { throw new Error('fallo síncrono'); });
      expect((await post(entrada())).status).toBe(201);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ id_producto: 5, error: descripcion }));
    });

    it('la lectura del umbral falla → 201, registrado con { nombre, mensaje, pila } y sin aviso', async () => {
      jest.spyOn(umbralRepository, 'findByProducto').mockRejectedValue(new Error('lectura rota'));
      const res = await post(entrada());
      expect(res.status).toBe(201);
      expect(await saldoDe()).toBe(10);
      expect(aviso()).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ mensaje: expect.any(String), id_producto: 5, id_bodega: b1, error: expect.objectContaining({ nombre: 'Error', mensaje: 'lectura rota', pila: expect.any(String) }) }));
    });
  });
});
