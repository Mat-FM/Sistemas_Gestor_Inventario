const saldoRepository = require('../src/repositories/saldoRepository');
const movimientoRepository = require('../src/repositories/movimientoRepository');
const { OPERACIONES, claveAlmacenada } = require('../src/services/idempotencia');
const stockService = require('../src/services/stockService');
const { buildTestApp } = require('./helpers/app');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearSaldo, fakeCatalogo, headers } = require('./helpers/fixtures');
const { AGOTADO, esperarConPlazo } = require('./helpers/hijos');
const { ISO_8601, datosNoValidos, esError, recursoNoExiste, stockInsuficiente } = require('./helpers/respuestas');

// Traslados entre bodegas (RF04) de punta a punta, contra PostgreSQL real y con clientes falsos: POST /traslados (crear: saca del
// origen y deja EN_TRANSITO). El motor (bloqueos, lotes, D28(a)) se prueba en stock.test.js; las capas por separado en
// trasladosCapas.test.js.
//
// Tras CADA prueba se comprueban en la base dos invariantes: por (producto, bodega) la suma de los lotes nunca supera el saldo
// ni hay lotes negativos (D27(c)), y todo traslado tiene exactamente su movimiento TRASLADO_SALIDA (nunca uno sin el otro: la
// transacción los escribe juntos, D31(e)).

const ADM = headers('ADMINISTRADOR');
const CLAVES_TRASLADO = [
  'id_traslado', 'id_producto', 'id_bodega_origen', 'id_bodega_destino', 'id_lote', 'cantidad', 'estado', 'fecha_envio',
  'fecha_recepcion', 'id_usuario_envia', 'id_usuario_recibe',
];
const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];

let request;
let db;
let clients;
// Segunda aplicación sobre la MISMA base con el catálogo caído: ms-catalogo no responde (503).
let requestCaido;
let dbCaido;
let catalogoCaido;
let b1;
let b2;
let b3;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp());
  ({ request: requestCaido, db: dbCaido, clients: { catalogo: catalogoCaido } } = buildTestApp({ clients: { catalogo: fakeCatalogo({ caido: true }) } }));
});
beforeEach(async () => {
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
  b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
  b3 = (await crearBodega(db, { codigo: 'B3' })).id_bodega;
  clients.catalogo.obtenerProducto.mockClear();
  catalogoCaido.obtenerProducto.mockClear();
  clients.notificaciones.notificarStockBajo.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await comprobarInvariantes();
});
afterAll(() => Promise.all([db.destroy(), dbCaido.destroy()]));

let contador = 0;
const nuevaClave = () => `kt-${(contador += 1)}`;
// POST /traslados con las cabeceras y la clave dadas; `clave` null no envía la cabecera.
function crear(cuerpo, { cabeceras = ADM, clave = nuevaClave(), cliente = request } = {}) {
  const peticion = cliente.post('/traslados').set(cabeceras);
  if (clave !== null) peticion.set('Idempotency-Key', clave);
  return peticion.send(cuerpo);
}
const traslado = (extra = {}) => ({ id_producto: 5, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 3, ...extra });

const saldoDe = async (idBodega = b1, idProducto = 5) => (await db('saldos').where({ id_producto: idProducto, id_bodega: idBodega }).first())?.cantidad_disponible;
const lotes = () => db('lotes').select('id_lote', 'id_bodega', 'id_producto', 'codigo_lote', 'fecha_vencimiento', 'cantidad_disponible').orderBy('id_lote');
const traslados = () => db('traslados').select('*').orderBy('id_traslado');
const movimientos = () => db('movimientos').select('*').orderBy('id_movimiento');
// Foto de todo lo que un rechazo no debe cambiar.
const foto = async () => ({ saldos: await db('saldos').select('*').orderBy('id_saldo'), lotes: await lotes(), traslados: await traslados(), movimientos: await movimientos() });
const catalogoSinLlamadas = () => expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
const sinCincoXX = (respuestas) => expect(respuestas.filter((res) => res.status >= 500).map((res) => res.body)).toEqual([]);

