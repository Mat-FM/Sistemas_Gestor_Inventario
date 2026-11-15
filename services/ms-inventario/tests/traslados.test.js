const knex = require('knex');
const supertest = require('supertest');
const { createApp } = require('../src/app');
const { construirConfigKnex } = require('../src/config/db');
const { delta } = require('../src/domain/tipos');
const saldoRepository = require('../src/repositories/saldoRepository');
const movimientoRepository = require('../src/repositories/movimientoRepository');
const { OPERACIONES, claveAlmacenada } = require('../src/services/idempotencia');
const stockService = require('../src/services/stockService');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { configDePrueba, truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearSaldo, fakeCatalogo, headers } = require('./helpers/fixtures');
const { AGOTADO, esperarConPlazo } = require('./helpers/hijos');
const { ISO_8601, datosNoValidos, esError, recursoNoExiste, stockInsuficiente } = require('./helpers/respuestas');

// Traslados entre bodegas (RF04) de punta a punta, contra PostgreSQL real y con clientes falsos: POST /traslados (crear: saca del
// origen y deja EN_TRANSITO), POST /traslados/{id}/recepcion (recibir: suma al destino y deja RECIBIDO) y GET /traslados (el
// listado). El motor (bloqueos, lotes, D28(a)) se prueba en stock.test.js; las capas por separado en trasladosCapas.test.js.
//
// Tras CADA prueba se comprueban en la base dos invariantes: por (producto, bodega) la suma de los lotes nunca supera el saldo
// ni hay lotes negativos (D27(c)), y todo traslado tiene exactamente su movimiento TRASLADO_SALIDA y, solo si está RECIBIDO,
// exactamente un TRASLADO_ENTRADA (nunca un estado sin su movimiento: la transacción los escribe juntos, D31(e)).

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
    SELECT t.id_traslado, t.estado,
           COUNT(m.id_movimiento) FILTER (WHERE m.tipo = 'TRASLADO_SALIDA')::int AS salidas,
           COUNT(m.id_movimiento) FILTER (WHERE m.tipo = 'TRASLADO_ENTRADA')::int AS entradas
    FROM traslados t LEFT JOIN movimientos m ON m.id_traslado = t.id_traslado
    GROUP BY t.id_traslado, t.estado
    HAVING COUNT(m.id_movimiento) FILTER (WHERE m.tipo = 'TRASLADO_SALIDA') <> 1
        OR COUNT(m.id_movimiento) FILTER (WHERE m.tipo = 'TRASLADO_ENTRADA') <> (CASE WHEN t.estado = 'RECIBIDO' THEN 1 ELSE 0 END)
        OR (t.estado = 'RECIBIDO') <> (t.fecha_recepcion IS NOT NULL AND t.id_usuario_recibe IS NOT NULL)`);
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

// ---------------------------------------------------------------------------------------------------------------------------
// POST /traslados/{id}/recepcion
// ---------------------------------------------------------------------------------------------------------------------------

// POST /traslados/{id}/recepcion; `clave` null no envía la cabecera.
function recibir(id, cuerpo = {}, { cabeceras = ADM, clave = nuevaClave(), cliente = request } = {}) {
  const peticion = cliente.post(`/traslados/${id}/recepcion`).set(cabeceras);
  if (clave !== null) peticion.set('Idempotency-Key', clave);
  return peticion.send(cuerpo);
}
const OPE = (idBodega, idUsuario = 8) => headers('OPERADOR_BODEGA', { idUsuario, idBodega });

// Un traslado EN_TRANSITO creado por la API (siembra antes en el origen el stock que necesita). Devuelve la respuesta (201).
async function enTransito(extra = {}) {
  const cuerpo = traslado(extra);
  await db('saldos').insert({ id_producto: cuerpo.id_producto, id_bodega: cuerpo.id_bodega_origen, cantidad_disponible: 0 }).onConflict(['id_producto', 'id_bodega']).ignore();
  if (cuerpo.id_lote === undefined) await db('saldos').where({ id_producto: cuerpo.id_producto, id_bodega: cuerpo.id_bodega_origen }).increment('cantidad_disponible', cuerpo.cantidad);
  const res = await crear(cuerpo);
  expect(res.status).toBe(201);
  clients.catalogo.obtenerProducto.mockClear();
  return res.body;
}

describe('POST /traslados/{id}/recepcion: recepción (200)', () => {
  it('sin lote, por el OPERADOR del destino: 200 RECIBIDO con fecha_recepcion e id_usuario_recibe, y el movimiento TRASLADO_ENTRADA en el destino', async () => {
    /* RF04: la mercancía en tránsito entra al destino; el origen no vuelve a cambiar. */
    const creado = await enTransito();
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 4 });
    const res = await recibir(creado.id_traslado, { observacion: '  Llegó completo  ' }, { cabeceras: OPE(b2), clave: 'k-rec' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES_TRASLADO, 'movimiento'].sort());
    expect(res.body).toEqual({
      ...creado, estado: 'RECIBIDO', fecha_recepcion: expect.stringMatching(ISO_8601), id_usuario_recibe: 8,
      movimiento: {
        id_movimiento: 2, tipo: 'TRASLADO_ENTRADA', id_producto: 5, id_bodega: b2, id_lote: null, id_traslado: creado.id_traslado, id_conteo: null,
        cantidad: 3, saldo_resultante: 7, fecha: expect.stringMatching(ISO_8601), id_usuario: 8, documento_referencia: null, observacion: 'Llegó completo',
      },
    });
    expect(res.body.fecha_recepcion >= res.body.fecha_envio).toBe(true);
    expect(await saldoDe(b2)).toBe(7);
    expect(await saldoDe(b1)).toBe(0);
    const [fila] = await traslados();
    expect(fila).toMatchObject({ estado: 'RECIBIDO', id_usuario_recibe: 8 });
    expect(res.body.fecha_recepcion).toBe(fila.fecha_recepcion.toISOString());
    expect((await movimientos()).map((m) => m.clave_idempotencia)).toEqual([expect.stringMatching(/^7:tras:kt-\d+#salida$/), '8:tras:k-rec#entrada']);
    expect(res.body.movimiento).not.toHaveProperty('clave_idempotencia');
  });

  it('el destino SIN saldo previo nace con la cantidad; la observación es opcional (ausente, null o sin cuerpo)', async () => {
    /* `{observacion?}`. */
    for (const cuerpo of [{}, { observacion: null }, undefined]) {
      const creado = await enTransito();
      const res = await recibir(creado.id_traslado, cuerpo);
      expect(res.status).toBe(200);
      expect(res.body.movimiento.observacion).toBeNull();
    }
    expect(await saldoDe(b2)).toBe(9);
  });

  it('con lote: el destino recrea el MISMO codigo_lote con la MISMA fecha; el movimiento lleva el lote del DESTINO y el traslado conserva el de origen', async () => {
    /* D28(a): un traslado mueve un lote entero de una bodega a otra. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const origen = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 10 });
    const creado = await enTransito({ cantidad: 4, id_lote: origen.id_lote });
    const res = await recibir(creado.id_traslado);
    expect(res.status).toBe(200);
    const destino = (await lotes()).find((l) => l.id_bodega === b2);
    expect(destino).toMatchObject({ id_producto: 5, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad_disponible: 4 });
    expect(res.body).toMatchObject({ id_lote: origen.id_lote, movimiento: { id_lote: destino.id_lote, saldo_resultante: 4 } });
    expect((await traslados())[0].id_lote).toBe(origen.id_lote);
    expect(await saldoDe(b2)).toBe(4);
  });

  it('con lote que YA existe en el destino con la MISMA fecha: le SUMA (no crea otro)', async () => {
    /* INSERT … ON CONFLICT del motor. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 6 });
    const origen = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 10 });
    const existente = await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'L1', fechaVencimiento: '2027-01-31', cantidad: 5 });
    const creado = await enTransito({ cantidad: 4, id_lote: origen.id_lote });
    const res = await recibir(creado.id_traslado);
    expect(res.body.movimiento).toMatchObject({ id_lote: existente.id_lote, saldo_resultante: 10 });
    expect((await lotes()).filter((l) => l.id_bodega === b2)).toEqual([expect.objectContaining({ id_lote: existente.id_lote, cantidad_disponible: 9 })]);
  });

  it('un lote de origen SIN fecha se recrea en el destino sin fecha', async () => {
    /* La fecha nula también se conserva. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    const origen = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'SF', fechaVencimiento: null, cantidad: 3 });
    const creado = await enTransito({ id_lote: origen.id_lote });
    expect((await recibir(creado.id_traslado)).status).toBe(200);
    expect((await lotes()).find((l) => l.id_bodega === b2)).toMatchObject({ codigo_lote: 'SF', fecha_vencimiento: null, cantidad_disponible: 3 });
  });

  it('si DESPUÉS de crear el destino tiene ese lote con OTRA fecha (o con fecha, siendo el de origen sin fecha) → 409 CONFLICTO y sigue EN_TRANSITO', async () => {
    /* Limitación documentada: la comprobación de la creación no puede impedir que el destino cree el lote después. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
    const conFecha = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'F', fechaVencimiento: '2027-01-31', cantidad: 3 });
    const sinFecha = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'N', fechaVencimiento: null, cantidad: 3 });
    const uno = await enTransito({ id_lote: conFecha.id_lote });
    const dos = await enTransito({ id_lote: sinFecha.id_lote });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 2 });
    await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'F', fechaVencimiento: '2027-12-31', cantidad: 1 });
    await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'N', fechaVencimiento: '2027-12-31', cantidad: 1 });
    const antes = await foto();
    expect((await recibir(uno.id_traslado)).body.error.codigo).toBe('CONFLICTO');
    esError(await recibir(dos.id_traslado), 409, 'CONFLICTO', ['id_lote']);
    expect(await foto()).toEqual(antes);
    expect((await traslados()).map((t) => t.estado)).toEqual(['EN_TRANSITO', 'EN_TRANSITO']);
  });

  it('el ADMINISTRADOR recibe en cualquier bodega; el umbral NO se evalúa tras la recepción (D13)', async () => {
    /* El administrador no tiene alcance de bodega; TRASLADO_ENTRADA no avisa. */
    await db('umbrales_producto').insert({ id_producto: 5, cantidad_minima: 100 });
    const creado = await enTransito();
    expect((await recibir(creado.id_traslado, {}, { cabeceras: headers('ADMINISTRADOR', { idBodega: b3 }) })).status).toBe(200);
    expect(clients.notificaciones.notificarStockBajo).not.toHaveBeenCalled();
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
  });
});

describe('POST /traslados/{id}/recepcion: rechazos (nada cambia y el traslado sigue EN_TRANSITO)', () => {
  it('el OPERADOR de otra bodega (también el del ORIGEN) o sin X-User-Bodega → 403 SIN_PERMISO; el del destino sí', async () => {
    /* D31(g): «403 bodega de destino ajena». */
    const creado = await enTransito();
    const antes = await foto();
    for (const cabeceras of [OPE(b1), OPE(b3), headers('OPERADOR_BODEGA', { idUsuario: 8 })]) {
      esError(await recibir(creado.id_traslado, {}, { cabeceras }), 403, 'SIN_PERMISO');
    }
    expect(await foto()).toEqual(antes);
    expect((await recibir(creado.id_traslado, {}, { cabeceras: OPE(b2) })).status).toBe(200);
  });

  it.each([['inexistente', '9999'], ['0', '0'], ['-1', '-1'], ['abc', 'abc'], ['fuera del INTEGER', '2147483648'], ['decimal', '1.5']])('id %s → 404 NO_EXISTE', async (_caso, id) => {
    /* Control: el id real da 200. */
    const creado = await enTransito();
    recursoNoExiste(await recibir(id));
    expect((await recibir(creado.id_traslado)).status).toBe(200);
  });

  it('bodega de destino INACTIVA → 409 BODEGA_INACTIVA y el traslado sigue EN_TRANSITO; al reactivarla se recibe (D31(f))', async () => {
    /* Limitación documentada: la mercancía queda en tránsito hasta reactivar la bodega. */
    const creado = await enTransito();
    await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
    const antes = await foto();
    esError(await recibir(creado.id_traslado, {}, { clave: 'k-inactiva' }), 409, 'BODEGA_INACTIVA');
    expect(await foto()).toEqual(antes);
    await db('bodegas').where({ id_bodega: b2 }).update({ activa: true });
    expect((await recibir(creado.id_traslado, {}, { clave: 'k-inactiva' })).status).toBe(200); // el 409 no guardó la clave
  });

  it('observacion de 501 caracteres → 422 sobre "observacion" (nunca el 22001); 500 sí; un arreglo como cuerpo → 422 sobre "cuerpo"', async () => {
    /* Un caso inválido y su control positivo; la matriz de `texto` está en validate.test.js. */
    const creado = await enTransito();
    datosNoValidos(await recibir(creado.id_traslado, { observacion: 'x'.repeat(501) }), ['observacion']);
    datosNoValidos(await recibir(creado.id_traslado, [{ observacion: 'x' }]), ['cuerpo']);
    expect((await traslados())[0].estado).toBe('EN_TRANSITO');
    const res = await recibir(creado.id_traslado, { observacion: 'x'.repeat(500) });
    expect(res.status).toBe(200);
    expect(res.body.movimiento.observacion).toHaveLength(500);
  });

  it('sin X-User-Id → 401; Idempotency-Key ausente, vacía, de 201 caracteres o con «#» → 400 (antes que el id: con un id inválido también es 400)', async () => {
    /* Orden: identidad → clave → id. */
    const creado = await enTransito();
    esError(await request.post(`/traslados/${creado.id_traslado}/recepcion`).set('Idempotency-Key', 'k').send({}), 401, 'NO_AUTENTICADO');
    for (const clave of [null, '', 'k'.repeat(201), 'a#b']) esError(await recibir(creado.id_traslado, {}, { clave }), 400, 'PETICION_MAL_FORMADA');
    esError(await recibir('abc', {}, { clave: null }), 400, 'PETICION_MAL_FORMADA');
    expect((await traslados())[0].estado).toBe('EN_TRANSITO');
  });

  it('un fallo del motor que no es de negocio → 500 ERROR_INTERNO genérico, sin movimiento y el traslado sigue EN_TRANSITO', async () => {
    /* La recepción y su movimiento van en la misma transacción. */
    const creado = await enTransito();
    jest.spyOn(stockService, 'aplicarMovimiento').mockRejectedValue(new Error('fallo del motor'));
    const antes = await foto();
    esError(await recibir(creado.id_traslado), 500, 'ERROR_INTERNO');
    expect(await foto()).toEqual(antes);
  });
});

describe('POST /traslados/{id}/recepcion: Idempotency-Key (RNF17, D31)', () => {
  it('misma clave → 200 con el MISMO traslado y movimiento, sin sumar dos veces', async () => {
    /* D7: la repetición devuelve la respuesta original. */
    const creado = await enTransito();
    const primera = await recibir(creado.id_traslado, { observacion: 'uno' }, { clave: 'k-rec' });
    const segunda = await recibir(creado.id_traslado, { observacion: 'otra', extra: 1 }, { clave: 'k-rec' });
    expect([primera.status, segunda.status]).toEqual([200, 200]);
    expect(segunda.body).toEqual(primera.body);
    expect(await saldoDe(b2)).toBe(3);
    expect((await movimientos()).filter((m) => m.tipo === 'TRASLADO_ENTRADA')).toHaveLength(1);
  });

  it('la repetición se responde antes que el alcance y el cuerpo: 200 aunque ahora el usuario tenga otra bodega o el cuerpo sea inválido', async () => {
    /* Como en la creación (D7). */
    const creado = await enTransito();
    const primera = await recibir(creado.id_traslado, {}, { clave: 'k-rec', cabeceras: OPE(b2, 9) });
    for (const [cuerpo, cabeceras] of [[{}, OPE(b3, 9)], [[1], OPE(b2, 9)], [{ observacion: 5 }, OPE(b2, 9)]]) {
      const res = await recibir(creado.id_traslado, cuerpo, { clave: 'k-rec', cabeceras });
      expect({ estado: res.status, cuerpo: res.body }).toEqual({ estado: 200, cuerpo: primera.body });
    }
  });

  it('recibir otra vez con OTRA clave → 409 TRASLADO_YA_RECIBIDO; nada cambia', async () => {
    /* Contrato: «409 ya recibido». */
    const creado = await enTransito();
    expect((await recibir(creado.id_traslado)).status).toBe(200);
    const antes = await foto();
    esError(await recibir(creado.id_traslado), 409, 'TRASLADO_YA_RECIBIDO');
    expect(await foto()).toEqual(antes);
  });

  it('D31(b): la MISMA clave de recepción sobre OTRO traslado → 409 CONFLICTO y el otro sigue EN_TRANSITO; con otra clave sí se recibe', async () => {
    /* Devolver la recepción de otro traslado sería un error silencioso. */
    const uno = await enTransito();
    const dos = await enTransito();
    expect((await recibir(uno.id_traslado, {}, { clave: 'k-rec' })).status).toBe(200);
    const antes = await foto();
    esError(await recibir(dos.id_traslado, {}, { clave: 'k-rec' }), 409, 'CONFLICTO');
    expect(await foto()).toEqual(antes);
    expect((await recibir(dos.id_traslado, {}, { clave: 'k-rec-2' })).status).toBe(200);
  });

  it('D31(b) en la carrera: si la búsqueda inicial no ve la clave y el INSERT choca con la de OTRO traslado → 409 CONFLICTO, nunca 200', async () => {
    /* resolverFallo halla el movimiento por la clave, pero es de otro traslado. */
    const uno = await enTransito();
    const dos = await enTransito();
    const primera = await recibir(uno.id_traslado, {}, { clave: 'k-rec' });
    expect(primera.status).toBe(200);
    const real = movimientoRepository.findByClave;
    jest.spyOn(movimientoRepository, 'findByClave').mockImplementationOnce(async () => undefined).mockImplementation(real);
    esError(await recibir(dos.id_traslado, {}, { clave: 'k-rec' }), 409, 'CONFLICTO');
    expect((await traslados()).map((t) => t.estado)).toEqual(['RECIBIDO', 'EN_TRANSITO']);
    expect(await saldoDe(b2)).toBe(3);
  });

  it('en la carrera con la MISMA clave y el MISMO traslado (la búsqueda inicial no la ve) → 200 con la recepción original', async () => {
    /* La perdedora relee por la clave de entrada. */
    const creado = await enTransito();
    const primera = await recibir(creado.id_traslado, {}, { clave: 'k-rec' });
    const real = movimientoRepository.findByClave;
    jest.spyOn(movimientoRepository, 'findByClave').mockImplementationOnce(async () => undefined).mockImplementation(real);
    const res = await recibir(creado.id_traslado, {}, { clave: 'k-rec' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(primera.body);
  });

  it('crear y recibir con la MISMA clave literal son operaciones distintas (sufijos #salida y #entrada): las dos se ejecutan', async () => {
    /* D25d. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    const creado = await crear(traslado(), { clave: 'misma' });
    expect(creado.status).toBe(201);
    const recibido = await recibir(creado.body.id_traslado, {}, { clave: 'misma' });
    expect(recibido.status).toBe(200);
    expect(recibido.body.movimiento.tipo).toBe('TRASLADO_ENTRADA');
    expect((await movimientos()).map((m) => m.clave_idempotencia)).toEqual(['7:tras:misma#salida', '7:tras:misma#entrada']);
  });

  it('D31(c): repetir la CREACIÓN de un traslado ya recibido → 200 con el traslado en su estado ACTUAL (RECIBIDO) y el movimiento de salida original', async () => {
    /* La repetición no congela el estado del traslado. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    const creado = await crear(traslado(), { clave: 'k-c' });
    const recibido = await recibir(creado.body.id_traslado);
    const repeticion = await crear(traslado(), { clave: 'k-c' });
    expect(repeticion.status).toBe(200);
    const { movimiento: entrada, ...actual } = recibido.body;
    expect(repeticion.body).toEqual({ ...actual, movimiento: creado.body.movimiento });
    expect(entrada.tipo).toBe('TRASLADO_ENTRADA');
  });

  it('OTRO usuario con la misma clave sobre el mismo traslado no es una repetición: 409 TRASLADO_YA_RECIBIDO (D25)', async () => {
    /* La clave se acota por usuario. */
    const creado = await enTransito();
    expect((await recibir(creado.id_traslado, {}, { clave: 'k-rec', cabeceras: OPE(b2, 8) })).status).toBe(200);
    esError(await recibir(creado.id_traslado, {}, { clave: 'k-rec', cabeceras: OPE(b2, 9) }), 409, 'TRASLADO_YA_RECIBIDO');
  });
});

describe('POST /traslados/{id}/recepcion: concurrencia (PostgreSQL real)', () => {
  it('la recepción bloquea la fila del traslado ANTES de mirar el estado: si otra transacción la tiene y la deja RECIBIDO, la recepción espera y responde 409', async () => {
    /* D31(d), determinista: la espera se comprueba con esperarBloqueo, sin tiempos fijos. */
    const creado = await enTransito();
    const otra = await db.transaction();
    let pendiente;
    try {
      await otra('traslados').where({ id_traslado: creado.id_traslado }).forUpdate().first();
      pendiente = recibir(creado.id_traslado).then((res) => res);
      await esperarBloqueo(db);
      await otra('traslados').where({ id_traslado: creado.id_traslado }).update({ estado: 'RECIBIDO', fecha_recepcion: db.fn.now(), id_usuario_recibe: 99 });
      await otra('movimientos').insert({
        tipo: 'TRASLADO_ENTRADA', id_producto: 5, id_bodega: b2, cantidad: 3, saldo_resultante: 3, id_usuario: 99, id_traslado: creado.id_traslado, clave_idempotencia: 'otra-recepcion',
      });
      await otra('saldos').insert({ id_producto: 5, id_bodega: b2, cantidad_disponible: 3 });
      await otra.commit();
    } catch (error) {
      await otra.rollback().catch(() => {});
      throw error;
    }
    esError(await pendiente, 409, 'TRASLADO_YA_RECIBIDO');
    expect(await saldoDe(b2)).toBe(3);
  });

  it('6 recepciones simultáneas del MISMO traslado con 6 claves distintas → exactamente un 200 y cinco 409 TRASLADO_YA_RECIBIDO; el destino suma UNA vez', async () => {
    /* La fila del traslado serializa las recepciones. */
    const creado = await enTransito();
    const respuestas = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => recibir(creado.id_traslado, {}, { clave: `r${i}` })));
    sinCincoXX(respuestas);
    expect(respuestas.filter((res) => res.status === 200)).toHaveLength(1);
    expect(respuestas.filter((res) => res.status === 409).map((res) => res.body.error.codigo)).toEqual(Array(5).fill('TRASLADO_YA_RECIBIDO'));
    expect(await saldoDe(b2)).toBe(3);
    expect((await movimientos()).filter((m) => m.tipo === 'TRASLADO_ENTRADA')).toHaveLength(1);
  });

  it('8 recepciones simultáneas con la MISMA clave → las 8 responden 200 con el mismo id_movimiento; el destino suma UNA vez', async () => {
    /* Las perdedoras releen por la clave de entrada (resolverFallo). */
    const creado = await enTransito();
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => recibir(creado.id_traslado, {}, { clave: 'k-igual' })));
    sinCincoXX(respuestas);
    expect(respuestas.map((res) => res.status)).toEqual(Array(8).fill(200));
    expect(new Set(respuestas.map((res) => res.body.movimiento.id_movimiento)).size).toBe(1);
    expect(await saldoDe(b2)).toBe(3);
  });

  it('mezcla adversarial de creaciones, recepciones y movimientos normales sobre los mismos saldos con un pool de 3 conexiones: sin 5xx, conservación (D31(e)) y kardex encadenado', async () => {
    /* Ningún interbloqueo (40P01) ni fallo de serialización (40001); Σ saldos + Σ EN_TRANSITO solo cambia por los movimientos normales. */
    const configuracion = construirConfigKnex(configDePrueba());
    const dbChico = knex({ ...configuracion, pool: { min: 0, max: 3 } });
    const errores = [];
    const chico = supertest(createApp({ db: dbChico, clients, logger: { info() {}, error: (linea) => errores.push(linea) }, env: entornoValido() }));
    try {
      const inicial = { [b1]: 40, [b2]: 30, [b3]: 5 };
      for (const [idBodega, cantidad] of Object.entries(inicial)) await crearSaldo(db, { idProducto: 5, idBodega: Number(idBodega), cantidad });
      const loteA = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: 'A', fechaVencimiento: '2027-01-31', cantidad: 15 });
      const loteB = await crearLote(db, { idBodega: b2, idProducto: 5, codigoLote: 'B', fechaVencimiento: '2027-03-31', cantidad: 10 });
      // Traslados ya en tránsito para recibir durante la mezcla (dos con lote, en los dos sentidos).
      const previos = [];
      for (const cuerpo of [traslado({ cantidad: 2 }), traslado({ cantidad: 3, id_lote: loteA.id_lote }), traslado({ id_bodega_origen: b2, id_bodega_destino: b1, cantidad: 2, id_lote: loteB.id_lote }), traslado({ id_bodega_destino: b3, cantidad: 4 })]) {
        const res = await crear(cuerpo);
        expect(res.status).toBe(201);
        previos.push(res.body.id_traslado);
      }
      const conservado = async () => {
        const [{ total }] = await db('saldos').where({ id_producto: 5 }).sum({ total: 'cantidad_disponible' });
        const [{ transito }] = await db('traslados').where({ id_producto: 5, estado: 'EN_TRANSITO' }).sum({ transito: 'cantidad' });
        return Number(total) + Number(transito ?? 0);
      };
      const antes = await conservado();
      expect(antes).toBe(75);

      const post = (ruta, cuerpo, clave) => chico.post(ruta).set(ADM).set('Idempotency-Key', clave).send(cuerpo);
      const mov = (tipo, idBodega, cantidad, extra = {}) => ({ tipo, id_producto: 5, id_bodega: idBodega, cantidad, ...extra });
      const pedidos = [
        ...previos.flatMap((id, i) => [post(`/traslados/${id}/recepcion`, {}, `rec-${i}`), post(`/traslados/${id}/recepcion`, {}, `rec-${i}`), post(`/traslados/${id}/recepcion`, {}, `rec-otra-${i}`)]),
        ...Array.from({ length: 4 }, (_, i) => post('/traslados', traslado({ cantidad: 3 }), `c-ab-${i}`)),
        ...Array.from({ length: 3 }, (_, i) => post('/traslados', traslado({ id_bodega_origen: b2, id_bodega_destino: b1, cantidad: 4 }), `c-ba-${i}`)),
        ...Array.from({ length: 3 }, (_, i) => post('/traslados', traslado({ cantidad: 2, id_lote: loteA.id_lote }), `c-lote-${i}`)),
        post('/traslados', traslado({ cantidad: 2, id_lote: loteA.id_lote }), 'c-lote-0'),
        ...Array.from({ length: 2 }, (_, i) => post('/traslados', traslado({ id_bodega_origen: b3, id_bodega_destino: b2, cantidad: 2 }), `c-cb-${i}`)),
        ...Array.from({ length: 4 }, (_, i) => post('/movimientos', mov('SALIDA', b1, 3), `m-s1-${i}`)),
        ...Array.from({ length: 3 }, (_, i) => post('/movimientos', mov('SALIDA', b2, 4), `m-s2-${i}`)),
        ...Array.from({ length: 3 }, (_, i) => post('/movimientos', mov('ENTRADA', b1, 2, { lote: { codigo_lote: 'A', fecha_vencimiento: '2027-01-31' } }), `m-e1-${i}`)),
        ...Array.from({ length: 2 }, (_, i) => post('/movimientos', mov('ENTRADA', b2, 1, { id_lote: loteB.id_lote }), `m-e2-${i}`)),
        post('/movimientos', mov('AJUSTE', b3, -1), 'm-aj'),
        post('/movimientos', mov('SALIDA', b3, 2), 'm-s3'),
      ];
      const respuestas = await Promise.all(pedidos);
      sinCincoXX(respuestas);
      expect(errores).toEqual([]);
      for (const res of respuestas) expect([200, 201, 409]).toContain(res.status);
      for (const res of respuestas.filter((r) => r.status === 409)) expect(['STOCK_INSUFICIENTE', 'TRASLADO_YA_RECIBIDO']).toContain(res.body.error.codigo);
      // Las cuatro recepciones previas quedaron RECIBIDAS una sola vez.
      expect((await db('traslados').whereIn('id_traslado', previos).pluck('estado'))).toEqual(Array(4).fill('RECIBIDO'));

      // Conservación (D31(e)): solo los movimientos normales cambian Σ saldos + Σ EN_TRANSITO.
      const normales = await db('movimientos').whereNotIn('tipo', ['TRASLADO_SALIDA', 'TRASLADO_ENTRADA']).select('tipo', 'cantidad');
      expect(await conservado()).toBe(antes + normales.reduce((suma, fila) => suma + delta(fila.tipo, fila.cantidad), 0));

      // Kardex encadenado por bodega: desde el saldo sembrado, cada saldo_resultante es el anterior más su cambio.
      for (const idBodega of [b1, b2, b3]) {
        let saldo = inicial[idBodega];
        for (const fila of await db('movimientos').where({ id_bodega: idBodega }).orderBy([{ column: 'fecha' }, { column: 'id_movimiento' }])) {
          saldo += delta(fila.tipo, fila.cantidad);
          expect({ idBodega, id: fila.id_movimiento, saldo: fila.saldo_resultante }).toEqual({ idBodega, id: fila.id_movimiento, saldo });
        }
        expect(await saldoDe(idBodega)).toBe(saldo);
      }
    } finally {
      await dbChico.destroy();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// GET /traslados
// ---------------------------------------------------------------------------------------------------------------------------

describe('GET /traslados: listado', () => {
  // Siembra un traslado con su fecha de envío (y su movimiento de salida, y de entrada si está RECIBIDO, para respetar el
  // invariante de afterEach) DIRECTAMENTE en la base: el listado no depende del motor.
  async function sembrar({ origen, destino, estado = 'EN_TRANSITO', fecha = '2026-11-01T10:00:00Z', cantidad = 1 }) {
    const [fila] = await db('traslados').insert({
      id_producto: 5, id_bodega_origen: origen, id_bodega_destino: destino, cantidad, estado, fecha_envio: fecha, id_usuario_envia: 7,
      fecha_recepcion: estado === 'RECIBIDO' ? fecha : null, id_usuario_recibe: estado === 'RECIBIDO' ? 8 : null,
    }).returning('id_traslado');
    const base = { id_producto: 5, cantidad, saldo_resultante: 0, id_usuario: 7, id_traslado: fila.id_traslado };
    await db('movimientos').insert({ ...base, tipo: 'TRASLADO_SALIDA', id_bodega: origen, clave_idempotencia: `s-${fila.id_traslado}` });
    if (estado === 'RECIBIDO') await db('movimientos').insert({ ...base, tipo: 'TRASLADO_ENTRADA', id_bodega: destino, clave_idempotencia: `e-${fila.id_traslado}` });
    return fila.id_traslado;
  }
  const listar = (consulta = '', cabeceras = ADM) => request.get(`/traslados${consulta}`).set(cabeceras);
  const ids = (res) => res.body.datos.map((t) => t.id_traslado);

  let t;
  beforeEach(async () => {
    // t1..t6 en orden de envío; t3 y t4 comparten fecha (desempata id_traslado DESC).
    t = {};
    t.t1 = await sembrar({ origen: b1, destino: b2, fecha: '2026-11-01T10:00:00Z' });
    t.t2 = await sembrar({ origen: b2, destino: b1, fecha: '2026-11-02T10:00:00Z', estado: 'RECIBIDO' });
    t.t3 = await sembrar({ origen: b1, destino: b3, fecha: '2026-11-03T10:00:00Z' });
    t.t4 = await sembrar({ origen: b3, destino: b2, fecha: '2026-11-03T10:00:00Z', estado: 'RECIBIDO' });
    t.t5 = await sembrar({ origen: b2, destino: b3, fecha: '2026-11-04T10:00:00Z' });
    t.t6 = await sembrar({ origen: b3, destino: b1, fecha: '2026-11-05T10:00:00Z', estado: 'RECIBIDO' });
  });

  it('sin filtros: {datos, meta} con todos, del envío más reciente al más antiguo (fecha_envio DESC, id_traslado DESC) y exactamente los campos de un Traslado', async () => {
    /* Orden total y estable para recorrer páginas. */
    const res = await listar();
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([t.t6, t.t5, t.t4, t.t3, t.t2, t.t1]);
    expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 6 });
    for (const fila of res.body.datos) expect(Object.keys(fila).sort()).toEqual([...CLAVES_TRASLADO].sort());
    expect(res.body.datos.find((f) => f.id_traslado === t.t2)).toEqual({
      id_traslado: t.t2, id_producto: 5, id_bodega_origen: b2, id_bodega_destino: b1, id_lote: null, cantidad: 1, estado: 'RECIBIDO',
      fecha_envio: '2026-11-02T10:00:00.000Z', fecha_recepcion: '2026-11-02T10:00:00.000Z', id_usuario_envia: 7, id_usuario_recibe: 8,
    });
  });

  it('?estado filtra (EN_TRANSITO / RECIBIDO) con el total exacto; un estado inválido o en minúsculas → 422', async () => {
    /* Control: los dos estados válidos. */
    const enTransitoRes = await listar('?estado=EN_TRANSITO');
    expect(ids(enTransitoRes)).toEqual([t.t5, t.t3, t.t1]);
    expect(enTransitoRes.body.meta.total).toBe(3);
    expect(ids(await listar('?estado=RECIBIDO'))).toEqual([t.t6, t.t4, t.t2]);
    datosNoValidos(await listar('?estado=en_transito'), ['estado']);
  });

  it('?id_bodega filtra por ORIGEN o DESTINO, y se combina con estado (AND)', async () => {
    /* Un traslado aparece en el listado de sus dos bodegas. */
    expect(ids(await listar(`?id_bodega=${b1}`))).toEqual([t.t6, t.t3, t.t2, t.t1]);
    expect(ids(await listar(`?id_bodega=${b2}`))).toEqual([t.t5, t.t4, t.t2, t.t1]);
    const combinado = await listar(`?id_bodega=${b1}&estado=EN_TRANSITO`);
    expect(ids(combinado)).toEqual([t.t3, t.t1]);
    expect(combinado.body.meta.total).toBe(2);
    expect((await listar('?id_bodega=9999')).body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
  });

  it('recorrido completo de 2 en 2: sin repetidos ni faltantes y el total de TODAS las filas en cada página; una página fuera de rango → vacía con el total', async () => {
    /* ms-reportes recorre todas las páginas hasta pagina * por_pagina >= total. */
    const vistos = [];
    for (let pagina = 1; pagina <= 3; pagina += 1) {
      const res = await listar(`?pagina=${pagina}&por_pagina=2`);
      expect(res.body.meta).toEqual({ pagina, por_pagina: 2, total: 6 });
      expect(res.body.datos).toHaveLength(2);
      vistos.push(...ids(res));
    }
    expect(vistos).toEqual([t.t6, t.t5, t.t4, t.t3, t.t2, t.t1]);
    expect((await listar('?pagina=4&por_pagina=2')).body).toEqual({ datos: [], meta: { pagina: 4, por_pagina: 2, total: 6 } });
    datosNoValidos(await listar('?por_pagina=101'), ['por_pagina']);
  });

  it('OPERADOR: sin id_bodega ve los de SU bodega (origen o destino) con el total de ESA bodega; con la suya también; con otra → 403', async () => {
    /* D31(g): restricción global 4. */
    const propia = await listar('', OPE(b2));
    expect(ids(propia)).toEqual([t.t5, t.t4, t.t2, t.t1]);
    expect(propia.body.meta.total).toBe(4);
    expect(ids(await listar(`?id_bodega=${b2}&estado=RECIBIDO`, OPE(b2)))).toEqual([t.t4, t.t2]);
    esError(await listar(`?id_bodega=${b1}`, OPE(b2)), 403, 'SIN_PERMISO');
  });

  it('OPERADOR sin X-User-Bodega → 403 (con y sin id_bodega)', async () => {
    /* Nunca ve traslados de ninguna bodega. */
    esError(await listar('', headers('OPERADOR_BODEGA')), 403, 'SIN_PERMISO');
    esError(await listar(`?id_bodega=${b1}`, headers('OPERADOR_BODEGA')), 403, 'SIN_PERMISO');
  });

  it('OPERADOR: id_bodega repetido o vacío → 422; ID_BODEGA o id_bodega[] (que Express no reconoce) NO amplían su alcance', async () => {
    /* Un parámetro que se ignora deja el filtro por omisión: su bodega. */
    datosNoValidos(await listar(`?id_bodega=${b2}&id_bodega=${b1}`, OPE(b2)), ['id_bodega']);
    datosNoValidos(await listar('?id_bodega=', OPE(b2)), ['id_bodega']);
    for (const consulta of [`?ID_BODEGA=${b1}`, `?id_bodega[]=${b1}`, `?id_bodega%5B%5D=${b1}`]) {
      const res = await listar(consulta, OPE(b2));
      expect({ consulta, estado: res.status, ids: ids(res) }).toEqual({ consulta, estado: 200, ids: [t.t5, t.t4, t.t2, t.t1] });
    }
  });

  it('una llamada interna SIN X-User-Id (D8) y el ADMINISTRADOR ven todos los traslados', async () => {
    /* Las lecturas son válidas sin usuario (ms-reportes). */
    const interna = await request.get('/traslados').set('X-Request-Id', 'req-interna');
    expect(interna.status).toBe(200);
    expect(interna.body.meta.total).toBe(6);
    expect((await listar('', headers('ADMINISTRADOR', { idBodega: b1 }))).body.meta.total).toBe(6);
  });

  it('refleja las escrituras de la API: un traslado creado aparece EN_TRANSITO primero y, tras recibirlo, RECIBIDO', async () => {
    /* De punta a punta con crear y recibir. */
    const { movimiento, ...creado } = await enTransito();
    expect(movimiento.tipo).toBe('TRASLADO_SALIDA');
    expect((await listar('?estado=EN_TRANSITO')).body.datos.find((f) => f.id_traslado === creado.id_traslado)).toEqual(creado);
    await recibir(creado.id_traslado);
    expect(ids(await listar('?estado=RECIBIDO'))[0]).toBe(creado.id_traslado);
  });
});
