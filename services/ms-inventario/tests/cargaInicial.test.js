const http = require('node:http');
const knex = require('knex');
const supertest = require('supertest');
const { createApp } = require('../src/app');
const { construirConfigKnex } = require('../src/config/db');
const { delta } = require('../src/domain/tipos');
const { e } = require('../src/errors');
const movimientoRepository = require('../src/repositories/movimientoRepository');
const stockService = require('../src/services/stockService');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { esperarBloqueo } = require('./helpers/bloqueos');
const { configDePrueba, truncateAll } = require('./helpers/db');
const { crearBodega, crearSaldo, crearUmbral, headers } = require('./helpers/fixtures');
const { esError, datosNoValidos } = require('./helpers/respuestas');

// Carga inicial de saldos (RF16, D34) de punta a punta, contra PostgreSQL real y con clientes falsos:
// POST /internas/saldos/carga-inicial, la ruta INTERNA que solo llama ms-reportes. Cada fila válida crea un movimiento
// CARGA_INICIAL con el motor; las inválidas vuelven en `rechazados` sin abortar la carga. Las capas por separado están en
// cargaInicialCapas.test.js y el límite del cuerpo (1 MB) en limiteCuerpo.test.js.
//
// ms-reportes espera 3 s por intento y reintenta hasta 4 veces con la MISMA Idempotency-Key, así que un reintento puede
// SOLAPARSE con la primera ejecución: las pruebas de idempotencia y de concurrencia lo reproducen con PostgreSQL real.
//
// Tras CADA prueba se comprueban los invariantes del stock: la suma de los lotes de un par nunca supera su saldo y ninguno es
// negativo, y el saldo de cada par es el `saldo_resultante` de su último movimiento (nada se aplicó a medias).

const RUTA = '/internas/saldos/carga-inicial';
// Las bodegas nacen con estos ids (truncateAll reinicia las secuencias): las tablas de casos las nombran antes de que corra beforeEach.
const B1 = 1;
const B2 = 2;
const B3 = 3; // inactiva
const USUARIO = 9; // distinto del 7 por omisión de crearMovimiento y de los demás archivos
const ADM = headers('ADMINISTRADOR', { idUsuario: USUARIO });
const CLAVES_MOVIMIENTO = [
  'id_movimiento', 'tipo', 'id_producto', 'id_bodega', 'id_lote', 'id_traslado', 'id_conteo', 'cantidad', 'saldo_resultante',
  'fecha', 'id_usuario', 'documento_referencia', 'observacion',
];
const MAXIMO = 2147483647;
const MEDIODIA = '2026-11-15T12:00:00Z';

let request;
let db;
let clients;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp({ now: () => new Date(MEDIODIA) }));
});
beforeEach(async () => {
  await truncateAll(db);
  const bodegas = [await crearBodega(db, { codigo: 'B1' }), await crearBodega(db, { codigo: 'B2' }), await crearBodega(db, { codigo: 'B3', activa: false })];
  expect(bodegas.map((bodega) => bodega.id_bodega)).toEqual([B1, B2, B3]);
  clients.catalogo.obtenerProducto.mockClear();
  clients.notificaciones.notificarStockBajo.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await comprobarInvariantes();
});
afterAll(() => db.destroy());

async function comprobarInvariantes() {
  const { rows: lotesRotos } = await db.raw(`
    SELECT l.id_producto, l.id_bodega
    FROM lotes l LEFT JOIN saldos s ON s.id_producto = l.id_producto AND s.id_bodega = l.id_bodega
    GROUP BY l.id_producto, l.id_bodega
    HAVING SUM(l.cantidad_disponible) > COALESCE(MAX(s.cantidad_disponible), 0) OR MIN(l.cantidad_disponible) < 0`);
  expect(lotesRotos).toEqual([]);
  // El saldo de cada par con movimientos es el saldo_resultante del ÚLTIMO (por fecha e id): ninguna fila se aplicó a medias.
  const { rows: desfasados } = await db.raw(`
    SELECT s.id_producto, s.id_bodega, s.cantidad_disponible, u.saldo_resultante
    FROM saldos s
    JOIN LATERAL (
      SELECT m.saldo_resultante FROM movimientos m WHERE m.id_producto = s.id_producto AND m.id_bodega = s.id_bodega
      ORDER BY m.fecha DESC, m.id_movimiento DESC LIMIT 1
    ) u ON true
    WHERE s.cantidad_disponible <> u.saldo_resultante`);
  expect(desfasados).toEqual([]);
}

let contadorClaves = 0;
const nuevaClave = () => `ki-${(contadorClaves += 1)}`;

// POST /internas/saldos/carga-inicial con las cabeceras dadas (por omisión, ADMINISTRADOR con el usuario 9 y una clave nueva).
const cargar = (filas, { clave = nuevaClave(), cabeceras = ADM, cliente = request } = {}) => cliente.post(RUTA).set(cabeceras).set('Idempotency-Key', clave).send({ filas });
const fila = (extra = {}) => ({ id_producto: 5, id_bodega: B1, cantidad: 10, ...extra });

// Foto de lo que un rechazo no debe cambiar.
const foto = async () => ({
  saldos: await db('saldos').select('*').orderBy('id_saldo'),
  lotes: await db('lotes').select('*').orderBy('id_lote'),
  movimientos: await db('movimientos').select('*').orderBy('id_movimiento'),
});
const movimientos = () => db('movimientos').select('*').orderBy('id_movimiento');
const claves = async () => (await db('movimientos').orderBy('id_movimiento').pluck('clave_idempotencia'));
const saldoDe = async (idProducto, idBodega = B1) => (await db('saldos').where({ id_producto: idProducto, id_bodega: idBodega }).first())?.cantidad_disponible;
const cuentaDe = async (tabla) => Number((await db(tabla).count({ n: '*' }))[0].n);

// Cada saldo_resultante es el anterior más su cambio, por (producto, bodega) y en el orden del kardex (fecha, id_movimiento, D24),
// partiendo de `inicial` ({ 'producto-bodega': cantidad }); y el saldo guardado es el último. Devuelve las discrepancias ([] = bien).
async function discrepanciasDeKardex(inicial = {}) {
  const saldos = { ...inicial };
  const malos = [];
  for (const m of await db('movimientos').orderBy([{ column: 'fecha' }, { column: 'id_movimiento' }])) {
    const par = `${m.id_producto}-${m.id_bodega}`;
    saldos[par] = (saldos[par] ?? 0) + delta(m.tipo, m.cantidad);
    if (m.saldo_resultante !== saldos[par]) malos.push({ id_movimiento: m.id_movimiento, par, esperado: saldos[par], saldo_resultante: m.saldo_resultante });
  }
  for (const s of await db('saldos')) {
    const par = `${s.id_producto}-${s.id_bodega}`;
    if (s.cantidad_disponible !== (saldos[par] ?? 0)) malos.push({ par, esperado: saldos[par] ?? 0, saldo: s.cantidad_disponible });
  }
  return malos;
}

const sinCincoXX = (respuestas) => expect(respuestas.filter((res) => res.status >= 500).map((res) => res.body)).toEqual([]);