async function comprobarInvariantes() {
  const { rows: pares } = await db.raw(`
    SELECT l.id_producto, l.id_bodega, SUM(l.cantidad_disponible)::int AS en_lotes, MIN(l.cantidad_disponible) AS minimo,
           COALESCE(MAX(s.cantidad_disponible), 0) AS saldo
    FROM lotes l LEFT JOIN saldos s ON s.id_producto = l.id_producto AND s.id_bodega = l.id_bodega
    GROUP BY l.id_producto, l.id_bodega`);
  for (const fila of pares) expect({ ...fila, cumple: fila.en_lotes <= fila.saldo && fila.minimo >= 0 }).toEqual({ ...fila, cumple: true });
  const { rows: huerfanos } = await db.raw(`
    SELECT t.id_traslado, COUNT(m.id_movimiento)::int AS salidas
    FROM traslados t LEFT JOIN movimientos m ON m.id_traslado = t.id_traslado AND m.tipo = 'TRASLADO_SALIDA'
    GROUP BY t.id_traslado HAVING COUNT(m.id_movimiento) <> 1`);
  expect(huerfanos).toEqual([]);
}

// Control positivo antes de un rechazo: un traslado válido de b1 a b2 que debe dar 201 (siembra el stock que necesita).
async function control(extra = {}, cabeceras = ADM) {
  await db('saldos').insert({ id_producto: 5, id_bodega: b1, cantidad_disponible: 0 }).onConflict(['id_producto', 'id_bodega']).ignore();
  await db('saldos').where({ id_producto: 5, id_bodega: b1 }).increment('cantidad_disponible', 3);
  const res = await crear(traslado(extra), { cabeceras });
  expect(res.status).toBe(201);
  clients.catalogo.obtenerProducto.mockClear();
  return res.body;
}

