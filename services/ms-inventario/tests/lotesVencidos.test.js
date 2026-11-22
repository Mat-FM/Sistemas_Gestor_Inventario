const { buildTestApp } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearSaldo, headers } = require('./helpers/fixtures');
const { esError, stockInsuficiente } = require('./helpers/respuestas');
const reloj = require('../src/domain/hoy');

// Lotes vencidos (D36): una SALIDA nunca despacha mercancía vencida, ni por FEFO ni pidiendo el lote por id. Lo vencido se da de
// baja con un AJUSTE (o una devolución a proveedor), que sí lo consume primero. "Hoy" se fija en 2027-02-15 (día de Bogotá) para
// que los lotes sembrados con fecha de enero de 2027 estén vencidos y los de marzo no.

const HOY = '2027-02-15';
const ADM = headers('ADMINISTRADOR');

let request;
let db;
let b1;

beforeAll(() => {
  ({ request, db } = buildTestApp());
});
beforeEach(async () => {
  jest.spyOn(reloj, 'hoy').mockReturnValue(HOY);
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => db.destroy());

let contador = 0;
const post = (cuerpo) => request.post('/movimientos').set(ADM).set('Idempotency-Key', `lv-${(contador += 1)}`).send(cuerpo);
const mov = (tipo, cantidad, extra = {}) => ({ tipo, id_producto: 5, id_bodega: b1, cantidad, ...extra });
const sembrar = async ({ saldo, lotes }) => {
  await crearSaldo(db, { idProducto: 5, idBodega: b1, cantidad: saldo });
  const creados = {};
  for (const [codigo, fecha, cantidad] of lotes) creados[codigo] = await crearLote(db, { idBodega: b1, idProducto: 5, codigoLote: codigo, fechaVencimiento: fecha, cantidad });
  return creados;
};
const existencias = async () => Object.fromEntries((await db('lotes').select('codigo_lote', 'cantidad_disponible')).map((l) => [l.codigo_lote, l.cantidad_disponible]));
const saldoDe = async () => (await db('saldos').where({ id_producto: 5, id_bodega: b1 }).first()).cantidad_disponible;

const VENCIDO = ['VENCIDO', '2027-01-31', 5];
const VIGENTE = ['VIGENTE', '2027-03-31', 5];

describe('SALIDA sin lote (FEFO)', () => {
  it('no toca el lote vencido aunque venza primero: sale del vigente', async () => {
    const lotes = await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    const res = await post(mov('SALIDA', 3));

    expect(res.status).toBe(201);
    expect(res.body.id_lote).toBe(lotes.VIGENTE.id_lote);
    expect(await existencias()).toEqual({ VENCIDO: 5, VIGENTE: 2 });
    expect(await saldoDe()).toBe(7);
  });

  it('se puede sacar justo todo lo vigente y lo vencido queda en el saldo', async () => {
    await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    expect((await post(mov('SALIDA', 5))).status).toBe(201);

    expect(await existencias()).toEqual({ VENCIDO: 5, VIGENTE: 0 });
    expect(await saldoDe()).toBe(5);
  });

  it('pedir más de lo vigente es 409 aunque el saldo alcance: disponible no cuenta lo vencido y nada cambia', async () => {
    await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    const res = await post(mov('SALIDA', 6));

    stockInsuficiente(res, 'cantidad', 5, 6);
    expect(res.body.error.detalles[0].mensaje).toMatch(/vencid/i);
    expect(await existencias()).toEqual({ VENCIDO: 5, VIGENTE: 5 });
    expect(await saldoDe()).toBe(10);
  });

  it('el stock sin lote sí es vendible: 12 de saldo = 5 vencidas + 5 vigentes + 2 sin lote', async () => {
    await sembrar({ saldo: 12, lotes: [VENCIDO, VIGENTE] });

    expect((await post(mov('SALIDA', 7))).status).toBe(201);

    expect(await existencias()).toEqual({ VENCIDO: 5, VIGENTE: 0 });
    expect(await saldoDe()).toBe(5);
  });

  it('un lote que vence HOY todavía se puede vender (solo lo anterior a hoy está vencido)', async () => {
    const lotes = await sembrar({ saldo: 5, lotes: [['HOY', HOY, 5]] });

    const res = await post(mov('SALIDA', 5));

    expect(res.status).toBe(201);
    expect(res.body.id_lote).toBe(lotes.HOY.id_lote);
  });

  it('con todo vencido no se puede vender nada', async () => {
    await sembrar({ saldo: 5, lotes: [VENCIDO] });

    stockInsuficiente(await post(mov('SALIDA', 1)), 'cantidad', 0, 1);
  });
});

describe('SALIDA con id_lote', () => {
  it('un lote vencido es 409 LOTE_VENCIDO y nada cambia', async () => {
    const lotes = await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    esError(await post(mov('SALIDA', 1, { id_lote: lotes.VENCIDO.id_lote })), 409, 'LOTE_VENCIDO');

    expect(await existencias()).toEqual({ VENCIDO: 5, VIGENTE: 5 });
    expect(await saldoDe()).toBe(10);
  });

  it('un lote vigente se sigue pudiendo pedir por id', async () => {
    const lotes = await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    expect((await post(mov('SALIDA', 2, { id_lote: lotes.VIGENTE.id_lote }))).status).toBe(201);

    expect(await existencias()).toEqual({ VENCIDO: 5, VIGENTE: 3 });
  });
});

describe('dar de baja lo vencido', () => {
  it('un AJUSTE negativo sin lote consume primero lo vencido (FEFO de siempre)', async () => {
    const lotes = await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    const res = await post(mov('AJUSTE', -5, { observacion: 'Baja por vencimiento' }));

    expect(res.status).toBe(201);
    expect(res.body.id_lote).toBe(lotes.VENCIDO.id_lote);
    expect(await existencias()).toEqual({ VENCIDO: 0, VIGENTE: 5 });
  });

  it('un AJUSTE negativo con el id del lote vencido también funciona', async () => {
    const lotes = await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    expect((await post(mov('AJUSTE', -5, { id_lote: lotes.VENCIDO.id_lote }))).status).toBe(201);

    expect(await existencias()).toEqual({ VENCIDO: 0, VIGENTE: 5 });
  });

  it('una devolución a proveedor puede llevarse lo vencido', async () => {
    await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    expect((await post(mov('DEVOLUCION_PROVEEDOR', 5))).status).toBe(201);

    expect(await existencias()).toEqual({ VENCIDO: 0, VIGENTE: 5 });
  });
});

describe('GET /lotes/sugerencia-salida', () => {
  const sugerir = (query) => request.get('/lotes/sugerencia-salida').query(query).set(ADM);

  it('sugiere solo lotes vigentes', async () => {
    const lotes = await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    const res = await sugerir({ id_producto: 5, id_bodega: b1, cantidad: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id_lote: lotes.VIGENTE.id_lote, codigo_lote: 'VIGENTE', fecha_vencimiento: '2027-03-31', cantidad_sugerida: 3 }]);
  });

  it('si los vigentes no alcanzan es 409 con disponible igual a lo vigente', async () => {
    await sembrar({ saldo: 10, lotes: [VENCIDO, VIGENTE] });

    stockInsuficiente(await sugerir({ id_producto: 5, id_bodega: b1, cantidad: 8 }), 'cantidad', 5, 8);
  });
});