// ---------------------------------------------------------------------------------------------------------------------------
// Filas válidas
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: filas válidas (200)', () => {
  it('dos filas válidas → 200 { creados: 2, rechazados: [] }, dos CARGA_INICIAL con saldo_resultante, el usuario de la cabecera y el saldo igual a la cantidad', async () => {
    /* RF16, D34(f): la clave de cada fila es <usuario>:ini:<clave>#<n>, con n desde 1. */
    const res = await cargar([{ id_producto: 5, id_bodega: B1, cantidad: 10 }, { id_producto: 6, id_bodega: B2, cantidad: 3 }], { clave: 'k-dos' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['creados', 'rechazados']);
    expect(res.body).toEqual({ creados: 2, rechazados: [] });
    const guardados = await movimientos();
    for (const movimiento of guardados) expect(Object.keys(movimiento).sort()).toEqual([...CLAVES_MOVIMIENTO, 'clave_idempotencia'].sort());
    expect(guardados).toEqual([
      expect.objectContaining({ tipo: 'CARGA_INICIAL', id_producto: 5, id_bodega: B1, cantidad: 10, saldo_resultante: 10, id_usuario: USUARIO, id_lote: null, id_traslado: null, id_conteo: null, clave_idempotencia: `${USUARIO}:ini:k-dos#1` }),
      expect.objectContaining({ tipo: 'CARGA_INICIAL', id_producto: 6, id_bodega: B2, cantidad: 3, saldo_resultante: 3, id_usuario: USUARIO, id_lote: null, clave_idempotencia: `${USUARIO}:ini:k-dos#2` }),
    ]);
    expect([await saldoDe(5, B1), await saldoDe(6, B2)]).toEqual([10, 3]);
    expect(await cuentaDe('lotes')).toBe(0);
  });

  it('la clave de cada fila lleva SU posición base 1, también cuando hay filas rechazadas antes: las filas 1 y 3 → #1 y #3', async () => {
    /* D25d: derivada(base, n); un `n` base 0 o un contador de las aplicadas daría otras claves. */
    const res = await cargar([fila({ id_producto: 1 }), fila({ id_producto: 2, cantidad: 0 }), fila({ id_producto: 3 })], { clave: 'k-pos' });
    expect(res.body).toEqual({ creados: 2, rechazados: [{ fila: 2, motivo: expect.any(String) }] });
    expect(await claves()).toEqual([`${USUARIO}:ini:k-pos#1`, `${USUARIO}:ini:k-pos#3`]);
  });

  it('los campos que fija el servidor y los de más se ignoran (tipo, id_usuario, saldo_resultante, fecha, id_lote): el autor es el de la cabecera', async () => {
    const extra = { tipo: 'SALIDA', id_usuario: 1, saldo_resultante: 99, fecha: '2020-01-01T00:00:00Z', id_lote: 7, documento_referencia: 'X', observacion: 'Y', cualquiera: 1 };
    const res = await cargar([fila(extra)]);
    expect(res.body).toEqual({ creados: 1, rechazados: [] });
    expect(await movimientos()).toEqual([
      expect.objectContaining({ tipo: 'CARGA_INICIAL', id_usuario: USUARIO, saldo_resultante: 10, id_lote: null, documento_referencia: null, observacion: null }),
    ]);
    expect((await movimientos())[0].fecha.getFullYear()).toBeGreaterThan(2025);
  });

  it('varias filas del mismo producto y bodega suman y encadenan el saldo_resultante en el orden de la lista', async () => {
    const res = await cargar([fila({ cantidad: 10 }), fila({ cantidad: 5 }), fila({ id_producto: 6, cantidad: 1 }), fila({ cantidad: 7 })]);
    expect(res.body).toEqual({ creados: 4, rechazados: [] });
    expect((await movimientos()).map((m) => [m.id_producto, m.cantidad, m.saldo_resultante])).toEqual([[5, 10, 10], [5, 5, 15], [6, 1, 1], [5, 7, 22]]);
    expect(await saldoDe(5)).toBe(22);
  });

  it('suma a un saldo que ya existía y deja el kardex encadenado desde él', async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: B1, cantidad: 4 });
    expect((await cargar([fila({ cantidad: 6 })])).body).toEqual({ creados: 1, rechazados: [] });
    expect((await movimientos())[0]).toEqual(expect.objectContaining({ cantidad: 6, saldo_resultante: 10 }));
    expect(await saldoDe(5)).toBe(10);
  });

  it('no consulta el catálogo: un producto que el catálogo no conoce (el 999) se carga igual (D34(d))', async () => {
    const res = await cargar([fila({ id_producto: 999 })]);
    expect(res.body).toEqual({ creados: 1, rechazados: [] });
    expect(clients.catalogo.obtenerProducto).not.toHaveBeenCalled();
    expect(await saldoDe(999)).toBe(10);
  });

  it('no evalúa el umbral (D13, D34(d)): con un mínimo muy superior a lo cargado no avisa a ms-notificaciones; una ENTRADA normal del mismo producto sí', async () => {
    /* Control positivo del aviso: sin él, «no avisó» sería una prueba que nunca pudo fallar. */
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 100000 });
    expect((await cargar([fila()])).body).toEqual({ creados: 1, rechazados: [] });
    expect(clients.notificaciones.notificarStockBajo).not.toHaveBeenCalled();
    const entrada = await request.post('/movimientos').set(ADM).set('Idempotency-Key', 'k-control-umbral').send({ tipo: 'ENTRADA', id_producto: 5, id_bodega: B1, cantidad: 1 });
    expect(entrada.status).toBe(201);
    expect(clients.notificaciones.notificarStockBajo).toHaveBeenCalledTimes(1);
  });

  it('cualquier rol con X-User-Id y X-User-Rol vale: la ruta no aplica alcance por bodega (llamada interna; el Gateway ya limita quién importa)', async () => {
    const operador = headers('OPERADOR_BODEGA', { idUsuario: 11, idBodega: B2 });
    expect((await cargar([fila({ id_bodega: B1 })], { cabeceras: operador })).body).toEqual({ creados: 1, rechazados: [] });
    expect((await movimientos())[0]).toEqual(expect.objectContaining({ id_bodega: B1, id_usuario: 11 }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: lotes (D27, D28(b))', () => {
  it('una fila con codigo_lote y fecha_vencimiento crea su lote y el movimiento lleva su id_lote', async () => {
    const res = await cargar([fila({ cantidad: 8, codigo_lote: 'L-2027', fecha_vencimiento: '2027-06-30' })]);
    expect(res.body).toEqual({ creados: 1, rechazados: [] });
    const lotes = await db('lotes');
    expect(lotes).toEqual([expect.objectContaining({ id_producto: 5, id_bodega: B1, codigo_lote: 'L-2027', fecha_vencimiento: '2027-06-30', cantidad_disponible: 8 })]);
    expect(await movimientos()).toEqual([expect.objectContaining({ tipo: 'CARGA_INICIAL', cantidad: 8, saldo_resultante: 8, id_lote: lotes[0].id_lote })]);
    expect(await saldoDe(5)).toBe(8);
  });

  it('con codigo_lote SIN fecha crea el lote sin fecha (D28(b): el motor admite la fecha nula y solo la carga inicial la deja opcional); null equivale a ausente', async () => {
    const res = await cargar([fila({ codigo_lote: 'SIN-FECHA' }), fila({ id_producto: 6, codigo_lote: 'NULA', fecha_vencimiento: null })]);
    expect(res.body).toEqual({ creados: 2, rechazados: [] });
    expect((await db('lotes').orderBy('id_lote')).map((l) => [l.codigo_lote, l.fecha_vencimiento, l.cantidad_disponible])).toEqual([['SIN-FECHA', null, 10], ['NULA', null, 10]]);
  });

  it('codigo_lote null o ausente es stock sin lote; el código se recorta ("  L1  " es "L1") y distingue mayúsculas ("l1" es otro lote, D28(c))', async () => {
    const res = await cargar([
      fila({ id_producto: 1, codigo_lote: null }),
      fila({ id_producto: 2 }),
      fila({ id_producto: 3, codigo_lote: '  L1  ', fecha_vencimiento: '2027-01-31' }),
      fila({ id_producto: 3, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad: 2 }),
      fila({ id_producto: 3, codigo_lote: 'l1', fecha_vencimiento: '2027-01-31', cantidad: 4 }),
    ]);
    expect(res.body).toEqual({ creados: 5, rechazados: [] });
    expect((await movimientos()).map((m) => m.id_lote !== null)).toEqual([false, false, true, true, true]);
    expect((await db('lotes').orderBy('id_lote')).map((l) => [l.codigo_lote, l.cantidad_disponible])).toEqual([['L1', 12], ['l1', 4]]);
    expect(await saldoDe(3)).toBe(16);
  });

  it('otra fila con el MISMO código y la MISMA fecha suma al lote; con OTRA fecha → rechazada (409 del motor) con la fecha guardada en el motivo y el resto sigue', async () => {
    /* D27(d). El rechazo no escribe nada: ni movimiento, ni lote, ni saldo. */
    const res = await cargar([
      fila({ cantidad: 5, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' }),
      fila({ cantidad: 3, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' }),
      fila({ cantidad: 2, codigo_lote: 'L1', fecha_vencimiento: '2027-02-28' }),
      fila({ id_producto: 6, cantidad: 4 }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 3, rechazados: [{ fila: 3, motivo: 'El lote ya existe con fecha de vencimiento 2027-01-31' }] });
    expect((await db('lotes')).map((l) => [l.codigo_lote, l.fecha_vencimiento, l.cantidad_disponible])).toEqual([['L1', '2027-01-31', 8]]);
    expect([await saldoDe(5), await saldoDe(6)]).toEqual([8, 4]);
    expect((await movimientos()).map((m) => m.cantidad)).toEqual([5, 3, 4]);
  });

  it('un lote creado SIN fecha rechaza una fila con fecha ("ya existe sin fecha"); uno con fecha admite una fila sin fecha (suma sin tocar la fecha)', async () => {
    const res = await cargar([
      fila({ id_producto: 1, codigo_lote: 'A' }),
      fila({ id_producto: 1, codigo_lote: 'A', fecha_vencimiento: '2027-05-05' }),
      fila({ id_producto: 2, codigo_lote: 'B', fecha_vencimiento: '2027-05-05' }),
      fila({ id_producto: 2, codigo_lote: 'B', cantidad: 3 }),
    ]);
    expect(res.body).toEqual({ creados: 3, rechazados: [{ fila: 2, motivo: 'El lote ya existe sin fecha de vencimiento' }] });
    expect((await db('lotes').orderBy('id_lote')).map((l) => [l.codigo_lote, l.fecha_vencimiento, l.cantidad_disponible])).toEqual([['A', null, 10], ['B', '2027-05-05', 13]]);
  });

  it('la misma pareja de lote en OTRA bodega o para OTRO producto es otro lote (la unicidad es por bodega, producto y código)', async () => {
    const res = await cargar([
      fila({ codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' }),
      fila({ id_bodega: B2, codigo_lote: 'L1', fecha_vencimiento: '2027-03-31' }),
      fila({ id_producto: 6, codigo_lote: 'L1', fecha_vencimiento: '2027-04-30' }),
    ]);
    expect(res.body).toEqual({ creados: 3, rechazados: [] });
    expect(await cuentaDe('lotes')).toBe(3);
  });

  it('los lotes cargados son los que consume después una salida por FEFO: el primero en vencer sale primero', async () => {
    /* La carga inicial entra al mismo modelo de lotes que las demás entradas (RF17). */
    await cargar([fila({ cantidad: 5, codigo_lote: 'TARDE', fecha_vencimiento: '2027-12-31' }), fila({ cantidad: 5, codigo_lote: 'PRONTO', fecha_vencimiento: '2027-01-31' })]);
    const salida = await request.post('/movimientos').set(ADM).set('Idempotency-Key', 'k-fefo').send({ tipo: 'SALIDA', id_producto: 5, id_bodega: B1, cantidad: 6 });
    expect(salida.status).toBe(201);
    expect((await db('lotes').orderBy('codigo_lote')).map((l) => [l.codigo_lote, l.cantidad_disponible])).toEqual([['PRONTO', 0], ['TARDE', 4]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Filas inválidas → rechazados
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: filas inválidas → rechazados (D34(b))', () => {
  const ENTERO = 'debe ser un número entero entre 1 y 2147483647';
  const largo51 = 'x'.repeat(51);
  const CASOS = [
    // El motor: nada que escribir en la base de la fila rechazada.
    ['bodega inexistente (404 del motor)', fila({ id_bodega: 999 }), /^La bodega no existe$/],
    ['bodega inactiva (409 BODEGA_INACTIVA del motor)', fila({ id_bodega: B3 }), /^La bodega está inactiva: no admite movimientos$/],
    // cantidad
    ['cantidad 0', fila({ cantidad: 0 }), new RegExp(`^cantidad: ${ENTERO}$`)],
    ['cantidad negativa', fila({ cantidad: -1 }), new RegExp(`^cantidad: ${ENTERO}$`)],
    ['cantidad decimal (1.5)', fila({ cantidad: 1.5 }), new RegExp(`^cantidad: ${ENTERO}$`)],
    ['cantidad como texto ("5")', fila({ cantidad: '5' }), new RegExp(`^cantidad: ${ENTERO}$`)],
    ['cantidad null', fila({ cantidad: null }), new RegExp(`^cantidad: ${ENTERO}$`)],
    ['cantidad ausente', { id_producto: 5, id_bodega: B1 }, /^cantidad: es obligatorio$/],
    ['cantidad por encima del INTEGER (2147483648)', fila({ cantidad: 2147483648 }), new RegExp(`^cantidad: ${ENTERO}$`)],
    // identificadores
    ['id_producto 0', fila({ id_producto: 0 }), new RegExp(`^id_producto: ${ENTERO}$`)],
    ['id_producto como texto ("3")', fila({ id_producto: '3' }), new RegExp(`^id_producto: ${ENTERO}$`)],
    ['id_producto ausente', { id_bodega: B1, cantidad: 1 }, /^id_producto: es obligatorio$/],
    ['id_bodega null', fila({ id_bodega: null }), new RegExp(`^id_bodega: ${ENTERO}$`)],
    ['id_bodega negativo', fila({ id_bodega: -2 }), new RegExp(`^id_bodega: ${ENTERO}$`)],
    // la fila misma
    ['fila null', null, /^La fila debe ser un objeto/],
    ['fila arreglo', [5, B1, 10], /^La fila debe ser un objeto/],
    ['fila número', 7, /^La fila debe ser un objeto/],
    ['fila texto', 'x', /^La fila debe ser un objeto/],
    // codigo_lote
    ['codigo_lote vacío', fila({ codigo_lote: '' }), /^codigo_lote: no puede estar vacío$/],
    ['codigo_lote solo espacios', fila({ codigo_lote: '   ' }), /^codigo_lote: no puede estar vacío$/],
    ['codigo_lote de 51 caracteres (el largo exacto de la columna + 1)', fila({ codigo_lote: largo51 }), /^codigo_lote: debe tener como máximo 50 caracteres$/],
    ['codigo_lote número', fila({ codigo_lote: 5 }), /^codigo_lote: debe ser un texto$/],
    ['codigo_lote con carácter nulo', fila({ codigo_lote: 'L\u00001' }), /^codigo_lote: no puede contener caracteres nulos$/],
    ['codigo_lote con un carácter suelto de un par sustituto', fila({ codigo_lote: 'L\ud800' }), /^codigo_lote: no es un texto Unicode válido/],
    // fecha_vencimiento
    ['fecha_vencimiento que no existe (2027-02-30)', fila({ codigo_lote: 'L1', fecha_vencimiento: '2027-02-30' }), /^fecha_vencimiento: debe ser una fecha válida con el formato AAAA-MM-DD$/],
    ['fecha_vencimiento con otro formato (2027-1-5)', fila({ codigo_lote: 'L1', fecha_vencimiento: '2027-1-5' }), /^fecha_vencimiento: debe ser una fecha válida/],
    ['fecha_vencimiento número', fila({ codigo_lote: 'L1', fecha_vencimiento: 20270130 }), /^fecha_vencimiento: debe ser una fecha válida/],
    ['fecha_vencimiento vacía', fila({ codigo_lote: 'L1', fecha_vencimiento: '' }), /^fecha_vencimiento: debe ser una fecha válida/],
    ['fecha_vencimiento SIN codigo_lote (la fecha es del lote)', fila({ fecha_vencimiento: '2027-01-31' }), /^fecha_vencimiento: solo se admite junto con codigo_lote/],
    ['fecha_vencimiento con codigo_lote null', fila({ codigo_lote: null, fecha_vencimiento: '2027-01-31' }), /^fecha_vencimiento: solo se admite junto con codigo_lote/],
  ];

  it.each(CASOS)('%s → rechazada con su motivo, sin escribir nada; las filas válidas de la misma carga igual se procesan', async (_descripcion, filaMala, motivo) => {
    /* Control positivo: las filas 1 y 3 son válidas y se aplican. */
    const res = await cargar([fila({ id_producto: 1 }), filaMala, fila({ id_producto: 3 })]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 2, rechazados: [{ fila: 2, motivo: expect.stringMatching(motivo) }] });
    expect((await movimientos()).map((m) => m.id_producto)).toEqual([1, 3]);
    expect((await db('saldos').orderBy('id_producto')).map((s) => s.id_producto)).toEqual([1, 3]);
    expect(await cuentaDe('lotes')).toBe(0);
    expect(res.text).not.toMatch(/violates|constraint|PostgreSQL|duplicate key|\.js:/i); // nunca un mensaje de la base ni una traza
  });

  it('el límite exacto de cada campo es válido: cantidad 2147483647, id_producto e id_bodega 1, codigo_lote de 50 caracteres', async () => {
    /* Controles positivos de los casos de arriba (el techo del INTEGER y el largo exacto de la columna). */
    const res = await cargar([fila({ id_producto: 1, cantidad: MAXIMO }), fila({ id_producto: 2, codigo_lote: 'x'.repeat(50), fecha_vencimiento: '2027-02-28' })]);
    expect(res.body).toEqual({ creados: 2, rechazados: [] });
    expect(await saldoDe(1)).toBe(MAXIMO);
    expect((await db('lotes'))[0].codigo_lote).toHaveLength(50);
  });

  it('informa TODOS los campos inválidos de la fila en un solo motivo, en el orden del contrato', async () => {
    const res = await cargar([{ id_producto: 0, id_bodega: 'x', cantidad: 1.5, codigo_lote: '', fecha_vencimiento: 'mañana' }]);
    expect(res.body).toEqual({ creados: 0, rechazados: [{ fila: 1, motivo: expect.any(String) }] });
    const campos = [...res.body.rechazados[0].motivo.matchAll(/(\w+): /g)].map((m) => m[1]);
    expect(campos).toEqual(['id_producto', 'id_bodega', 'cantidad', 'codigo_lote', 'fecha_vencimiento']);
  });

  it('un desborde del saldo (el motor lo rechaza con 422) rechaza SOLO esa fila: el saldo queda en el máximo y las demás siguen', async () => {
    /* D2, D26: nunca un 500 por el 22003 de PostgreSQL. */
    const res = await cargar([fila({ cantidad: MAXIMO }), fila({ cantidad: 1 }), fila({ id_producto: 6, cantidad: 2 })]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 2, rechazados: [{ fila: 2, motivo: `cantidad: el saldo resultante superaría el máximo permitido (${MAXIMO})` }] });
    expect(await saldoDe(5)).toBe(MAXIMO);
    expect((await movimientos()).map((m) => m.cantidad)).toEqual([MAXIMO, 2]);
  });

  it('con varias filas inválidas mezcladas: `fila` es la posición base 1 de la lista, `rechazados` va ordenado por `fila` y creados cuenta solo las aplicadas', async () => {
    const res = await cargar([
      fila({ id_producto: 1 }), // 1 ok
      fila({ id_bodega: 999 }), // 2 motor
      null, // 3 validación
      fila({ id_producto: 2 }), // 4 ok
      fila({ id_producto: 3, cantidad: 0 }), // 5 validación
      fila({ id_producto: 4, id_bodega: B3 }), // 6 motor
      fila({ id_producto: 5 }), // 7 ok
    ]);
    expect(res.body.creados).toBe(3);
    expect(res.body.rechazados.map((r) => r.fila)).toEqual([2, 3, 5, 6]);
    expect(res.body.rechazados.map((r) => Object.keys(r).sort())).toEqual(Array(4).fill(['fila', 'motivo']));
    expect((await movimientos()).map((m) => m.id_producto)).toEqual([1, 2, 5]);
  });

  it('una carga con TODAS las filas inválidas → 200 { creados: 0, rechazados: [...] } y la base no cambia', async () => {
    /* D34(f): bien formada ≠ aplicada; ms-reportes lee `rechazados` para decir qué falló. */
    const antes = await foto();
    const res = await cargar([null, fila({ cantidad: 0 }), fila({ id_bodega: 999 }), fila({ id_bodega: B3 })]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 0, rechazados: [1, 2, 3, 4].map((n) => ({ fila: n, motivo: expect.any(String) })) });
    expect(await foto()).toEqual(antes);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// La petición misma
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: petición mal formada (nada se escribe)', () => {
  // Cuenta las sentencias que llegan a la base durante `accion`: «no se tocó la base» es CERO consultas, no solo «nada cambió».
  async function consultasDe(accion) {
    const sql = [];
    const registrar = (consulta) => sql.push(consulta.sql);
    db.on('query', registrar);
    try {
      await accion();
    } finally {
      db.removeListener('query', registrar);
    }
    return sql;
  }
  const conCuerpo = (cuerpo, { clave = 'k-cuerpo' } = {}) => request.post(RUTA).set(ADM).set('Idempotency-Key', clave).set('Content-Type', 'application/json').send(cuerpo);

  it.each([
    ['filas ausente', {}],
    ['filas vacía', { filas: [] }],
    ['filas null', { filas: null }],
    ['filas un objeto', { filas: { id_producto: 5 } }],
    ['filas un texto', { filas: 'x' }],
    ['filas un número', { filas: 5 }],
  ])('%s → 422 sobre "filas" y la base no se toca', async (_descripcion, cuerpo) => {
    /* Control positivo: la misma ruta con una fila válida responde 200. */
    expect((await cargar([fila()], { clave: 'k-control' })).status).toBe(200);
    const antes = await foto();
    const sql = await consultasDe(async () => datosNoValidos(await conCuerpo(JSON.stringify(cuerpo)), ['filas']));
    expect(sql).toEqual([]);
    expect(await foto()).toEqual(antes);
  });

  it('un cuerpo que es un arreglo o que falta → 422 sobre "filas"; uno que no es ni objeto ni arreglo (un texto, null, un número) lo rechaza ya el analizador de JSON con 400', async () => {
    for (const cuerpo of ['[]', '[{"id_producto":5}]']) datosNoValidos(await conCuerpo(cuerpo), ['filas']);
    datosNoValidos(await request.post(RUTA).set(ADM).set('Idempotency-Key', 'k-sin-cuerpo'), ['filas']);
    for (const cuerpo of ['"x"', 'null', '7']) esError(await conCuerpo(cuerpo), 400, 'PETICION_MAL_FORMADA');
    expect(await foto()).toEqual({ saldos: [], lotes: [], movimientos: [] });
  });

  it('el mensaje del 422 de filas dice qué se espera y el de más de 1 000 dice que se envíe por partes', async () => {
    expect((await conCuerpo(JSON.stringify({ filas: [] }))).body.error.detalles[0].mensaje).toMatch(/lista no vacía de \{ id_producto, id_bodega, cantidad/);
    expect((await conCuerpo(JSON.stringify({ filas: Array(1001).fill(null) }))).body.error.detalles[0].mensaje).toMatch(/máximo 1000 filas.*por partes/);
  });

  it('más de 1 000 filas (1 001) → 422 sobre "filas" SIN tocar la base (ni una consulta); con 1 000 (aquí todas inválidas, sin coste) → 200: el tope es `>` y no `>=`', async () => {
    /* D34(c): se mira la longitud ANTES de mirar cada elemento (aquí son nulos: si se miraran, no sería un 422 de `filas`). */
    const mil = await cargar(Array(1000).fill(null), { clave: 'k-mil' });
    expect(mil.status).toBe(200);
    expect(mil.body.creados).toBe(0);
    expect(mil.body.rechazados).toHaveLength(1000);
    expect(mil.body.rechazados[999]).toEqual({ fila: 1000, motivo: expect.any(String) });
    const sql = await consultasDe(async () => datosNoValidos(await cargar(Array(1001).fill(null), { clave: 'k-mil-uno' }), ['filas']));
    expect(sql).toEqual([]);
    expect(await foto()).toEqual({ saldos: [], lotes: [], movimientos: [] });
  });

  it('sin X-User-Id → 401 NO_AUTENTICADO y no se toca la base (aunque falten la clave y las filas); con X-User-Id y sin X-User-Rol, o con un rol inválido, también 401', async () => {
    /* D8, D22, Ruling 10. Control positivo: con ambas cabeceras, 200. */
    expect((await cargar([fila()], { clave: 'k-control' })).status).toBe(200);
    const antes = await foto();
    const sql = await consultasDe(async () => {
      esError(await request.post(RUTA).set({ 'X-User-Rol': 'ADMINISTRADOR' }).set('Idempotency-Key', 'k-401').send({ filas: [fila()] }), 401, 'NO_AUTENTICADO');
      esError(await request.post(RUTA).send({ filas: [] }), 401, 'NO_AUTENTICADO');
      esError(await request.post(RUTA).set({ 'X-User-Id': '7' }).set('Idempotency-Key', 'k-401').send({ filas: [fila()] }), 401, 'NO_AUTENTICADO');
      esError(await request.post(RUTA).set({ 'X-User-Id': '7', 'X-User-Rol': 'ROOT' }).set('Idempotency-Key', 'k-401').send({ filas: [fila()] }), 401, 'NO_AUTENTICADO');
    });
    expect(sql).toEqual([]);
    expect(await foto()).toEqual(antes);
  });

  it.each([
    ['sin Idempotency-Key', undefined],
    ['una Idempotency-Key vacía', ''],
    ['una Idempotency-Key de solo espacios', '   '],
    ['una Idempotency-Key con "#"', 'a#1'],
    ['una Idempotency-Key de 201 caracteres', 'k'.repeat(201)],
  ])('%s → 400 PETICION_MAL_FORMADA, antes de mirar las filas, y la base no se toca', async (_descripcion, clave) => {
    /* D25, D25c. Control positivo: una clave de 200 caracteres es válida. */
    expect((await cargar([fila()], { clave: 'k'.repeat(200) })).status).toBe(200);
    const antes = await foto();
    const peticion = request.post(RUTA).set(ADM);
    if (clave !== undefined) peticion.set('Idempotency-Key', clave);
    const sql = await consultasDe(async () => esError(await peticion.send({ filas: [] }), 400, 'PETICION_MAL_FORMADA')); // filas vacías: la clave se decide PRIMERO
    expect(sql).toEqual([]);
    expect(await foto()).toEqual(antes);
  });

  it('JSON mal formado → 400 PETICION_MAL_FORMADA sin tocar la base', async () => {
    const antes = await foto();
    esError(await conCuerpo('{"filas": [{"id_producto": 5,'), 400, 'PETICION_MAL_FORMADA');
    expect(await foto()).toEqual(antes);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// 1 000 filas y un cuerpo de ~500 kB
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: 1 000 filas (D34(c))', () => {
  it('1 000 filas válidas en un cuerpo de ~500 kB → 200 creados 1000, un movimiento por fila y el kardex encadenado; la repetición no toca nada', async () => {
    /* El cuerpo supera los 100 kB globales: lo admite el analizador propio de 1 MB. Cada fila lleva un campo de más para ocupar ~500 bytes. */
    const filas = Array.from({ length: 1000 }, (_, i) => ({ id_producto: 1 + (i % 100), id_bodega: i % 2 === 0 ? B1 : B2, cantidad: 1 + (i % 9), nota: 'x'.repeat(440) }));
    const cuerpo = JSON.stringify({ filas });
    expect(cuerpo.length).toBeGreaterThan(450 * 1000);
    expect(cuerpo.length).toBeLessThan(1024 * 1024);
    const res = await cargar(filas, { clave: 'k-mil-filas' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 1000, rechazados: [] });
    expect(await cuentaDe('movimientos')).toBe(1000);
    expect(await discrepanciasDeKardex()).toEqual([]);
    expect((await db('movimientos').pluck('cantidad')).reduce((a, b) => a + b, 0)).toBe(filas.reduce((a, f) => a + f.cantidad, 0));

    const aplicar = jest.spyOn(stockService, 'aplicarMovimiento');
    const otra = await cargar(filas, { clave: 'k-mil-filas' });
    expect(otra.status).toBe(200);
    expect(otra.body).toEqual({ creados: 1000, rechazados: [] });
    expect(aplicar).not.toHaveBeenCalled(); // las 1 000 ya estaban aplicadas: ni una transacción
    expect(await cuentaDe('movimientos')).toBe(1000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Idempotencia (RNF17, D25, D25b, D25d, D34(a))
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: Idempotency-Key (RNF17, D34(a))', () => {
  const mezcla = () => [
    fila({ id_producto: 1, cantidad: 4 }),
    fila({ id_producto: 2, id_bodega: B3 }), // inactiva: rechazada
    fila({ id_producto: 3, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad: 6 }),
    null, // inválida
    fila({ id_producto: 4, cantidad: 8 }),
  ];

  it('la misma clave repetida → 200 con los MISMOS creados y rechazados, sin movimientos nuevos ni cambios en saldos o lotes; las filas rechazadas siguen rechazadas y no se crean', async () => {
    const primera = await cargar(mezcla(), { clave: 'k-rep' });
    expect(primera.body).toEqual({ creados: 3, rechazados: [{ fila: 2, motivo: expect.any(String) }, { fila: 4, motivo: expect.any(String) }] });
    const antes = await foto();
    const aplicar = jest.spyOn(stockService, 'aplicarMovimiento');
    const segunda = await cargar(mezcla(), { clave: 'k-rep' });
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual(primera.body);
    expect(await foto()).toEqual(antes);
    // Solo las filas rechazadas se vuelven a intentar (y a rechazar); las tres aplicadas no tocan el motor.
    expect(aplicar.mock.calls.map(([, datos]) => datos.idProducto)).toEqual([2]);
    expect(await cuentaDe('movimientos')).toBe(3);
  });

  it('una repetición tras corregir el estado (reactivar la bodega) aplica SOLO la fila que se había rechazado y devuelve los creados totales', async () => {
    /* La fila 2 de `mezcla` apunta a la bodega inactiva B3: al reactivarla, la misma clave la aplica y no repite las demás. */
    const primera = await cargar(mezcla(), { clave: 'k-corrige' });
    expect(primera.body.creados).toBe(3);
    await db('bodegas').where({ id_bodega: B3 }).update({ activa: true });
    const aplicar = jest.spyOn(stockService, 'aplicarMovimiento');
    const segunda = await cargar(mezcla(), { clave: 'k-corrige' });
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual({ creados: 4, rechazados: [{ fila: 4, motivo: expect.any(String) }] }); // la 4 sigue inválida
    expect(aplicar.mock.calls.map(([, datos]) => datos.idProducto)).toEqual([2]);
    expect((await movimientos()).map((m) => m.clave_idempotencia)).toEqual([`${USUARIO}:ini:k-corrige#1`, `${USUARIO}:ini:k-corrige#3`, `${USUARIO}:ini:k-corrige#5`, `${USUARIO}:ini:k-corrige#2`]);
    expect(await saldoDe(2, B3)).toBe(10);
    expect([await saldoDe(1), await saldoDe(3), await saldoDe(4)]).toEqual([4, 6, 8]); // ninguna sumó dos veces
  });

  it('D7: la misma clave con OTRO cuerpo no vuelve a leer las filas ya aplicadas (aunque ahora sean otras o inválidas) y aplica las nuevas del final', async () => {
    /* La clave identifica cada fila por su posición: la fila n ya aplicada cuenta como creada con lo que se guardó la primera vez. */
    await cargar([fila({ id_producto: 1, cantidad: 4 }), fila({ id_producto: 2, cantidad: 5 })], { clave: 'k-otro-cuerpo' });
    const res = await cargar([fila({ id_producto: 7, cantidad: 100 }), null, fila({ id_producto: 3, cantidad: 6 })], { clave: 'k-otro-cuerpo' });
    expect(res.body).toEqual({ creados: 3, rechazados: [] });
    expect((await movimientos()).map((m) => [m.id_producto, m.cantidad])).toEqual([[1, 4], [2, 5], [3, 6]]);
    expect(await saldoDe(7)).toBeUndefined();
  });

  it('D25: OTRO usuario con la MISMA clave hace su propia carga (no recibe la del primero ni la omite)', async () => {
    const otro = headers('ADMINISTRADOR', { idUsuario: 12 });
    expect((await cargar([fila({ cantidad: 4 })], { clave: 'k-compartida' })).body).toEqual({ creados: 1, rechazados: [] });
    const res = await cargar([fila({ cantidad: 6 })], { clave: 'k-compartida', cabeceras: otro });
    expect(res.body).toEqual({ creados: 1, rechazados: [] });
    expect((await movimientos()).map((m) => [m.id_usuario, m.cantidad, m.saldo_resultante, m.clave_idempotencia])).toEqual([
      [USUARIO, 4, 4, `${USUARIO}:ini:k-compartida#1`], [12, 6, 10, '12:ini:k-compartida#1'],
    ]);
  });

  it('D25b: la misma Idempotency-Key en un movimiento, un traslado, la aprobación de un conteo y la carga inicial del mismo usuario no choca: cada operación guarda su propia clave y ninguna se omite', async () => {
    /* La colisión real es con la aprobación de un conteo (`<u>:con:K#<id_producto>`): con la misma operación, la fila 2 de la carga
       (#2) coincidiría con el AJUSTE del producto 2 y se daría por aplicada sin escribir nada. */
    const K = 'k-todas';
    await crearSaldo(db, { idProducto: 2, idBodega: B1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 4, idBodega: B1, cantidad: 10 });
    const movimiento = await request.post('/movimientos').set(ADM).set('Idempotency-Key', K).send({ tipo: 'ENTRADA', id_producto: 4, id_bodega: B1, cantidad: 1 });
    expect(movimiento.status).toBe(201);
    const traslado = await request.post('/traslados').set(ADM).set('Idempotency-Key', K).send({ id_producto: 4, id_bodega_origen: B1, id_bodega_destino: B2, cantidad: 2 });
    expect(traslado.status).toBe(201);
    const conteo = await request.post('/conteos').set(ADM).send({ id_bodega: B1, fecha_programada: '2026-11-20', ids_producto: [2] });
    expect(conteo.status).toBe(201);
    expect((await request.put(`/conteos/${conteo.body.id_conteo}/detalles`).set(ADM).send({ detalles: [{ id_producto: 2, cantidad_contada: 12 }] })).status).toBe(200);
    const aprobacion = await request.post(`/conteos/${conteo.body.id_conteo}/aprobacion`).set(ADM).set('Idempotency-Key', K);
    expect(aprobacion.status).toBe(200);

    const res = await cargar([fila({ id_producto: 1, cantidad: 3 }), fila({ id_producto: 2, cantidad: 5 }), fila({ id_producto: 3, cantidad: 7 })], { clave: K });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 3, rechazados: [] });
    expect((await claves()).sort()).toEqual([
      `${USUARIO}:mov:${K}`, `${USUARIO}:tras:${K}#salida`, `${USUARIO}:con:${K}#2`,
      `${USUARIO}:ini:${K}#1`, `${USUARIO}:ini:${K}#2`, `${USUARIO}:ini:${K}#3`,
    ].sort());
    // El producto 2 recibió SU fila de la carga encima del ajuste del conteo (10 → 12 → 17).
    expect(await saldoDe(2)).toBe(17);
    expect(await saldoDe(1)).toBe(3);
    expect(await saldoDe(3)).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Fallos a mitad y reintentos solapados
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: fallos a mitad de la carga', () => {
  const cinco = () => [1, 2, 3, 4, 5].map((id) => fila({ id_producto: 10 + id, cantidad: id }));

  it('un fallo que no es de negocio en la fila 3 → 500 ERROR_INTERNO genérico (sin traza ni mensaje); las filas 1 y 2 YA están aplicadas y la repetición con la misma clave las cuenta como creadas y completa el resto', async () => {
    /* D18, D34(a): una transacción por fila. Con UNA transacción para todas, las filas 1 y 2 también se habrían deshecho. */
    const original = stockService.aplicarMovimiento;
    const fallo = jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto === 13) throw new Error('fallo interno simulado: la base se cayó');
      return original(trx, datos);
    });
    const res = await cargar(cinco(), { clave: 'k-mitad' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { codigo: 'ERROR_INTERNO', mensaje: expect.any(String), detalles: [] } });
    expect(JSON.stringify(res.body)).not.toMatch(/simulado|base se cay/);
    expect((await movimientos()).map((m) => m.id_producto)).toEqual([11, 12]); // las anteriores quedaron aplicadas
    expect(fallo).toHaveBeenCalledTimes(3); // se detuvo en la fila que falló: no siguió con las demás

    fallo.mockRestore();
    const aplicar = jest.spyOn(stockService, 'aplicarMovimiento');
    const repeticion = await cargar(cinco(), { clave: 'k-mitad' });
    expect(repeticion.status).toBe(200);
    expect(repeticion.body).toEqual({ creados: 5, rechazados: [] });
    expect(aplicar.mock.calls.map(([, datos]) => datos.idProducto)).toEqual([13, 14, 15]); // solo las que faltaban
    expect(await cuentaDe('movimientos')).toBe(5);
    expect(await discrepanciasDeKardex()).toEqual([]);
    expect([11, 12, 13, 14, 15].map((p) => p - 10)).toEqual((await db('saldos').orderBy('id_producto').pluck('cantidad_disponible')));
  });

  it('un 503 de un servicio que el motor no usa pero lanzaría (AppError 5xx) tampoco es un rechazo de fila: se propaga y las anteriores quedan aplicadas', async () => {
    const original = stockService.aplicarMovimiento;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto === 12) throw e.noDisponible('un servicio no responde');
      return original(trx, datos);
    });
    esError(await cargar(cinco(), { clave: 'k-503' }), 503, 'SERVICIO_NO_DISPONIBLE');
    expect((await movimientos()).map((m) => m.id_producto)).toEqual([11]);
  });

  it('un AppError 4xx del motor es un rechazo de ESA fila (no un 5xx): su mensaje es el motivo y las demás filas siguen', async () => {
    /* Control del anterior: con otro código, el mismo mock da 200. */
    const original = stockService.aplicarMovimiento;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto === 12) throw e.conflicto('CONFLICTO', 'conflicto simulado del motor');
      return original(trx, datos);
    });
    const res = await cargar(cinco(), { clave: 'k-4xx' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 4, rechazados: [{ fila: 2, motivo: 'conflicto simulado del motor' }] });
  });

  it('un error de la fila que NO es del motor sino de código (TypeError) se propaga como 500 en vez de volverse un rechazo silencioso', async () => {
    jest.spyOn(stockService, 'aplicarMovimiento').mockRejectedValue(new TypeError('argumento imposible simulado'));
    const res = await cargar(cinco(), { clave: 'k-typeerror' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/simulado/);
    expect(await cuentaDe('movimientos')).toBe(0);
  });

  it.each([
    ['sin esa fila confirmada, el mismo 4xx del motor SÍ es un rechazo (control)', false, { creados: 4, rechazados: [{ fila: 2, motivo: 'La bodega está inactiva: no admite movimientos' }] }],
    ['con esa fila ya confirmada por otra petición con la misma clave, la fila cuenta como CREADA aunque el motor la rechace con un 4xx (BODEGA_INACTIVA, o un desborde porque ya sumó)', true, { creados: 5, rechazados: [] }],
  ])('reintento solapado visto desde la fila: %s', async (_descripcion, otraPeticionYaLaAplico, esperado) => {
    /* Se relee la clave ANTES de clasificar el error. El mock simula a la otra petición: confirma el movimiento con esta misma
       clave y después el motor rechaza con un 4xx. */
    const original = stockService.aplicarMovimiento;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto !== 12) return original(trx, datos);
      if (otraPeticionYaLaAplico) {
        await db('movimientos').insert({
          tipo: 'CARGA_INICIAL', id_producto: datos.idProducto, id_bodega: datos.idBodega, cantidad: datos.cantidad, saldo_resultante: datos.cantidad,
          id_usuario: USUARIO, clave_idempotencia: datos.claveIdempotencia,
        });
      }
      throw e.conflicto('BODEGA_INACTIVA', 'La bodega está inactiva: no admite movimientos');
    });
    const res = await cargar(cinco(), { clave: 'k-4xx-solapado' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(esperado);
  });

  it('reintento solapado visto desde la fila, con el 23505 de la clave: la otra petición confirmó entre la consulta inicial y el INSERT → la fila cuenta como creada y no se suma dos veces', async () => {
    const original = stockService.aplicarMovimiento;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto === 12) {
        // La otra petición confirma su transacción completa (saldo + movimiento) mientras esta ya empezó la suya.
        await db.transaction((otra) => original(otra, datos));
      }
      return original(trx, datos);
    });
    const res = await cargar(cinco(), { clave: 'k-23505' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 5, rechazados: [] });
    expect(await saldoDe(12)).toBe(2); // 2, no 4: la transacción duplicada se deshizo entera
    expect(await cuentaDe('movimientos')).toBe(5);
  });

  // El 422 de desborde que el motor lanza cuando el saldo ya sumó la fila (porque OTRA petición con la misma clave la aplicó).
  const desborde = () => e.datosNoValidos([{ campo: 'cantidad', mensaje: 'el saldo resultante superaría el máximo permitido (2147483647)' }]);

  it('control: un 4xx del motor SIN movimiento con la clave y con la relectura sana SÍ es un rechazo de esa fila (200 con su motivo)', async () => {
    /* El control de la prueba siguiente: lo único que cambia allí es que la relectura falla. */
    const original = stockService.aplicarMovimiento;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto === 12) throw desborde();
      return original(trx, datos);
    });
    const res = await cargar(cinco(), { clave: 'k-relectura-sana' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ creados: 4, rechazados: [{ fila: 2, motivo: 'cantidad: el saldo resultante superaría el máximo permitido (2147483647)' }] });
  });

  it('si la RELECTURA de la clave falla, un 4xx del motor NO se informa como rechazo de la fila (que quizá sí se creó): la petición es un 500 genérico y la repetición cuenta la fila como creada', async () => {
    /* Ruling 61. La otra petición con la misma clave confirmó la fila 2 y esta recibe del motor el desborde que depende de eso;
       justo entonces la base corta la conexión al releer. Clasificar el 4xx original daría un 200 con una fila «rechazada»
       que existe. */
    const original = stockService.aplicarMovimiento;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      if (datos.idProducto !== 12) return original(trx, datos);
      await db.transaction((otra) => original(otra, datos)); // la otra petición confirma su transacción completa (saldo + movimiento)
      throw desborde();
    });
    const relecturaReal = movimientoRepository.findByClave;
    const relectura = jest.spyOn(movimientoRepository, 'findByClave').mockImplementation(async (conexion, clave) => {
      if (clave.endsWith('#2')) throw new Error('Connection terminated unexpectedly');
      return relecturaReal(conexion, clave);
    });
    const res = await cargar(cinco(), { clave: 'k-relectura-falla' });
    expect(relectura.mock.calls.map(([, clave]) => clave)).toEqual([`${USUARIO}:ini:k-relectura-falla#2`]); // se intentó releer ESA fila
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { codigo: 'ERROR_INTERNO', mensaje: expect.any(String), detalles: [] } });
    expect(JSON.stringify(res.body)).not.toMatch(/Connection terminated|cantidad|máximo/); // ni el error de la relectura ni el 4xx del motor salen
    expect((await movimientos()).map((m) => m.id_producto)).toEqual([11, 12]); // la fila 1 y la que aplicó la otra; se detuvo ahí

    jest.restoreAllMocks();
    const aplicar = jest.spyOn(stockService, 'aplicarMovimiento');
    const repeticion = await cargar(cinco(), { clave: 'k-relectura-falla' });
    expect(repeticion.status).toBe(200);
    expect(repeticion.body).toEqual({ creados: 5, rechazados: [] }); // la 2 cuenta como creada (la reconoce clavesExistentes) y no queda en rechazados
    expect(aplicar.mock.calls.map(([, datos]) => datos.idProducto)).toEqual([13, 14, 15]);
    expect(await saldoDe(12)).toBe(2); // aplicada UNA vez
    expect(await cuentaDe('movimientos')).toBe(5);
    expect(await discrepanciasDeKardex()).toEqual([]);
  });

  it('un fallo que no es de negocio cuando NO hay movimiento con la clave relanza el MISMO error (no lo oculta la relectura)', async () => {
    jest.spyOn(stockService, 'aplicarMovimiento').mockRejectedValue(Object.assign(new Error('deadlock simulado'), { code: '40P01' }));
    const res = await cargar(cinco(), { clave: 'k-40p01' });
    expect(res.status).toBe(500);
    expect(res.body.error.codigo).toBe('ERROR_INTERNO');
  });
});