describe('POST /traslados: creación (201)', () => {
  it('sin lote: 201 EN_TRANSITO con exactamente sus campos y el movimiento TRASLADO_SALIDA; el origen baja y el destino NO cambia', async () => {
    /* RF04: la mercancía sale del origen y queda en tránsito; nada llega todavía al destino. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const res = await crear(traslado(), { clave: 'k-crear' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES_TRASLADO, 'movimiento'].sort());
    expect(res.body).toEqual({
      id_traslado: 1, id_producto: 5, id_bodega_origen: b1, id_bodega_destino: b2, id_lote: null, cantidad: 3, estado: 'EN_TRANSITO',
      fecha_envio: expect.stringMatching(ISO_8601), fecha_recepcion: null, id_usuario_envia: 7, id_usuario_recibe: null,
      movimiento: {
        id_movimiento: 1, tipo: 'TRASLADO_SALIDA', id_producto: 5, id_bodega: b1, id_lote: null, id_traslado: 1, id_conteo: null,
        cantidad: 3, saldo_resultante: 7, fecha: expect.stringMatching(ISO_8601), id_usuario: 7, documento_referencia: null, observacion: null,
      },
    });
    expect(Object.keys(res.body.movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO].sort());
    expect(await saldoDe(b1)).toBe(7);
    expect(await saldoDe(b2)).toBeUndefined();
    const [fila] = await traslados();
    expect(fila).toMatchObject({ estado: 'EN_TRANSITO', cantidad: 3, id_usuario_envia: 7, id_usuario_recibe: null, fecha_recepcion: null });
    expect(res.body.fecha_envio).toBe(fila.fecha_envio.toISOString());
  });

  it('la clave del movimiento es la derivada «salida» de la operación «tras» (D25d) y la respuesta no la expone', async () => {
    /* D31(a): base = <usuario>:tras:<clave>; TRASLADO_SALIDA lleva base#salida. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const res = await crear(traslado(), { clave: 'mi-clave' });
    expect(res.body.movimiento).not.toHaveProperty('clave_idempotencia');
    expect(res.body).not.toHaveProperty('clave_idempotencia');
    expect((await movimientos())[0].clave_idempotencia).toBe('7:tras:mi-clave#salida');
  });

  it('con id_lote: resta de ESE lote (aunque haya stock sin lote y otro lote que vence antes) y el traslado y el movimiento lo llevan', async () => {
    /* D28(a): un traslado mueve 0 o 1 lote, nunca reparte por FEFO. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 20 });
    const antes = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', fechaVencimiento: '2027-01-01', cantidad: 5 });
    const pedido = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'B', fechaVencimiento: '2027-06-30', cantidad: 8 });
    const res = await crear(traslado({ cantidad: 6, id_lote: pedido.id_lote }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id_lote: pedido.id_lote, cantidad: 6, movimiento: { id_lote: pedido.id_lote, saldo_resultante: 14 } });
    expect((await lotes()).map((l) => [l.id_lote, l.cantidad_disponible])).toEqual([[antes.id_lote, 5], [pedido.id_lote, 2]]);
    expect((await traslados())[0].id_lote).toBe(pedido.id_lote);
  });

  it('los campos que fija el servidor se ignoran (estado, usuarios, fechas, id_traslado)', async () => {
    /* Campos extra del cuerpo: se descartan. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const res = await crear(traslado({
      estado: 'RECIBIDO', id_usuario_envia: 99, id_usuario_recibe: 98, fecha_envio: '2000-01-01T00:00:00.000Z', fecha_recepcion: '2000-01-01T00:00:00.000Z', id_traslado: 77,
    }), { cabeceras: headers('ADMINISTRADOR', { idUsuario: 12 }) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id_traslado: 1, estado: 'EN_TRANSITO', id_usuario_envia: 12, id_usuario_recibe: null, fecha_recepcion: null });
    expect(res.body.fecha_envio).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('confirma el producto en ms-catalogo UNA vez, con las cabeceras de propagación, y no avisa a ms-notificaciones (D13)', async () => {
    /* Llamada 1 de la Tabla 2; el umbral no se evalúa tras TRASLADO_*. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    await db('umbrales_producto').insert({ id_producto: 5, cantidad_minima: 100 });
    expect((await crear(traslado(), { cabeceras: { ...ADM, 'X-Request-Id': 'req-tras-1' } })).status).toBe(201);
    expect(clients.catalogo.obtenerProducto).toHaveBeenCalledTimes(1);
    expect(clients.catalogo.obtenerProducto).toHaveBeenCalledWith(5, { 'X-Request-Id': 'req-tras-1', 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR' });
    expect(clients.notificaciones.notificarStockBajo).not.toHaveBeenCalled();
  });
});

describe('POST /traslados: stock y lotes (409/404 sin dejar NADA escrito)', () => {
  it('stock insuficiente → 409 STOCK_INSUFICIENTE con los datos del saldo; no queda traslado, movimiento ni cambio de saldo', async () => {
    /* La transacción se deshace entera: también el traslado insertado antes del motor. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 2 });
    const antes = await foto();
    stockInsuficiente(await crear(traslado({ cantidad: 3 })), 'cantidad', 2, 3);
    expect(await foto()).toEqual(antes);
    expect(await traslados()).toEqual([]);
  });

  it('sin id_lote con el stock SOLO en lotes → 409 pidiendo id_lote (disponible sin lote 0) y nada cambia; con id_lote sí sale', async () => {
    /* D28(a): sin id_lote un traslado solo mueve stock sin lote; nunca hace FEFO. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 8 });
    const lote = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', fechaVencimiento: '2027-01-01', cantidad: 8 });
    const antes = await foto();
    const res = await crear(traslado());
    stockInsuficiente(res, 'cantidad', 0, 3);
    expect(res.body.error.mensaje).toMatch(/id_lote/);
    expect(await foto()).toEqual(antes);
    expect((await crear(traslado({ id_lote: lote.id_lote }))).status).toBe(201);
  });

  it('id_lote inexistente, de OTRA bodega o de OTRO producto → 404 NO_EXISTE sin escribir nada; el lote propio sí', async () => {
    /* El lote debe ser de la bodega de ORIGEN y del producto. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 10 });
    await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 10 });
    const propio = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'P', fechaVencimiento: '2027-01-01', cantidad: 4 });
    const ajenoBodega = await crearLote(db, { idBodega: b3, idProducto: 5, codigoLote: 'X', fechaVencimiento: '2027-01-01', cantidad: 4 });
    const ajenoProducto = await crearLote(db, { idBodega: b1, idProducto: 6, codigoLote: 'Y', fechaVencimiento: '2027-01-01', cantidad: 4 });
    const antes = await foto();
    for (const idLote of [9999, ajenoBodega.id_lote, ajenoProducto.id_lote]) recursoNoExiste(await crear(traslado({ id_lote: idLote })));
    expect(await foto()).toEqual(antes);
    expect((await crear(traslado({ id_lote: propio.id_lote }))).status).toBe(201);
  });

  it('D28(a): si el destino YA tiene el código con OTRA fecha → 409 CONFLICTO al CREAR y el origen no se toca; con la MISMA fecha → 201', async () => {
    /* Sin esta comprobación previa la recepción fallaría después con la mercancía en tránsito. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 10 });
    const origen = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 10 });
    await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-02-28', cantidad: 1 });
    await crearLote(db, { idBodega: b3, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 1 });
    const antes = await foto();
    const res = await crear(traslado({ id_lote: origen.id_lote }));
    esError(res, 409, 'CONFLICTO', ['id_lote']);
    expect(await foto()).toEqual(antes);
    expect((await crear(traslado({ id_lote: origen.id_lote, id_bodega_destino: b3 }))).status).toBe(201); // control: misma fecha
  });

  it('D28(a): un lote de origen SIN fecha contra el mismo código CON fecha en el destino también es 409 CONFLICTO (y al revés)', async () => {
    /* Una fecha nula frente a una fecha es «otra fecha» (D27(d)): no se mezcla mercancía sin vencimiento con mercancía que vence. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 10 });
    const sinFecha = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'N', fechaVencimiento: null, cantidad: 5 });
    const conFecha = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'F', fechaVencimiento: '2027-01-01', cantidad: 5 });
    await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'N', fechaVencimiento: '2027-01-01', cantidad: 1 });
    await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'F', fechaVencimiento: null, cantidad: 1 });
    const antes = await foto();
    esError(await crear(traslado({ id_lote: sinFecha.id_lote })), 409, 'CONFLICTO', ['id_lote']);
    esError(await crear(traslado({ id_lote: conFecha.id_lote })), 409, 'CONFLICTO', ['id_lote']);
    expect(await foto()).toEqual(antes);
  });
});

describe('POST /traslados: bodegas, producto y catálogo', () => {
  beforeEach(() => crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 }));

  it('bodega de origen o de destino inexistente → 404 NO_EXISTE; nada se escribe', async () => {
    /* Las claves foráneas del traslado nunca llegan a fallar (un 23503 sería un 500). */
    await control();
    const antes = await foto();
    recursoNoExiste(await crear(traslado({ id_bodega_origen: 9999 })));
    recursoNoExiste(await crear(traslado({ id_bodega_destino: 9999 })));
    expect(await foto()).toEqual(antes);
  });

  it.each([['origen', 'b1'], ['destino', 'b2']])('bodega de %s inactiva → 409 BODEGA_INACTIVA (D12); nada se escribe', async (_cual, cual) => {
    /* Origen: lo decide el motor dentro de la transacción; destino: la comprobación previa. */
    await control();
    await db('bodegas').where({ id_bodega: cual === 'b1' ? b1 : b2 }).update({ activa: false });
    const antes = await foto();
    esError(await crear(traslado()), 409, 'BODEGA_INACTIVA');
    expect(await foto()).toEqual(antes);
  });

  it('producto inexistente en el catálogo → 404 NO_EXISTE; nada se escribe', async () => {
    /* Llamada 1: el producto debe existir. */
    await control();
    const antes = await foto();
    recursoNoExiste(await crear(traslado({ id_producto: 999 })));
    expect(await foto()).toEqual(antes);
  });

  it('catálogo caído → 503 SERVICIO_NO_DISPONIBLE; nada se escribe', async () => {
    /* Llamada «con espera»: si el destino no responde, se rechaza la operación. */
    await control();
    const antes = await foto();
    esError(await crear(traslado(), { cliente: requestCaido }), 503, 'SERVICIO_NO_DISPONIBLE');
    expect(catalogoCaido.obtenerProducto).toHaveBeenCalledTimes(1);
    expect(await foto()).toEqual(antes);
  });
});

