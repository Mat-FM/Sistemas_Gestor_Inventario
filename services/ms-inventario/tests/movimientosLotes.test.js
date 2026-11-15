const { buildTestApp } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearSaldo, crearUmbral, headers } = require('./helpers/fixtures');
const { datosNoValidos, esError, recursoNoExiste, stockInsuficiente } = require('./helpers/respuestas');

// Lotes y salida FEFO en POST /movimientos (RF17; D6, D27) de punta a punta, contra PostgreSQL real. La regla va por el SIGNO del
// movimiento: lo que sube entra sin lote, a un lote por id o a un lote por código; lo que baja sale de un lote por id o por FEFO.
// La planificación pura está en fefo.test.js, el SQL en lotesCapas.test.js y los tipos que la API no admite en stock.test.js.
//
// Tras CADA prueba se comprueba en la base el invariante de D27(c): por (producto, bodega), la suma de los lotes nunca supera
// el saldo y ningún lote es negativo.

const MAXIMO = 2147483647;
const LARGO_CODIGO = 50; // lotes.codigo_lote es varchar(50) (migración 20261103000100)
const ADM = headers('ADMINISTRADOR');

let request;
let db;
let clients;
let b1;
let b2;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp());
});
beforeEach(async () => {
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
  b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
  clients.catalogo.obtenerProducto.mockClear();
  clients.notificaciones.notificarStockBajo.mockReset().mockResolvedValue(undefined);
});
afterEach(() => comprobarInvariante());
afterAll(() => db.destroy());

let contador = 0;
const nuevaClave = () => `kl-${(contador += 1)}`;
const post = (cuerpo, clave = nuevaClave(), cabeceras = ADM) => request.post('/movimientos').set(cabeceras).set('Idempotency-Key', clave).send(cuerpo);
const mov = (tipo, cantidad, extra = {}) => ({ tipo, id_producto: 5, id_bodega: b1, cantidad, ...extra });
const salida = (cantidad, extra) => mov('SALIDA', cantidad, extra);
const entrada = (cantidad, extra) => mov('ENTRADA', cantidad, extra);

const sembrarLote = (codigo, fecha, cantidad, extra = {}) => crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad, ...extra });
const saldoDe = async (idProducto = 5, idBodega = b1) => (await db('saldos').where({ id_producto: idProducto, id_bodega: idBodega }).first())?.cantidad_disponible;
const lotes = () => db('lotes').select('id_lote', 'id_bodega', 'id_producto', 'codigo_lote', 'fecha_vencimiento', 'cantidad_disponible').orderBy('id_lote');
const existencias = async () => Object.fromEntries((await lotes()).map((l) => [l.codigo_lote, l.cantidad_disponible]));
const movimientos = () => db('movimientos').select('*').orderBy('id_movimiento');
// Foto de todo lo que un rechazo no debe cambiar.
const foto = async () => ({ saldos: await db('saldos').select('*').orderBy('id_saldo'), lotes: await lotes(), movimientos: await movimientos() });

async function comprobarInvariante() {
  const { rows } = await db.raw(`
    SELECT l.id_producto, l.id_bodega, SUM(l.cantidad_disponible)::int AS en_lotes, MIN(l.cantidad_disponible) AS minimo,
           COALESCE(MAX(s.cantidad_disponible), 0) AS saldo
    FROM lotes l LEFT JOIN saldos s ON s.id_producto = l.id_producto AND s.id_bodega = l.id_bodega
    GROUP BY l.id_producto, l.id_bodega`);
  for (const fila of rows) {
    expect({ ...fila, cumple: fila.en_lotes <= fila.saldo && fila.minimo >= 0 }).toEqual({ ...fila, cumple: true });
  }
}