describe('POST /internas/saldos/carga-inicial: un reintento SOLAPADO con la primera ejecución (RNF17, ms-reportes reintenta a los 3 s)', () => {
  it('determinista: la primera ejecución tiene la fila 1 aplicada y sin confirmar; el reintento con la misma clave se pone en fila detrás de su saldo, y al confirmar la primera no duplica: las dos responden 200 con los mismos creados', async () => {
    /* La primera pausa DENTRO de su transacción con el saldo bloqueado y el movimiento insertado; el reintento llega a ese saldo
       y espera (esperarBloqueo). Al soltarla: el reintento ve el saldo ya sumado, intenta insertar la MISMA clave, choca (23505),
       se deshace entera y relee la clave → creada. Sin la relectura del reintento sería un 500. */
    const filas = [fila({ id_producto: 1, cantidad: 4 }), fila({ id_producto: 2, cantidad: 5, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' }), fila({ id_producto: 1, cantidad: 6 })];
    const original = stockService.aplicarMovimiento;
    let avisarPausada;
    const pausada = new Promise((resolver) => { avisarPausada = resolver; });
    let soltar;
    const hastaSoltar = new Promise((resolver) => { soltar = resolver; });
    let llamadas = 0;
    jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
      const movimiento = await original(trx, datos);
      llamadas += 1;
      if (llamadas === 1) {
        avisarPausada();
        await hastaSoltar;
      }
      return movimiento;
    });
    const relectura = jest.spyOn(movimientoRepository, 'findByClave');

    const primera = cargar(filas, { clave: 'k-solapa' }).then((res) => res);
    await pausada;
    const reintento = cargar(filas, { clave: 'k-solapa' }).then((res) => res);
    await esperarBloqueo(db);
    expect(await cuentaDe('movimientos')).toBe(0); // la primera aún no confirmó
    soltar();
    const [a, b] = await Promise.all([primera, reintento]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual({ creados: 3, rechazados: [] });
    expect(b.body).toEqual(a.body);
    expect(relectura.mock.calls.map(([, clave]) => clave)).toContain(`${USUARIO}:ini:k-solapa#1`); // el reintento resolvió su choque releyendo la clave
    expect((await movimientos()).map((m) => [m.id_producto, m.cantidad, m.saldo_resultante])).toEqual([[1, 4, 4], [2, 5, 5], [1, 6, 10]]);
    expect(await cuentaDe('lotes')).toBe(1);
    expect((await db('lotes'))[0].cantidad_disponible).toBe(5); // el lote no sumó dos veces
    expect(await discrepanciasDeKardex()).toEqual([]);
  });
});

describe('POST /internas/saldos/carga-inicial: el cliente se desconecta (ms-reportes corta a los 3 s y reintenta)', () => {
  it('el servidor SIGUE procesando y termina de aplicar todas las filas sin ningún error: por eso los reintentos convergen (cada fila es idempotente)', async () => {
    /* La primera fila se aplica y la ejecución queda en pausa; el cliente corta la conexión; el registro de la petición confirma
       que se cerró con la respuesta sin enviar; al reanudar, el servicio termina las cinco filas. Un servidor HTTP propio (y no
       el de supertest) para cerrarlo con certeza al terminar: un cliente que aborta deja abierto el de supertest. */
    const registros = [];
    const errores = [];
    const otra = buildTestApp({ logger: { info: (registro) => registros.push(registro), error: (linea) => errores.push(linea) } });
    const servidor = http.createServer(otra.app);
    await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
    let soltar;
    const hastaSoltar = new Promise((resolver) => { soltar = resolver; });
    try {
      const original = stockService.aplicarMovimiento;
      let avisarPausada;
      const pausada = new Promise((resolver) => { avisarPausada = resolver; });
      let llamadas = 0;
      jest.spyOn(stockService, 'aplicarMovimiento').mockImplementation(async (trx, datos) => {
        const movimiento = await original(trx, datos);
        llamadas += 1;
        if (llamadas === 1) {
          avisarPausada();
          await hastaSoltar;
        }
        return movimiento;
      });
      const filas = [1, 2, 3, 4, 5].map((id) => fila({ id_producto: 20 + id, cantidad: id }));
      const cuerpo = JSON.stringify({ filas });
      const cliente = http.request({
        host: '127.0.0.1', port: servidor.address().port, method: 'POST', path: RUTA,
        headers: { ...ADM, 'Idempotency-Key': 'k-aborta', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) },
      });
      cliente.on('error', () => {}); // al cortar, el cliente ve «socket hang up»: es lo esperado
      cliente.end(cuerpo);
      await pausada;
      cliente.destroy();
      const limite = Date.now() + 5000;
      while (!registros.some((registro) => registro.ruta === RUTA && registro.abortada) && Date.now() < limite) {
        await new Promise((resolver) => setTimeout(resolver, 10));
      }
      expect(registros.filter((registro) => registro.ruta === RUTA).map((registro) => [registro.estado, registro.abortada])).toEqual([[null, true]]);
      expect(await cuentaDe('movimientos')).toBe(0); // la primera fila aún no confirmó
      soltar();
      const hasta = Date.now() + 10000;
      while ((await cuentaDe('movimientos')) < 5 && Date.now() < hasta) await new Promise((resolver) => setTimeout(resolver, 10));
      expect((await movimientos()).map((m) => m.id_producto)).toEqual([21, 22, 23, 24, 25]);
      // La repetición con la misma clave (el reintento de ms-reportes) encuentra todo aplicado.
      jest.restoreAllMocks();
      expect((await cargar(filas, { clave: 'k-aborta' })).body).toEqual({ creados: 5, rechazados: [] });
      expect(await cuentaDe('movimientos')).toBe(5);
      expect(errores).toEqual([]);
    } finally {
      soltar(); // si la prueba falló antes, la ejecución en pausa debe terminar o el pool no se puede cerrar
      servidor.closeAllConnections();
      await new Promise((resolver) => servidor.close(resolver));
      await otra.db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Concurrencia (PostgreSQL real)
// ---------------------------------------------------------------------------------------------------------------------------

describe('POST /internas/saldos/carga-inicial: concurrencia (PostgreSQL real)', () => {
  // 200 filas sobre 10 productos y dos bodegas, con lotes (mismo código y misma fecha por producto), una fila a una bodega que no
  // existe (la 8) y una con la fecha de un lote ya existente cambiada (la 191, que el motor rechaza).
  function filasMezcla({ desde = 0, cuantas = 200, semilla = 0 } = {}) {
    const filas = [];
    for (let i = desde; i < desde + cuantas; i += 1) {
      const idProducto = 1 + (i % 10);
      const idBodega = i % 2 === 0 ? B2 : B1;
      const cantidad = 1 + ((i + semilla) % 7);
      if (i === 7) filas.push({ id_producto: idProducto, id_bodega: 999, cantidad });
      else if (i === 190) filas.push({ id_producto: idProducto, id_bodega: idBodega, cantidad, codigo_lote: `L${idProducto}`, fecha_vencimiento: '2030-01-01' });
      else if (i % 5 === 0) filas.push({ id_producto: idProducto, id_bodega: idBodega, cantidad, codigo_lote: `L${idProducto}`, fecha_vencimiento: `2027-${10 + (idProducto % 3)}-15` });
      else filas.push({ id_producto: idProducto, id_bodega: idBodega, cantidad });
    }
    return filas;
  }
  const RECHAZADAS = [8, 191];
  // Lo que deben dejar las filas aplicadas: saldo por (producto-bodega) y cantidad por lote.
  function esperadoDe(listas) {
    const saldos = {};
    const lotes = {};
    for (const filas of listas) {
      filas.forEach((f, i) => {
        if (filas === listas[0] && RECHAZADAS.includes(i + 1)) return;
        saldos[`${f.id_producto}-${f.id_bodega}`] = (saldos[`${f.id_producto}-${f.id_bodega}`] ?? 0) + f.cantidad;
        if (f.codigo_lote) lotes[`${f.id_producto}-${f.id_bodega}-${f.codigo_lote}`] = (lotes[`${f.id_producto}-${f.id_bodega}-${f.codigo_lote}`] ?? 0) + f.cantidad;
      });
    }
    return { saldos, lotes };
  }
  const estadoReal = async () => ({
    saldos: Object.fromEntries((await db('saldos')).map((s) => [`${s.id_producto}-${s.id_bodega}`, s.cantidad_disponible])),
    lotes: Object.fromEntries((await db('lotes')).map((l) => [`${l.id_producto}-${l.id_bodega}-${l.codigo_lote}`, l.cantidad_disponible])),
  });

  it('la MISMA petición 3 veces SIMULTÁNEAS (reintentos solapados) con 200 filas → las tres 200 con creados 198 y los mismos rechazados; exactamente 198 movimientos y saldos y lotes correctos; sin 5xx ni 40P01', async () => {
    const filas = filasMezcla();
    const relectura = jest.spyOn(movimientoRepository, 'findByClave');
    const respuestas = await Promise.all([1, 2, 3].map(() => cargar(filas, { clave: 'k-triple' })));
    sinCincoXX(respuestas);
    expect(relectura.mock.calls.length).toBeGreaterThan(0); // los choques existieron: las seguidoras releyeron la clave de la fila que otra ya aplicó
    expect(respuestas.map((res) => res.status)).toEqual([200, 200, 200]);
    for (const res of respuestas) {
      expect(res.body.creados).toBe(198);
      expect(res.body.rechazados.map((r) => r.fila)).toEqual(RECHAZADAS);
    }
    expect(respuestas[1].body).toEqual(respuestas[0].body);
    expect(respuestas[2].body).toEqual(respuestas[0].body);
    expect(await cuentaDe('movimientos')).toBe(198);
    expect(new Set(await claves()).size).toBe(198);
    expect(await estadoReal()).toEqual(esperadoDe([filas]));
    expect(await discrepanciasDeKardex()).toEqual([]);
  });

  it('lo mismo con un pool de 3 conexiones y 6 peticiones idénticas simultáneas: sin interbloqueo, sin agotar el pool y sin duplicar', async () => {
    /* Una petición usa una sola conexión a la vez (dentro de la transacción solo `trx`): con 6 peticiones sobre 3 conexiones nadie espera una conexión que otra no pueda soltar. */
    const dbChico = knex({ ...construirConfigKnex(configDePrueba()), pool: { min: 0, max: 3 } });
    const errores = [];
    const chico = supertest(createApp({ db: dbChico, clients, logger: { info() {}, error: (linea) => errores.push(linea) }, env: entornoValido() }));
    try {
      const filas = filasMezcla({ cuantas: 100 });
      const respuestas = await Promise.all(Array.from({ length: 6 }, () => cargar(filas, { clave: 'k-pool', cliente: chico })));
      sinCincoXX(respuestas);
      expect(errores).toEqual([]);
      expect(respuestas.map((res) => res.body.creados)).toEqual(Array(6).fill(99));
      expect(await cuentaDe('movimientos')).toBe(99);
      expect(await estadoReal()).toEqual(esperadoDe([filas]));
      expect(await discrepanciasDeKardex()).toEqual([]);
    } finally {
      await dbChico.destroy();
    }
  });

  it('dos cargas DISTINTAS con filas sobre los MISMOS saldos y lotes a la vez, con un pool de 3 conexiones: sin 5xx ni interbloqueo, suma(lotes) ≤ saldo y el kardex encadena los saldo_resultante', async () => {
    const dbChico = knex({ ...construirConfigKnex(configDePrueba()), pool: { min: 0, max: 3 } });
    const errores = [];
    const chico = supertest(createApp({ db: dbChico, clients, logger: { info() {}, error: (linea) => errores.push(linea) }, env: entornoValido() }));
    try {
      const a = filasMezcla({ cuantas: 150 });
      const b = [...filasMezcla({ cuantas: 150, semilla: 3 })].reverse(); // el mismo conjunto de pares, en orden inverso
      const respuestas = await Promise.all([cargar(a, { clave: 'k-a', cliente: chico }), cargar(b, { clave: 'k-b', cliente: chico })]);
      sinCincoXX(respuestas);
      expect(errores).toEqual([]);
      expect(respuestas.map((res) => res.status)).toEqual([200, 200]);
      const aplicadas = respuestas.reduce((suma, res) => suma + res.body.creados, 0);
      expect(await cuentaDe('movimientos')).toBe(aplicadas);
      // Suma total por par = la de todas las filas aplicadas de las dos cargas (las rechazadas por posición de cada una no suman).
      const rechazadasA = new Set(respuestas[0].body.rechazados.map((r) => r.fila));
      const rechazadasB = new Set(respuestas[1].body.rechazados.map((r) => r.fila));
      const saldos = {};
      [[a, rechazadasA], [b, rechazadasB]].forEach(([filas, rechazadas]) => filas.forEach((f, i) => {
        if (!rechazadas.has(i + 1)) saldos[`${f.id_producto}-${f.id_bodega}`] = (saldos[`${f.id_producto}-${f.id_bodega}`] ?? 0) + f.cantidad;
      }));
      expect((await estadoReal()).saldos).toEqual(saldos);
      expect(await discrepanciasDeKardex()).toEqual([]);
    } finally {
      await dbChico.destroy();
    }
  });

  it('una carga simultánea con movimientos normales (ENTRADA, SALIDA, AJUSTE y traslados) sobre los MISMOS saldos, con un pool de 3 conexiones: sin 5xx, sin 40P01 y el kardex encadena desde el saldo sembrado', async () => {
    /* D24, D25c: cada transacción de fila toma UN saldo, así que no hay ciclo con las que toman otros. */
    const dbChico = knex({ ...construirConfigKnex(configDePrueba()), pool: { min: 0, max: 3 } });
    const errores = [];
    const chico = supertest(createApp({ db: dbChico, clients, logger: { info() {}, error: (linea) => errores.push(linea) }, env: entornoValido(), now: () => new Date(MEDIODIA) }));
    try {
      const inicial = {};
      for (const p of [1, 2, 3, 4, 5]) {
        for (const b of [B1, B2]) {
          await crearSaldo(db, { idProducto: p, idBodega: b, cantidad: 20 });
          inicial[`${p}-${b}`] = 20;
        }
      }
      const carga = filasMezcla({ cuantas: 100 }).filter((f) => f.id_producto <= 5);
      const post = (ruta, cuerpo) => chico.post(ruta).set(ADM).set('Idempotency-Key', nuevaClave()).send(cuerpo);
      const mov = (tipo, p, cantidad, b = B1) => post('/movimientos', { tipo, id_producto: p, id_bodega: b, cantidad });
      const respuestas = await Promise.all([
        cargar(carga, { clave: 'k-mezcla', cliente: chico }),
        cargar(carga, { clave: 'k-mezcla', cliente: chico }),
        ...[1, 2, 3, 4, 5].flatMap((p) => [mov('SALIDA', p, 3), mov('ENTRADA', p, 2, B2), mov('AJUSTE', p, -1), mov('SALIDA', p, 2, B2)]),
        ...[1, 2, 3].map((p) => post('/traslados', { id_producto: p, id_bodega_origen: B2, id_bodega_destino: B1, cantidad: 1 })),
      ]);
      sinCincoXX(respuestas);
      expect(errores).toEqual([]);
      for (const res of respuestas) expect([200, 201, 409]).toContain(res.status);
      for (const res of respuestas.filter((r) => r.status === 409)) expect(res.body.error.codigo).toBe('STOCK_INSUFICIENTE');
      expect(respuestas.slice(0, 2).map((res) => res.status)).toEqual([200, 200]);
      expect(respuestas[1].body).toEqual(respuestas[0].body);
      // Los traslados en tránsito sacaron stock del origen y no lo han vuelto a sumar: el kardex lo refleja con TRASLADO_SALIDA.
      expect(await discrepanciasDeKardex(inicial)).toEqual([]);
    } finally {
      await dbChico.destroy();
    }
  });
});