describe('POST /traslados: validación del cuerpo (422)', () => {
  // Las matrices de cada validador están en validate.test.js: aquí, un caso inválido por campo y su control positivo.
  it.each([
    ['id_producto', 0], ['id_bodega_origen', '1'], ['id_bodega_destino', null], ['cantidad', 1.5], ['id_lote', 0],
  ])('%s = %p → 422 solo sobre ese campo, sin llamar al catálogo ni escribir', async (campo, valor) => {
    /* Control positivo: el mismo cuerpo sin el valor inválido da 201. */
    await control();
    datosNoValidos(await crear(traslado({ [campo]: valor })), [campo]);
    catalogoSinLlamadas();
    expect(await traslados()).toHaveLength(1);
  });

  it('id_lote null se trata como ausente → 201 sin lote', async () => {
    /* `id_lote?` es opcional y anulable. */
    expect((await control({ id_lote: null })).id_lote).toBeNull();
  });

  it('origen y destino iguales → 422 sobre "id_bodega_destino" (contrato: «422 misma bodega»), antes del alcance y del catálogo', async () => {
    /* Control: distintas dan 201. La base también lo prohíbe (traslados_bodegas_distintas), pero nunca debe llegar ahí. */
    await control();
    datosNoValidos(await crear(traslado({ id_bodega_destino: b1 })), ['id_bodega_destino']);
    datosNoValidos(await crear(traslado({ id_bodega_destino: b1 }), { cabeceras: headers('OPERADOR_BODEGA', { idBodega: b2 }) }), ['id_bodega_destino']);
    catalogoSinLlamadas();
  });

  it('informa a la vez todos los campos inválidos, en el orden del contrato (la misma bodega, al final)', async () => {
    /* Un solo 422 con todos los detalles. */
    datosNoValidos(await crear({ id_producto: 'x', id_bodega_origen: b1, id_bodega_destino: b1, cantidad: 0, id_lote: -1 }), ['id_producto', 'cantidad', 'id_lote', 'id_bodega_destino']);
    datosNoValidos(await crear({}), ['id_producto', 'id_bodega_origen', 'id_bodega_destino', 'cantidad']);
  });

  it('un cuerpo que no es un objeto (arreglo) → 422 sobre "cuerpo"', async () => {
    /* express.json() admite arreglos. */
    datosNoValidos(await crear([traslado()]), ['cuerpo']);
    catalogoSinLlamadas();
  });
});

