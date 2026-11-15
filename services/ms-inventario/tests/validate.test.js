const { AppError } = require('../src/errors');
const { booleanoQuery, entero, enteroQuery, enumerado, fecha } = require('../src/http/validate');

// Ejecuta la validación y devuelve el error que lanza; falla si no lanza ninguno.
const capturar = (funcion) => {
  try {
    funcion();
  } catch (error) {
    return error;
  }
  throw new Error('Se esperaba un error y no se lanzó ninguno');
};

// Todo validador lanza e.datosNoValidos([{ campo, mensaje }]) con el nombre del campo que recibió.
const datosNoValidos = (funcion, campo = 'cantidad') => {
  const error = capturar(funcion);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status: 422, codigo: 'DATOS_NO_VALIDOS' });
  expect(error.detalles).toEqual([{ campo, mensaje: expect.stringMatching(/\S/) }]);
};

describe('entero (valores de un cuerpo JSON)', () => {
  it.each([[1, 1], [5, 5], [2147483647, 2147483647]])('entero(%p) → %p', (valor, esperado) => {
    expect(entero(valor, 'cantidad')).toBe(esperado);
  });

  it.each([
    ['cero', 0],
    ['negativo', -3],
    ['decimal', 1.5],
    ['texto con un número', '5'],
    ['texto', 'abc'],
    ['cadena vacía', ''],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['undefined (campo ausente)', undefined],
    ['booleano', true],
    ['arreglo', [5]],
    ['objeto', { valor: 5 }],
    ['entero no seguro', 9007199254740993],
    ['más que el INTEGER de PostgreSQL', 2147483648],
  ])('rechaza %s con 422 DATOS_NO_VALIDOS y el nombre del campo', (_descripcion, valor) => {
    datosNoValidos(() => entero(valor, 'cantidad'));
  });

  it('el nombre del campo del error es el que se pasa', () => {
    datosNoValidos(() => entero(0, 'id_producto'), 'id_producto');
  });

  it('sin tercer argumento no lanza TypeError (opciones por defecto { min: 1 })', () => {
    expect(() => entero(1, 'x')).not.toThrow();
    expect(capturar(() => entero(0, 'x'))).toBeInstanceOf(AppError);
  });

  it('min cambia el mínimo aceptado (por ejemplo 0, o un negativo para un AJUSTE)', () => {
    expect(entero(0, 'x', { min: 0 })).toBe(0);
    expect(entero(-10, 'x', { min: -10 })).toBe(-10);
    datosNoValidos(() => entero(-1, 'x', { min: 0 }), 'x');
    datosNoValidos(() => entero(-11, 'x', { min: -10 }), 'x');
  });

  it('max cambia el máximo aceptado', () => {
    expect(entero(10, 'x', { max: 10 })).toBe(10);
    datosNoValidos(() => entero(11, 'x', { max: 10 }), 'x');
  });
});

describe('enteroQuery (valores de la cadena de consulta)', () => {
  it('un parámetro ausente → undefined', () => {
    expect(enteroQuery(undefined, 'id_producto')).toBeUndefined();
  });

  it.each([['7', 7], ['1', 1], ['2147483647', 2147483647]])('enteroQuery(%p) → %p', (valor, esperado) => {
    expect(enteroQuery(valor, 'id_producto')).toBe(esperado);
  });

  it.each(['0', '-1', 'abc', '1.5', '', ' 7', '7 ', '1e3', '0x10', '+7', '12abc', '2147483648', '99999999999999999999'])('enteroQuery(%p) → 422 con el campo', (valor) => {
    datosNoValidos(() => enteroQuery(valor, 'id_producto'), 'id_producto');
  });

  it('un parámetro repetido (arreglo) o no textual → 422, no un error de tipo', () => {
    datosNoValidos(() => enteroQuery(['1', '2'], 'id_producto'), 'id_producto');
    datosNoValidos(() => enteroQuery(7, 'id_producto'), 'id_producto');
    datosNoValidos(() => enteroQuery(null, 'id_producto'), 'id_producto');
  });

  it('acepta las opciones { min } igual que entero', () => {
    expect(enteroQuery('0', 'x', { min: 0 })).toBe(0);
    datosNoValidos(() => enteroQuery('0', 'x'), 'x');
  });
});

describe('fecha', () => {
  it.each(['2026-02-28', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01', '0001-01-01', '9999-12-31'])('acepta la fecha válida %s y la devuelve igual', (valor) => {
    expect(fecha(valor, 'fecha_vencimiento')).toBe(valor);
  });

  it.each([
    '2026-02-30',
    '2025-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '0000-01-01',
    '2026-1-1',
    '26-01-01',
    '2026/01/01',
    '2026-01-01T00:00:00Z',
    '2026-01-01 ',
    ' 2026-01-01',
    '',
    'mañana',
  ])('rechaza %p con 422', (valor) => {
    datosNoValidos(() => fecha(valor, 'fecha_vencimiento'), 'fecha_vencimiento');
  });

  it.each([['número', 20260101], ['null', null], ['undefined', undefined], ['arreglo', ['2026-01-01']], ['objeto', {}], ['Date', new Date('2026-01-01')]])(
    'rechaza un valor que no es texto (%s) con 422',
    (_descripcion, valor) => {
      datosNoValidos(() => fecha(valor, 'fecha_vencimiento'), 'fecha_vencimiento');
    },
  );
});

describe('enumerado', () => {
  const TIPOS = ['ENTRADA', 'SALIDA', 'AJUSTE'];

  it('devuelve el valor cuando está en la lista', () => {
    expect(enumerado('SALIDA', 'tipo', TIPOS)).toBe('SALIDA');
  });

  it.each([['otro valor', 'DEVOLUCION'], ['otra capitalización', 'salida'], ['con espacios', ' SALIDA'], ['vacío', ''], ['propiedad heredada', 'toString'], ['número', 1], ['null', null], ['undefined', undefined], ['arreglo', ['SALIDA']]])(
    'rechaza %s con 422',
    (_descripcion, valor) => {
      datosNoValidos(() => enumerado(valor, 'tipo', TIPOS), 'tipo');
    },
  );

  it('el mensaje dice cuáles valores se aceptan', () => {
    const { detalles } = capturar(() => enumerado('X', 'tipo', TIPOS));
    for (const permitido of TIPOS) expect(detalles[0].mensaje).toContain(permitido);
  });
});

describe('booleanoQuery', () => {
  it('un parámetro ausente → undefined', () => {
    expect(booleanoQuery(undefined, 'con_existencia')).toBeUndefined();
  });

  it('"true" → true y "false" → false', () => {
    expect(booleanoQuery('true', 'con_existencia')).toBe(true);
    expect(booleanoQuery('false', 'con_existencia')).toBe(false);
  });

  it.each(['TRUE', 'True', '1', '0', 'si', 'yes', '', ' true'])('rechaza %p con 422', (valor) => {
    datosNoValidos(() => booleanoQuery(valor, 'con_existencia'), 'con_existencia');
  });

  it('un parámetro repetido, un booleano real o null → 422', () => {
    datosNoValidos(() => booleanoQuery(['true', 'false'], 'con_existencia'), 'con_existencia');
    datosNoValidos(() => booleanoQuery(true, 'con_existencia'), 'con_existencia');
    datosNoValidos(() => booleanoQuery(null, 'con_existencia'), 'con_existencia');
  });
});