describe('casos del brief', () => {
  it('ENTRADA con lote { codigo_lote: "L1", fecha_vencimiento: "2027-01-31" } crea el lote; una segunda entrada con el mismo código suma al mismo lote', async () => {
    /* La primera crea el lote (y el movimiento lo referencia); la segunda suma y referencia el mismo. */
    const primera = await post(entrada(4, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' } }));
    expect(primera.status).toBe(201);
    const [creado] = await lotes();
    expect(creado).toEqual({ id_lote: creado.id_lote, id_bodega: b1, id_producto: 5, codigo_lote: 'L1', fecha_vencimiento: '2027-01-31', cantidad_disponible: 4 });
    expect(primera.body).toMatchObject({ id_lote: creado.id_lote, saldo_resultante: 4 });
    const segunda = await post(entrada(6, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' } }));
    expect(segunda.body).toMatchObject({ id_lote: creado.id_lote, saldo_resultante: 10 });
    expect(await lotes()).toEqual([{ ...creado, cantidad_disponible: 10 }]);
  });

  it('ENTRADA con id_lote y con lote a la vez → 422; fecha_vencimiento "2027-13-40" → 422', async () => {
    /* Control: cada uno por separado es válido. */
    const a = await sembrarLote('A', null, 0);
    expect((await post(entrada(1, { id_lote: a.id_lote }))).status).toBe(201);
    expect((await post(entrada(1, { lote: { codigo_lote: 'N', fecha_vencimiento: '2027-03-01' } }))).status).toBe(201);
    const antes = await foto();
    datosNoValidos(await post(entrada(1, { id_lote: a.id_lote, lote: { codigo_lote: 'N', fecha_vencimiento: '2027-03-01' } })), ['lote']);
    datosNoValidos(await post(entrada(1, { lote: { codigo_lote: 'N', fecha_vencimiento: '2027-13-40' } })), ['lote.fecha_vencimiento']);
    expect(await foto()).toEqual(antes);
  });

  it('SALIDA con id_lote descuenta ese lote; con menos existencia que la cantidad → 409 STOCK_INSUFICIENTE aunque el saldo alcance', async () => {
    /* Sin cambios tras el 409: ni el saldo ni ningún lote. Los detalles son los del LOTE. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const a = await sembrarLote('A', '2027-01-31', 3);
    await sembrarLote('B', '2027-02-28', 3);
    const ok = await post(salida(2, { id_lote: a.id_lote }));
    expect(ok.body).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 8 });
    expect(await existencias()).toEqual({ A: 1, B: 3 });
    const antes = await foto();
    stockInsuficiente(await post(salida(2, { id_lote: a.id_lote })), 'id_lote', 1, 2);
    expect(await foto()).toEqual(antes);
  });

  it('SALIDA con id_lote de otra bodega o producto → 404 NO_EXISTE', async () => {
    /* Control: el de la misma bodega y producto sí sale. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 5 });
    await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 5 });
    const propio = await sembrarLote('P', null, 5);
    const otraBodega = await sembrarLote('P', null, 5, { idBodega: b2 });
    const otroProducto = await sembrarLote('P', null, 5, { idProducto: 6 });
    expect((await post(salida(1, { id_lote: propio.id_lote }))).status).toBe(201);
    const antes = await foto();
    for (const id of [otraBodega.id_lote, otroProducto.id_lote, 99999]) recursoNoExiste(await post(salida(1, { id_lote: id })));
    expect(await foto()).toEqual(antes);
  });

  it('SALIDA 7 sin id_lote con A=5, B=5, C=4 → A=0, B=3, C=4; movimiento.id_lote = id de A (D6)', async () => {
    /* A vence antes que B y C no tiene fecha. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 14 });
    await sembrarLote('C', null, 4);
    await sembrarLote('B', '2027-03-31', 5);
    const a = await sembrarLote('A', '2027-01-31', 5);
    const res = await post(salida(7));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id_lote: a.id_lote, cantidad: 7, saldo_resultante: 7 });
    expect(await existencias()).toEqual({ C: 4, B: 3, A: 0 });
  });

  it('SALIDA 8 con lotes 5 y 5 unidades sin lote (saldo 10) → lote 0, saldo 2, id_lote del lote', async () => {
    /* El resto (3) sale del stock sin lote. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const l = await sembrarLote('L', '2027-01-31', 5);
    const res = await post(salida(8));
    expect(res.body).toMatchObject({ id_lote: l.id_lote, saldo_resultante: 2 });
    expect(await existencias()).toEqual({ L: 0 });
    expect(await saldoDe()).toBe(2);
  });
});

describe('matriz D27 por signo y por tipo', () => {
  // Saldo 10 = A 4 (vence 2027-01-31) + M 3 (2027-06-30) + 3 sin lote.
  let a;
  let m;
  beforeEach(async () => {
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    a = await sembrarLote('A', '2027-01-31', 4);
    m = await sembrarLote('M', '2027-06-30', 3);
  });
  const cuerpo = (tipo, cantidad, extra) => mov(tipo, tipo === 'AJUSTE' ? cantidad : Math.abs(cantidad), extra);

  const SUBEN = [['ENTRADA', 2], ['DEVOLUCION_CLIENTE', 2], ['ENTRADA_COMPRA', 2], ['AJUSTE', 2]];
  const BAJAN = [['SALIDA', -5], ['DEVOLUCION_PROVEEDOR', -5], ['AJUSTE', -5]];

  it.each(SUBEN)('%s (+%p) sin lote → solo el saldo; los lotes no cambian e id_lote es null', async (tipo, cantidad) => {
    /* El stock nuevo queda «sin lote». */
    const res = await post(cuerpo(tipo, cantidad));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tipo, id_lote: null, saldo_resultante: 12 });
    expect(await existencias()).toEqual({ A: 4, M: 3 });
  });

  it.each(SUBEN)('%s (+%p) con id_lote → suma a ESE lote y el movimiento lo referencia', async (tipo, cantidad) => {
    /* Entra a un lote ya existente por su id. */
    const res = await post(cuerpo(tipo, cantidad, { id_lote: m.id_lote }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tipo, id_lote: m.id_lote, saldo_resultante: 12 });
    expect(await existencias()).toEqual({ A: 4, M: 5 });
  });

  it.each(SUBEN)('%s (+%p) con lote nuevo → crea el lote con su fecha y el movimiento lo referencia', async (tipo, cantidad) => {
    /* Entra a un lote por código: si no existe, se crea. */
    const res = await post(cuerpo(tipo, cantidad, { lote: { codigo_lote: 'N', fecha_vencimiento: '2027-03-01' } }));
    expect(res.status).toBe(201);
    const nuevo = (await lotes()).find((l) => l.codigo_lote === 'N');
    expect(nuevo).toMatchObject({ fecha_vencimiento: '2027-03-01', cantidad_disponible: 2 });
    expect(res.body).toMatchObject({ tipo, id_lote: nuevo.id_lote, saldo_resultante: 12 });
    expect(await existencias()).toEqual({ A: 4, M: 3, N: 2 });
  });

  it.each(BAJAN)('%s (%p) sin id_lote → FEFO: agota A, toma 1 de M; id_lote = A', async (tipo, cantidad) => {
    /* El primero en vencer sale primero (D6). */
    const res = await post(cuerpo(tipo, cantidad));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tipo, id_lote: a.id_lote, saldo_resultante: 5 });
    expect(await existencias()).toEqual({ A: 0, M: 2 });
  });

  it.each(BAJAN)('%s (%p) con id_lote de M (3) → 409 del LOTE aunque el saldo alcance; con 2 sí sale de M', async (tipo, cantidad) => {
    /* Saldo 10 alcanza para 5, pero M solo tiene 3. Control: 2 de M. */
    const antes = await foto();
    stockInsuficiente(await post(cuerpo(tipo, cantidad, { id_lote: m.id_lote })), 'id_lote', 3, 5);
    expect(await foto()).toEqual(antes);
    const res = await post(cuerpo(tipo, Math.sign(cantidad) * 2, { id_lote: m.id_lote }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tipo, id_lote: m.id_lote, saldo_resultante: 8 });
    expect(await existencias()).toEqual({ A: 4, M: 1 });
  });

  it.each(BAJAN)('%s (%p) con lote → 422 sobre "lote" (no se crea un lote al retirar); nada cambia', async (tipo, cantidad) => {
    /* D27(b). */
    const antes = await foto();
    datosNoValidos(await post(cuerpo(tipo, cantidad, { lote: { codigo_lote: 'A', fecha_vencimiento: '2027-01-31' } })), ['lote']);
    expect(await foto()).toEqual(antes);
  });
});

