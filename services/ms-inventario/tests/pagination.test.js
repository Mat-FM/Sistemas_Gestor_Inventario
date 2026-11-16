const { AppError } = require('../src/errors');
const { envelope, parsePagination } = require('../src/http/pagination');
const { miniApp } = require('./helpers/miniapp');

const capturar = (funcion) => {
  try {
    funcion();
  } catch (error) {
    return error;
  }
  throw new Error('Se esperaba un error y no se lanzó ninguno');
};

const datosNoValidos = (error, campos) => {
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status: 422, codigo: 'DATOS_NO_VALIDOS' });
  expect(error.detalles.map((detalle) => detalle.campo)).toEqual(campos);
  for (const detalle of error.detalles) expect(detalle.mensaje.trim()).not.toBe('');
};

describe('parsePagination', () => {
  it('sin parámetros → { pagina: 1, porPagina: 20, offset: 0 }', () => {
    expect(parsePagination({})).toEqual({ pagina: 1, porPagina: 20, offset: 0 });
  });

  it.each([
    [{ pagina: '1', por_pagina: '1' }, { pagina: 1, porPagina: 1, offset: 0 }],
    [{ pagina: '3', por_pagina: '50' }, { pagina: 3, porPagina: 50, offset: 100 }],
    [{ por_pagina: '100' }, { pagina: 1, porPagina: 100, offset: 0 }],
    [{ pagina: '2' }, { pagina: 2, porPagina: 20, offset: 20 }],
    [{ pagina: '007', por_pagina: '010' }, { pagina: 7, porPagina: 10, offset: 60 }],
  ])('parsePagination(%j) → %j', (query, esperado) => {
    expect(parsePagination(query)).toEqual(esperado);
  });

  it.each([['0'], ['101'], ['abc'], ['-1'], ['1.5'], [''], ['1e1'], [' 5'], ['5 ']])('por_pagina=%p → 422 con detalles[0].campo === "por_pagina"', (valor) => {
    const error = capturar(() => parsePagination({ por_pagina: valor }));
    datosNoValidos(error, ['por_pagina']);
    expect(error.detalles[0].campo).toBe('por_pagina');
  });

  it.each([['0'], ['-1'], ['abc'], ['1.5'], [''], ['99999999999999999999']])('pagina=%p → 422 con detalles[0].campo === "pagina"', (valor) => {
    const error = capturar(() => parsePagination({ pagina: valor }));
    datosNoValidos(error, ['pagina']);
  });

  it('con pagina y por_pagina inválidas informa las dos, en ese orden', () => {
    datosNoValidos(capturar(() => parsePagination({ pagina: '0', por_pagina: '500' })), ['pagina', 'por_pagina']);
  });

  it('un parámetro repetido (?por_pagina=1&por_pagina=2 llega como arreglo) → 422, no un error de tipo', () => {
    datosNoValidos(capturar(() => parsePagination({ por_pagina: ['1', '2'] })), ['por_pagina']);
    datosNoValidos(capturar(() => parsePagination({ pagina: ['1', '2'] })), ['pagina']);
  });

  it('una página por encima del techo entero (2147483647) → 422 en pagina; en el techo el desplazamiento sigue exacto', () => {
    datosNoValidos(capturar(() => parsePagination({ pagina: '2147483648', por_pagina: '100' })), ['pagina']);
    datosNoValidos(capturar(() => parsePagination({ pagina: '9007199254740991', por_pagina: '100' })), ['pagina']);
    expect(parsePagination({ pagina: '2147483647', por_pagina: '100' }).offset).toBe(214748364600);
  });

  it('el 422 llega al cliente con el envoltorio común y los detalles', async () => {
    const { request } = miniApp((app) => app.get('/lista', (req, res) => res.json(parsePagination(req.query))), { conIdentidad: false, logger: { info() {}, error() {} } });
    const res = await request.get('/lista?por_pagina=101');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ codigo: 'DATOS_NO_VALIDOS', detalles: [{ campo: 'por_pagina', mensaje: expect.any(String) }] });
    const ok = await request.get('/lista?pagina=2&por_pagina=5');
    expect(ok.body).toEqual({ pagina: 2, porPagina: 5, offset: 5 });
  });
});

describe('envelope', () => {
  it('devuelve { datos, meta: { pagina, por_pagina, total } } con los nombres del contrato', () => {
    expect(envelope([{ id: 1 }], { pagina: 2, porPagina: 20, total: 21 })).toEqual({
      datos: [{ id: 1 }],
      meta: { pagina: 2, por_pagina: 20, total: 21 },
    });
  });

  it('una página vacía conserva meta.total (ms-reportes lo necesita exacto para dejar de paginar)', () => {
    expect(envelope([], { pagina: 1, porPagina: 100, total: 0 })).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 100, total: 0 } });
  });
});