describe('POST /traslados: identidad y alcance (el operador envía solo desde SU bodega)', () => {
  beforeEach(() => crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 }));

  it('sin X-User-Id → 401 NO_AUTENTICADO, sin llamar al catálogo ni escribir', async () => {
    /* D8, D22: toda escritura exige usuario. */
    esError(await request.post('/traslados').set('Idempotency-Key', 'k').send(traslado()), 401, 'NO_AUTENTICADO');
    catalogoSinLlamadas();
    expect(await traslados()).toEqual([]);
  });

  it('OPERADOR de la bodega de ORIGEN → 201; el de la bodega de DESTINO u otra → 403 SIN_PERMISO sin llamar al catálogo', async () => {
    /* D31(g): «403 bodega de origen ajena». */
    expect((await crear(traslado(), { cabeceras: headers('OPERADOR_BODEGA', { idBodega: b1 }) })).status).toBe(201);
    clients.catalogo.obtenerProducto.mockClear();
    const antes = await foto();
    esError(await crear(traslado(), { cabeceras: headers('OPERADOR_BODEGA', { idBodega: b2 }) }), 403, 'SIN_PERMISO');
    esError(await crear(traslado(), { cabeceras: headers('OPERADOR_BODEGA', { idBodega: b3 }) }), 403, 'SIN_PERMISO');
    catalogoSinLlamadas();
    expect(await foto()).toEqual(antes);
  });

  it('OPERADOR sin X-User-Bodega → 403 SIN_PERMISO', async () => {
    /* Restricción global 4. */
    esError(await crear(traslado(), { cabeceras: headers('OPERADOR_BODEGA') }), 403, 'SIN_PERMISO');
    catalogoSinLlamadas();
  });

  it('ADMINISTRADOR desde cualquier bodega (también con una X-User-Bodega distinta) → 201', async () => {
    /* El administrador no tiene alcance de bodega. */
    await crearSaldo(db, { idProducto: 5, idBodega: b3, cantidad: 10 });
    expect((await crear(traslado({ id_bodega_origen: b3 }), { cabeceras: headers('ADMINISTRADOR', { idBodega: b1 }) })).status).toBe(201);
  });
});