describe('FEFO', () => {
  it('lotes desordenados, con y sin fecha, con empate de fecha (desempate por id_lote) y uno en 0', async () => {
    /* Orden esperado: E1 y E2 (misma fecha, por id), luego T, luego los sin fecha por id; VACIO no cuenta. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 20 });
    await sembrarLote('S1', null, 2);
    await sembrarLote('T', '2027-09-30', 2);
    await sembrarLote('VACIO', '2026-01-01', 0);
    const e1 = await sembrarLote('E1', '2027-05-01', 2);
    await sembrarLote('E2', '2027-05-01', 2);
    await sembrarLote('S2', null, 2);
    const res = await post(salida(9));
    expect(res.body).toMatchObject({ id_lote: e1.id_lote, saldo_resultante: 11 });
    expect(await existencias()).toEqual({ S1: 0, T: 0, VACIO: 0, E1: 0, E2: 0, S2: 1 }); // 2 + 2 + 2 + 2 + 1 = 9
  });

  it('salida MAYOR que el saldo → 409 con los datos del saldo y ningún lote cambia', async () => {
    /* El saldo manda: 15 > 14. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 14 });
    await sembrarLote('A', '2027-01-31', 5);
    await sembrarLote('B', null, 5);
    const antes = await foto();
    stockInsuficiente(await post(salida(15)), 'cantidad', 14, 15);
    expect(await foto()).toEqual(antes);
  });

  it('salida EXACTAMENTE igual a todo (lotes + sin lote) → todo queda en 0', async () => {
    /* El borde del 409. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 14 });
    const a = await sembrarLote('A', '2027-01-31', 5);
    await sembrarLote('B', null, 5);
    expect((await post(salida(14))).body).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 0 });
    expect(await existencias()).toEqual({ A: 0, B: 0 });
  });

  it('sin lotes con existencia, una salida se comporta como antes: id_lote null', async () => {
    /* Compatibilidad con la Tarea 7. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 5 });
    await sembrarLote('A', '2027-01-31', 0);
    expect((await post(salida(3))).body).toMatchObject({ id_lote: null, saldo_resultante: 2 });
  });

  it('solo consume lotes de ESA bodega y ESE producto', async () => {
    /* Los lotes de otro par ni se miran. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 3 });
    await crearSaldo(db, { idProducto: 5, idBodega: b2, cantidad: 3 });
    await crearSaldo(db, { idProducto: 6, idBodega: b1, cantidad: 3 });
    await sembrarLote('X', '2026-01-01', 3, { idBodega: b2 });
    await sembrarLote('Y', '2026-01-01', 3, { idProducto: 6 });
    const propio = await sembrarLote('P', '2027-01-01', 2);
    expect((await post(salida(3))).body).toMatchObject({ id_lote: propio.id_lote, saldo_resultante: 0 });
    expect(await existencias()).toEqual({ X: 3, Y: 3, P: 0 });
  });
});

describe('entrada a un lote existente por código (D27(d))', () => {
  beforeEach(async () => {
    await post(entrada(4, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' } }));
  });

  it('con la MISMA fecha suma', async () => {
    /* Es el mismo lote. */
    expect((await post(entrada(1, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' } }))).status).toBe(201);
    expect(await existencias()).toEqual({ L1: 5 });
  });

  it('con OTRA fecha → 409 CONFLICTO sobre lote.fecha_vencimiento; nada cambia y la clave NO se guarda (el reintento corregido da 201)', async () => {
    /* Una fecha ignorada en silencio sacaría mercancía vencida antes de tiempo. */
    const antes = await foto();
    const res = await post(entrada(1, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-02-01' } }), 'k-fecha');
    esError(res, 409, 'CONFLICTO', ['lote.fecha_vencimiento']);
    expect(res.body.error.detalles[0].mensaje).toContain('2027-01-31');
    expect(await foto()).toEqual(antes);
    expect((await post(entrada(1, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' } }), 'k-fecha')).status).toBe(201);
  });

  // «Fecha omitida suma sin tocar la guardada» y «guardada sin fecha + fecha → 409» solo son alcanzables desde la carga inicial
  // (D28(b)): se prueban en el motor (stock.test.js).
  it('con la fecha omitida o null → 422 sobre "lote.fecha_vencimiento" (D28(b): obligatoria con lote); nada cambia', async () => {
    /* Control positivo dentro de la prueba: con la fecha guardada suma. Así el 422 solo puede deberse a la fecha que falta. */
    expect((await post(entrada(1, { lote: { codigo_lote: 'L1', fecha_vencimiento: '2027-01-31' } }))).status).toBe(201);
    const antes = await foto();
    datosNoValidos(await post(entrada(1, { lote: { codigo_lote: 'L1' } })), ['lote.fecha_vencimiento']);
    datosNoValidos(await post(entrada(1, { lote: { codigo_lote: 'L1', fecha_vencimiento: null } })), ['lote.fecha_vencimiento']);
    datosNoValidos(await post(entrada(1, { lote: { codigo_lote: 'NUEVO' } })), ['lote.fecha_vencimiento']);
    expect(await foto()).toEqual(antes);
  });

  it('el código se recorta: "  L1  " es el lote L1', async () => {
    /* texto() recorta los extremos antes de guardar y de comparar. */
    expect((await post(entrada(1, { lote: { codigo_lote: '  L1  ', fecha_vencimiento: '2027-01-31' } }))).status).toBe(201);
    expect(await existencias()).toEqual({ L1: 5 });
  });

  it('una fecha pasada se acepta (el contrato no la prohíbe)', async () => {
    /* D27(e). */
    expect((await post(entrada(1, { lote: { codigo_lote: 'VIEJO', fecha_vencimiento: '2020-01-01' } }))).status).toBe(201);
  });
});

describe('validación del cuerpo (422)', () => {
  it.each([
    ['2027-13-40'], ['2027-02-30'], ['2027-1-5'], ['27-01-31'], [20270131], ['2027-01-31T00:00:00Z'],
  ])('lote.fecha_vencimiento %p → 422 sobre "lote.fecha_vencimiento"', async (fecha) => {
    /* Fecha real YYYY-MM-DD (la matriz completa de fecha() está en validate.test.js). Control: 2027-02-28. */
    expect((await post(entrada(1, { lote: { codigo_lote: 'F', fecha_vencimiento: '2027-02-28' } }))).status).toBe(201);
    datosNoValidos(await post(entrada(1, { lote: { codigo_lote: 'G', fecha_vencimiento: fecha } })), ['lote.fecha_vencimiento']);
  });

  it(`lote.codigo_lote: ${LARGO_CODIGO} caracteres → 201; ${LARGO_CODIGO + 1} → 422 (nunca el 22001); vacío, solo espacios, ausente, un número o con NUL → 422`, async () => {
    /* El largo exacto de la columna y el cableado del campo; el resto de texto() está en validate.test.js. */
    expect((await post(entrada(1, { lote: { codigo_lote: 'x'.repeat(LARGO_CODIGO), fecha_vencimiento: '2027-03-01' } }))).status).toBe(201);
    for (const codigo of ['x'.repeat(LARGO_CODIGO + 1), '', '   ', undefined, 5, 'a\u0000b']) {
      datosNoValidos(await post(entrada(1, { lote: { codigo_lote: codigo, fecha_vencimiento: '2027-03-01' } })), ['lote.codigo_lote']);
    }
  });

  it('informa a la vez el código y la fecha del lote inválidos', async () => {
    /* Los dos detalles, en orden. */
    datosNoValidos(await post(entrada(1, { lote: { codigo_lote: '', fecha_vencimiento: 'x' } })), ['lote.codigo_lote', 'lote.fecha_vencimiento']);
  });

  it.each([[0], [-1], [1.5], ['3'], [MAXIMO + 1], [true], [[1]]])('id_lote %p → 422 sobre "id_lote"', async (idLote) => {
    /* Entero positivo dentro del INTEGER. */
    datosNoValidos(await post(entrada(1, { id_lote: idLote })), ['id_lote']);
  });

  it('id_lote null y lote null se tratan como ausentes → 201 sin lote', async () => {
    /* null no es «salida por FEFO forzada»: es lo mismo que no enviarlo. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 5 });
    expect((await post(entrada(1, { id_lote: null, lote: null }))).body).toMatchObject({ id_lote: null, saldo_resultante: 6 });
    expect((await post(salida(1, { id_lote: null, lote: null }))).body).toMatchObject({ id_lote: null, saldo_resultante: 5 });
  });

  it.each([['L1'], [['L1']], [5], [true]])('lote %p (no es un objeto) → 422 sobre "lote"', async (lote) => {
    /* Solo un objeto {codigo_lote, fecha_vencimiento}, ambos obligatorios (D28(b)); el mensaje lo dice. */
    const res = await post(entrada(1, { lote }));
    datosNoValidos(res, ['lote']);
    expect(res.body.error.detalles[0].mensaje).toBe('debe ser un objeto { codigo_lote, fecha_vencimiento }, ambos obligatorios');
  });

  it('los campos extra dentro de lote se ignoran (id_lote, cantidad_disponible…)', async () => {
    /* Como en el resto del cuerpo: lo que fija el servidor no se toma del cliente. */
    const res = await post(entrada(2, { lote: { codigo_lote: 'X', fecha_vencimiento: '2027-03-01', id_lote: 777, cantidad_disponible: 1000, id_bodega: b2 } }));
    expect(res.status).toBe(201);
    expect(await lotes()).toEqual([expect.objectContaining({ codigo_lote: 'X', cantidad_disponible: 2, id_bodega: b1 })]);
    expect(res.body.id_lote).not.toBe(777);
  });

  it('lote en un AJUSTE positivo se acepta y en uno negativo es 422 (el signo lo decide)', async () => {
    /* D27 va por el signo, no por el tipo. */
    expect((await post(mov('AJUSTE', 2, { lote: { codigo_lote: 'AJ', fecha_vencimiento: '2027-03-01' } }))).status).toBe(201);
    datosNoValidos(await post(mov('AJUSTE', -1, { lote: { codigo_lote: 'AJ', fecha_vencimiento: '2027-03-01' } })), ['lote']);
  });

  it.each([[0], [MAXIMO + 1], ['3']])('SALIDA con lote y cantidad inválida %p → 422 solo sobre "cantidad" (el signo no se conoce: no se inventa un error de lote)', async (cantidad) => {
    /* Control: con cantidad válida, el lote en una SALIDA sí es un error propio. */
    datosNoValidos(await post(salida(1, { lote: { codigo_lote: 'L', fecha_vencimiento: '2027-03-01' } })), ['lote']);
    datosNoValidos(await post(salida(cantidad, { lote: { codigo_lote: 'L', fecha_vencimiento: '2027-03-01' } })), ['cantidad']);
  });

  it('informa todos los campos inválidos a la vez, en el orden del contrato', async () => {
    /* tipo, id_producto, id_bodega, cantidad, id_lote, lote, documento_referencia, observacion. */
    datosNoValidos(await post({ tipo: 'X', id_producto: 0, id_bodega: 'b', cantidad: 0, id_lote: 0, lote: 'L', documento_referencia: '', observacion: 7 }), [
      'tipo', 'id_producto', 'id_bodega', 'cantidad', 'id_lote', 'lote', 'documento_referencia', 'observacion',
    ]);
  });

  it('entrada hostil en el lote (objeto anidado, __proto__) → nunca un 5xx', async () => {
    /* Siempre 4xx. */
    for (const texto of [
      `{"tipo":"ENTRADA","id_producto":5,"id_bodega":${b1},"cantidad":1,"lote":{"codigo_lote":{"$ne":null},"fecha_vencimiento":{"a":1}}}`,
      `{"tipo":"ENTRADA","id_producto":5,"id_bodega":${b1},"cantidad":1,"lote":{"__proto__":{"codigo_lote":"P"}}}`,
      `{"tipo":"ENTRADA","id_producto":5,"id_bodega":${b1},"cantidad":1,"id_lote":1e400}`,
    ]) {
      const res = await request.post('/movimientos').set(ADM).set('Idempotency-Key', nuevaClave()).set('Content-Type', 'application/json').send(texto);
      expect(res.status).toBe(422);
    }
    expect(await lotes()).toEqual([]);
  });
});

describe('idempotencia y umbral con lotes', () => {
  it('una repetición devuelve el movimiento original y NO vuelve a tocar lotes ni saldo, aunque el cuerpo cambie (D7)', async () => {
    /* Ni con otro lote ni con otra cantidad. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const a = await sembrarLote('A', '2027-01-31', 5);
    const b = await sembrarLote('B', '2027-02-28', 5);
    const primera = await post(salida(3), 'k-rep');
    expect(primera.body).toMatchObject({ id_lote: a.id_lote, saldo_resultante: 7 });
    const antes = await foto();
    for (const cuerpo of [salida(3), salida(1, { id_lote: b.id_lote }), entrada(9, { lote: { codigo_lote: 'Z' } })]) {
      const res = await post(cuerpo, 'k-rep');
      expect({ estado: res.status, cuerpo: res.body }).toEqual({ estado: 200, cuerpo: primera.body });
    }
    expect(await foto()).toEqual(antes);
  });

  it('un 404 de lote o un 409 de lote no guardan la clave: el reintento corregido con la misma clave da 201', async () => {
    /* Los errores no se cachean (D25). */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 10 });
    const a = await sembrarLote('A', '2027-01-31', 2);
    recursoNoExiste(await post(salida(1, { id_lote: 9999 }), 'k-e1'));
    expect((await post(salida(1, { id_lote: a.id_lote }), 'k-e1')).status).toBe(201);
    stockInsuficiente(await post(salida(5, { id_lote: a.id_lote }), 'k-e2'), 'id_lote', 1, 5);
    expect((await post(salida(5), 'k-e2')).status).toBe(201);
  });

  it('el umbral se sigue evaluando tras el commit de una salida FEFO (D13)', async () => {
    /* Los lotes no cambian el aviso de stock bajo. */
    await crearUmbral(db, { idProducto: 5, cantidadMinima: 5 });
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 6 });
    await sembrarLote('A', '2027-01-31', 6);
    expect((await post(salida(2))).status).toBe(201);
    expect(clients.notificaciones.notificarStockBajo).toHaveBeenCalledWith(expect.objectContaining({ cantidadTotal: 4, cantidadMinima: 5 }), expect.any(Object));
  });

  it('un operador en su bodega puede usar id_lote; en otra bodega es 403 antes de mirar el lote', async () => {
    /* El alcance de bodega (Tarea 7) no cambia. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 4 });
    const a = await sembrarLote('A', null, 4);
    const operador = headers('OPERADOR_BODEGA', { idBodega: b1 });
    expect((await post(salida(1, { id_lote: a.id_lote }), nuevaClave(), operador)).status).toBe(201);
    esError(await post(salida(1, { id_bodega: b2, id_lote: a.id_lote }), nuevaClave(), operador), 403, 'SIN_PERMISO');
  });
});

describe('concurrencia (PostgreSQL real)', () => {
  const sinCincoXX = (respuestas) => expect(respuestas.filter((res) => res.status >= 500).map((res) => res.body)).toEqual([]);

  it('10 salidas FEFO simultáneas de 3 sobre lotes 10 + 10 con saldo 20 → exactamente seis 201 y cuatro 409; lotes y saldo consistentes', async () => {
    /* El saldo serializa las salidas; los lotes siguen el orden FEFO. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 20 });
    const a = await sembrarLote('A', '2027-01-31', 10);
    const b = await sembrarLote('B', '2027-02-28', 10);
    const respuestas = await Promise.all(Array.from({ length: 10 }, () => post(salida(3))));
    sinCincoXX(respuestas);
    expect(respuestas.filter((res) => res.status === 201)).toHaveLength(6);
    expect(respuestas.filter((res) => res.status === 409).map((res) => res.body.error.codigo)).toEqual(Array(4).fill('STOCK_INSUFICIENTE'));
    expect(await saldoDe()).toBe(2);
    expect(await existencias()).toEqual({ A: 0, B: 2 });
    // En orden de aplicación, las salidas toman A hasta agotarlo (3 + 3 + 3 + 1) y después B.
    const porOrden = (await movimientos()).map((fila) => fila.id_lote);
    expect(porOrden).toEqual([a.id_lote, a.id_lote, a.id_lote, a.id_lote, b.id_lote, b.id_lote]);
  });

  it('6 entradas simultáneas con el MISMO código de lote nuevo → un solo lote con la suma, sin 5xx ni violación de unicidad', async () => {
    /* La primera crea el lote; las demás esperan en el índice único y suman. */
    const respuestas = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => post(entrada(n, { lote: { codigo_lote: 'NUEVO', fecha_vencimiento: '2027-05-05' } }))));
    sinCincoXX(respuestas);
    expect(respuestas.map((res) => res.status)).toEqual(Array(6).fill(201));
    const [unico, ...otros] = await lotes();
    expect(otros).toEqual([]);
    expect(unico).toMatchObject({ codigo_lote: 'NUEVO', cantidad_disponible: 21 });
    expect(new Set(respuestas.map((res) => res.body.id_lote))).toEqual(new Set([unico.id_lote]));
    expect(await saldoDe()).toBe(21);
  });

  it('mezcla concurrente de entradas (sin lote, a un lote por id, por código) y salidas FEFO sobre el mismo par → todo 201, saldo exacto, invariante y kardex encadenado', async () => {
    /* Ningún interbloqueo: todas toman el saldo primero. */
    await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: 30 });
    const a = await sembrarLote('A', '2027-01-31', 10);
    await sembrarLote('B', '2027-02-28', 10);
    const pedidos = [
      ...Array.from({ length: 6 }, () => salida(4)),
      ...Array.from({ length: 4 }, () => entrada(2, { id_lote: a.id_lote })),
      ...Array.from({ length: 3 }, () => entrada(1)),
      ...Array.from({ length: 2 }, () => entrada(3, { lote: { codigo_lote: 'C', fecha_vencimiento: '2026-12-01' } })),
      mov('AJUSTE', -2), mov('DEVOLUCION_PROVEEDOR', 1),
    ];
    const respuestas = await Promise.all(pedidos.map((cuerpo) => post(cuerpo)));
    sinCincoXX(respuestas);
    expect(respuestas.map((res) => res.status)).toEqual(Array(pedidos.length).fill(201));
    const esperado = 30 - 24 + 8 + 3 + 6 - 2 - 1;
    expect(await saldoDe()).toBe(esperado);
    let saldo = 30;
    for (const fila of await db('movimientos').orderBy([{ column: 'fecha' }, { column: 'id_movimiento' }])) {
      saldo += ['SALIDA', 'DEVOLUCION_PROVEEDOR'].includes(fila.tipo) ? -fila.cantidad : fila.cantidad;
      expect(fila.saldo_resultante).toBe(saldo);
    }
    expect(saldo).toBe(esperado);
  });
});