describe('POST /traslados: Idempotency-Key (RNF17, D7, D25, D31)', () => {
  beforeEach(() => crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 }));

  it.each([['ausente', null], ['vacía', ''], ['de 201 caracteres', 'k'.repeat(201)], ['con «#»', 'abc#1']])('cabecera %s → 400 PETICION_MAL_FORMADA, sin catálogo ni escritura', async (_caso, clave) => {
    /* Control: una clave válida da 201. */
    await control();
    esError(await crear(traslado(), { clave }), 400, 'PETICION_MAL_FORMADA');
    catalogoSinLlamadas();
    expect(await traslados()).toHaveLength(1);
  });

  it('misma clave del MISMO usuario → 201 y luego 200 con el MISMO traslado y movimiento; un solo descuento', async () => {
    /* D7: la repetición devuelve la respuesta original. */
    const primera = await crear(traslado(), { clave: 'k1' });
    const segunda = await crear(traslado(), { clave: 'k1' });
    expect([primera.status, segunda.status]).toEqual([201, 200]);
    expect(segunda.body).toEqual(primera.body);
    expect(await saldoDe(b1)).toBe(7);
    expect(await traslados()).toHaveLength(1);
    expect(await movimientos()).toHaveLength(1);
  });

  it('misma clave con OTRO cuerpo (otra cantidad, otro destino, inválido) → 200 con el original, sin catálogo ni permisos (D7)', async () => {
    /* La repetición se responde antes que el cuerpo, el alcance y el catálogo. */
    const primera = await crear(traslado(), { clave: 'k1' });
    clients.catalogo.obtenerProducto.mockClear();
    for (const cuerpo of [traslado({ cantidad: 9, id_bodega_destino: b3 }), {}, [1]]) {
      const res = await crear(cuerpo, { clave: 'k1' });
      expect({ estado: res.status, cuerpo: res.body }).toEqual({ estado: 200, cuerpo: primera.body });
    }
    expect((await crear(traslado(), { clave: 'k1', cabeceras: headers('OPERADOR_BODEGA', { idUsuario: 7, idBodega: b3 }) })).status).toBe(200);
    catalogoSinLlamadas();
    expect(await saldoDe(b1)).toBe(7);
  });

  it('OTRO usuario con la MISMA clave → 201 con su propio traslado (D25)', async () => {
    /* La clave se acota por usuario. */
    const uno = await crear(traslado(), { clave: 'k1', cabeceras: headers('ADMINISTRADOR', { idUsuario: 7 }) });
    const otro = await crear(traslado({ cantidad: 2 }), { clave: 'k1', cabeceras: headers('ADMINISTRADOR', { idUsuario: 8 }) });
    expect([uno.status, otro.status]).toEqual([201, 201]);
    expect(otro.body.id_traslado).not.toBe(uno.body.id_traslado);
    expect(otro.body).toMatchObject({ id_usuario_envia: 8, cantidad: 2 });
    expect(await saldoDe(b1)).toBe(5);
  });

  it('D25b: la misma clave usada en POST /movimientos por el mismo usuario NO es una repetición del traslado (y al revés)', async () => {
    /* La clave se acota por operación: «mov» y «tras» no chocan. */
    const mov = await request.post('/movimientos').set(ADM).set('Idempotency-Key', 'k').send({ tipo: 'ENTRADA', id_producto: 5, id_bodega: b1, cantidad: 1 });
    expect(mov.status).toBe(201);
    const res = await crear(traslado(), { clave: 'k' });
    expect(res.status).toBe(201);
    expect(res.body.movimiento.id_movimiento).not.toBe(mov.body.id_movimiento);
    expect((await movimientos()).map((fila) => fila.clave_idempotencia)).toEqual(['7:mov:k', '7:tras:k#salida']);
  });

  it('un 409 NO guarda la clave: el reintento con la misma clave tras reponer stock da 201', async () => {
    /* Los errores no se cachean (D25). */
    stockInsuficiente(await crear(traslado({ cantidad: 11 }), { clave: 'k-err' }), 'cantidad', 10, 11);
    expect(await traslados()).toEqual([]);
    await db('saldos').where({ id_producto: 5, id_bodega: b1 }).update({ cantidad_disponible: 11 });
    const reintento = await crear(traslado({ cantidad: 11 }), { clave: 'k-err' });
    expect(reintento.status).toBe(201);
    expect(reintento.body.movimiento.saldo_resultante).toBe(0);
  });

  it.each([
    ['422', (clave) => crear(traslado({ cantidad: 0 }), { clave })],
    ['403', (clave) => crear(traslado(), { clave, cabeceras: headers('OPERADOR_BODEGA', { idBodega: b2 }) })],
    ['404', (clave) => crear(traslado({ id_producto: 999 }), { clave })],
    ['503', (clave) => crear(traslado(), { clave, cliente: requestCaido })],
  ])('un %s tampoco guarda la clave: el reintento corregido con la misma clave da 201', async (_estado, fallar) => {
    /* Ningún 4xx/5xx deja una fila residual. */
    expect((await fallar('k-err')).status).toBeGreaterThanOrEqual(400);
    expect(await traslados()).toEqual([]);
    expect((await crear(traslado(), { clave: 'k-err' })).status).toBe(201);
  });

  it('un reintento tras un éxito con ms-catalogo CAÍDO sigue dando 200 (la repetición se resuelve en local)', async () => {
    /* D7: la repetición no depende de otros servicios. */
    const primera = await crear(traslado(), { clave: 'k1' });
    const reintento = await crear(traslado(), { clave: 'k1', cliente: requestCaido });
    expect(reintento.status).toBe(200);
    expect(reintento.body).toEqual(primera.body);
    expect(catalogoCaido.obtenerProducto).not.toHaveBeenCalled();
  });

  it('si el INSERT pierde contra una clave ya confirmada (la búsqueda inicial no la vio) → 200 con el traslado original y nada duplicado', async () => {
    /* resolverFallo relee la clave de salida tras el fallo de la transacción. */
    const primera = await crear(traslado(), { clave: 'k1' });
    const real = movimientoRepository.findByClave;
    jest.spyOn(movimientoRepository, 'findByClave').mockImplementationOnce(async () => undefined).mockImplementation(real);
    const res = await crear(traslado({ cantidad: 4 }), { clave: 'k1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(primera.body);
    expect(await traslados()).toHaveLength(1);
    expect(await saldoDe(b1)).toBe(7);
  });

  it('un fallo del motor que no es de negocio → 500 ERROR_INTERNO genérico y el traslado insertado se deshace con todo', async () => {
    /* El traslado y su movimiento van en la misma transacción. */
    jest.spyOn(stockService, 'aplicarMovimiento').mockRejectedValue(new Error('fallo del motor'));
    const antes = await foto();
    esError(await crear(traslado()), 500, 'ERROR_INTERNO');
    expect(await foto()).toEqual(antes);
  });

  it('la clave guardada es la de ESTA operación: claveAlmacenada(7, «tras», k) más el sufijo de salida', async () => {
    /* D25d: nadie concatena a mano; el formato lo da idempotencia.js. */
    await crear(traslado(), { clave: 'k1' });
    expect((await movimientos())[0].clave_idempotencia).toBe(`${claveAlmacenada(7, OPERACIONES.TRASLADO, 'k1')}#salida`);
  });
});

describe('POST /traslados: concurrencia (PostgreSQL real)', () => {
  it('5 creaciones simultáneas de 3 con stock 10 (claves distintas) → exactamente tres 201 y dos 409; saldo 1, tres traslados y tres TRASLADO_SALIDA', async () => {
    /* El saldo de origen serializa las creaciones; los rechazos no dejan traslado. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const respuestas = await Promise.all([1, 2, 3, 4, 5].map((i) => crear(traslado(), { clave: `c${i}` })));
    sinCincoXX(respuestas);
    expect(respuestas.filter((res) => res.status === 201)).toHaveLength(3);
    expect(respuestas.filter((res) => res.status === 409).map((res) => res.body.error.codigo)).toEqual(['STOCK_INSUFICIENTE', 'STOCK_INSUFICIENTE']);
    expect(await saldoDe(b1)).toBe(1);
    expect((await traslados()).map((t) => t.estado)).toEqual(['EN_TRANSITO', 'EN_TRANSITO', 'EN_TRANSITO']);
    expect((await movimientos()).map((m) => m.tipo)).toEqual(['TRASLADO_SALIDA', 'TRASLADO_SALIDA', 'TRASLADO_SALIDA']);
  });

  it('10 creaciones idénticas a la vez con la MISMA clave → un 201 y nueve 200 con el mismo traslado; un solo descuento', async () => {
    /* La perdedora del INSERT relee por la clave (resolverFallo). */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const respuestas = await Promise.all(Array.from({ length: 10 }, () => crear(traslado(), { clave: 'k-race' })));
    sinCincoXX(respuestas);
    expect(respuestas.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(respuestas.map((res) => res.body.id_traslado)).size).toBe(1);
    expect(new Set(respuestas.map((res) => res.body.movimiento.id_movimiento)).size).toBe(1);
    expect(await traslados()).toHaveLength(1);
    expect(await saldoDe(b1)).toBe(7);
  });

  it('con id_lote, mientras otra transacción tiene el saldo de origen y luego toma ese lote FOR UPDATE (como una salida FEFO) → sin interbloqueo: las dos terminan', async () => {
    /* Orden de bloqueo de la creación: saldo de origen ANTES del INSERT del traslado (su clave foránea toma FOR KEY SHARE del lote). */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const lote = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', fechaVencimiento: '2027-01-01', cantidad: 10 });
    const otra = await db.transaction();
    let pendiente;
    try {
      await saldoRepository.bloquear(otra, { idProducto: 5, idBodega: b1 });
      pendiente = crear(traslado({ id_lote: lote.id_lote })).then((res) => res);
      await esperarBloqueo(db);
      // Con el orden equivocado esta espera cerraría un ciclo y PostgreSQL abortaría una de las dos con 40P01 (deadlock_timeout 1 s).
      const tomado = await esperarConPlazo(otra('lotes').where({ id_lote: lote.id_lote }).forUpdate().first(), 3000);
      expect(tomado).not.toBe(AGOTADO);
      expect(tomado).toMatchObject({ id_lote: lote.id_lote });
      await otra.commit();
    } catch (error) {
      await otra.rollback().catch(() => {});
      throw error;
    }
    const res = await pendiente;
    expect(res.status).toBe(201);
    expect(res.body.id_lote).toBe(lote.id_lote);
  });
});
