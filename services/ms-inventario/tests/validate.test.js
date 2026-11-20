const { AppError } = require('../src/errors');
const {
  booleanoQuery, cuerpoObjeto, entero, enteroQuery, enumerado, esFechaValida, fecha, fechaQuery, idRuta, recoger, texto, validarCampos,
} = require('../src/http/validate');

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
    // Más allá de Number.MAX_SAFE_INTEGER: el literal pierde precisión a propósito, justo lo que la validación debe rechazar.
    // eslint-disable-next-line no-loss-of-precision
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

describe('esFechaValida (la regla que comparten fecha() y el motor de lotes)', () => {
  it('es un predicado: true para una fecha real YYYY-MM-DD y false para todo lo demás, sin lanzar', () => {
    /* fecha() la usa para su 422 y stockService para su TypeError: una sola regla de calendario. */
    for (const valor of ['2027-02-28', '2028-02-29', '0001-01-01']) expect(esFechaValida(valor)).toBe(true);
    for (const valor of ['2027-02-30', '2027-13-01', '0000-01-01', '2027-2-3', new Date('2027-01-31'), null, undefined, 20270131]) {
      expect(esFechaValida(valor)).toBe(false);
    }
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

describe('fechaQuery (una fecha de la cadena de consulta)', () => {
  it('un parámetro ausente → undefined; presente y válido → el mismo texto', () => {
    expect(fechaQuery(undefined, 'vence_antes_de')).toBeUndefined();
    expect(fechaQuery('2027-01-31', 'vence_antes_de')).toBe('2027-01-31');
  });

  it.each(['', '2027-02-30', '2027-1-31', '2027-01-31T00:00:00Z', ' 2027-01-31'])('rechaza %p con 422 sobre el campo', (valor) => {
    datosNoValidos(() => fechaQuery(valor, 'vence_antes_de'), 'vence_antes_de');
  });

  it('un parámetro repetido (arreglo) o null → 422, nunca se ignora en silencio', () => {
    datosNoValidos(() => fechaQuery(['2027-01-31', '2027-02-01'], 'vence_antes_de'), 'vence_antes_de');
    datosNoValidos(() => fechaQuery(null, 'vence_antes_de'), 'vence_antes_de');
  });
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

describe('texto (cadenas con el largo de su columna, Ruling 16)', () => {
  it.each([
    ['un texto simple', 'Principal', 'Principal'],
    ['con espacios interiores (se conservan)', 'Cra  1 # 2', 'Cra  1 # 2'],
    ['con tildes y eñes (un carácter cada una)', 'Pereira ñandú', 'Pereira ñandú'],
  ])('acepta %s y lo devuelve', (_descripcion, valor, esperado) => {
    expect(texto(valor, 'nombre', { max: 100 })).toBe(esperado);
  });

  it('recorta los espacios de los extremos (también los no separables) y devuelve el texto recortado', () => {
    expect(texto('  MZL  ', 'codigo', { max: 30 })).toBe('MZL');
    expect(texto('\t\nMZL\n', 'codigo', { max: 30 })).toBe('MZL');
    expect(texto(' MZL ', 'codigo', { max: 30 })).toBe('MZL');
  });

  it('el largo se mide sobre el texto recortado, que es el que se guarda', () => {
    expect(texto(`  ${'x'.repeat(30)}  `, 'codigo', { max: 30 })).toBe('x'.repeat(30));
    datosNoValidos(() => texto(` ${'x'.repeat(31)} `, 'codigo', { max: 30 }), 'codigo');
  });

  it('acepta el largo exacto de la columna y rechaza uno más', () => {
    expect(texto('x'.repeat(30), 'codigo', { max: 30 })).toBe('x'.repeat(30));
    datosNoValidos(() => texto('x'.repeat(31), 'codigo', { max: 30 }), 'codigo');
  });

  it('cuenta caracteres, no unidades UTF-16: PostgreSQL cuenta caracteres en un varchar(n)', () => {
    // Cada emoji ocupa 2 unidades UTF-16 pero es 1 carácter: 30 caben en un varchar(30), 31 no.
    expect(texto('😀'.repeat(30), 'codigo', { max: 30 })).toBe('😀'.repeat(30));
    datosNoValidos(() => texto('😀'.repeat(31), 'codigo', { max: 30 }), 'codigo');
  });

  it('el mensaje del largo dice cuál es el máximo', () => {
    const { detalles } = capturar(() => texto('x'.repeat(31), 'codigo', { max: 30 }));
    expect(detalles[0].mensaje).toContain('30');
  });

  it.each([
    ['número', 123],
    ['cero', 0],
    ['booleano', true],
    ['null', null],
    ['arreglo', ['a']],
    ['arreglo vacío', []],
    ['objeto', { a: 1 }],
    ['NaN', NaN],
    ['Date', new Date('2026-01-01')],
  ])('rechaza un valor que no es texto (%s) con 422', (_descripcion, valor) => {
    datosNoValidos(() => texto(valor, 'nombre', { max: 100 }), 'nombre');
  });

  it('un campo ausente (undefined) es 422 "es obligatorio"', () => {
    const { detalles } = capturar(() => texto(undefined, 'nombre', { max: 100 }));
    expect(detalles).toEqual([{ campo: 'nombre', mensaje: 'es obligatorio' }]);
  });

  it.each([['vacío', ''], ['solo espacios', '   '], ['solo saltos y tabuladores', '\t\n '], ['solo espacios no separables', '  ']])(
    'con min = 1 (por defecto) rechaza un texto %s',
    (_descripcion, valor) => {
      datosNoValidos(() => texto(valor, 'nombre', { max: 100 }), 'nombre');
    },
  );

  it('rechaza el carácter nulo: PostgreSQL no lo admite en un texto y daría un 500', () => {
    datosNoValidos(() => texto('a\u0000b', 'nombre', { max: 100 }), 'nombre');
    datosNoValidos(() => texto('\u0000', 'nombre', { max: 100 }), 'nombre');
  });

  it.each([['un sustituto alto suelto', 'a\ud800b'], ['un sustituto bajo suelto', '\udc00'], ['un par en orden inverso', '\udc00\ud800'], ['uno al final', 'x\ud83d']])(
    'rechaza el texto mal formado (%s): Node lo cambiaría en silencio por U+FFFD al enviarlo a la base',
    (_descripcion, valor) => {
      datosNoValidos(() => texto(valor, 'nombre', { max: 100 }), 'nombre');
    },
  );

  it('un par sustituto completo (un emoji) sí es un texto válido', () => {
    expect(texto('a\ud83d\ude00b', 'nombre', { max: 3 })).toBe('a😀b');
  });

  it('min exige un largo mínimo (sobre el texto recortado) y min = 0 admite el vacío', () => {
    expect(texto('abc', 'x', { max: 10, min: 3 })).toBe('abc');
    datosNoValidos(() => texto('ab', 'x', { max: 10, min: 3 }), 'x');
    datosNoValidos(() => texto(' ab ', 'x', { max: 10, min: 3 }), 'x');
    expect(texto('', 'x', { max: 10, min: 0 })).toBe('');
    expect(texto('   ', 'x', { max: 10, min: 0 })).toBe('');
  });

  it('opcional solo exime a la AUSENCIA del campo: undefined → undefined; null, vacío y no cadenas siguen siendo 422', () => {
    expect(texto(undefined, 'observacion', { max: 500, opcional: true })).toBeUndefined();
    expect(texto('nota', 'observacion', { max: 500, opcional: true })).toBe('nota');
    datosNoValidos(() => texto(null, 'observacion', { max: 500, opcional: true }), 'observacion');
    datosNoValidos(() => texto('', 'observacion', { max: 500, opcional: true }), 'observacion');
    datosNoValidos(() => texto(5, 'observacion', { max: 500, opcional: true }), 'observacion');
    datosNoValidos(() => texto('x'.repeat(501), 'observacion', { max: 500, opcional: true }), 'observacion');
  });

  it.each([[undefined], [0], [-1], [1.5], ['30'], [Infinity], [NaN], [null]])(
    'un `max` inválido (%p) es un error de programación (TypeError), no un 422 ni un límite silencioso',
    (max) => {
      const error = capturar(() => texto('x', 'codigo', { max }));
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(AppError);
    },
  );

  it('sin las opciones también es un TypeError', () => {
    expect(capturar(() => texto('x', 'codigo'))).toBeInstanceOf(TypeError);
  });
});

describe('cuerpoObjeto (el cuerpo JSON de una petición)', () => {
  it('sin cuerpo (Express 5 deja req.body en undefined) → {} para informar todos los campos obligatorios', () => {
    expect(cuerpoObjeto(undefined)).toEqual({});
  });

  it('un objeto se devuelve tal cual', () => {
    const cuerpo = { nombre: 'x', anidado: { a: 1 } };
    expect(cuerpoObjeto(cuerpo)).toBe(cuerpo);
    expect(cuerpoObjeto({})).toEqual({});
  });

  it.each([['arreglo', []], ['arreglo con elementos', [{ nombre: 'x' }]], ['texto', 'x'], ['número', 5], ['booleano', true], ['null', null]])(
    'rechaza %s con 422 sobre el campo "cuerpo"',
    (_descripcion, valor) => {
      datosNoValidos(() => cuerpoObjeto(valor), 'cuerpo');
    },
  );
});

describe('idRuta (el {id} de una ruta, que llega como texto)', () => {
  it.each([['1', 1], ['25', 25], ['2147483647', 2147483647]])('idRuta(%p) → %p', (valor, esperado) => {
    expect(idRuta(valor)).toBe(esperado);
  });

  it.each(['0', '-1', 'abc', '1.5', '', '07', ' 1', '1 ', '1e3', '+1', '0x1', '2147483648', '99999999999', '99999999999999999999'])(
    'idRuta(%p) → 404 NO_EXISTE (ningún recurso vive en esa dirección; nunca llega a la base)',
    (valor) => {
      const error = capturar(() => idRuta(valor));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
    },
  );

  it('un valor que no es texto también es 404, no un error de tipo', () => {
    for (const valor of [7, undefined, null, ['1'], {}]) {
      expect(capturar(() => idRuta(valor))).toMatchObject({ status: 404, codigo: 'NO_EXISTE' });
    }
  });
});

describe('recoger y validarCampos (informar todos los campos inválidos a la vez)', () => {
  it('recoger anota los detalles de un 422 y devuelve undefined en vez de lanzar', () => {
    const detalles = [];
    expect(recoger(detalles, () => entero(0, 'a'))).toBeUndefined();
    expect(detalles).toEqual([{ campo: 'a', mensaje: expect.any(String) }]);
    expect(recoger(detalles, () => entero(3, 'b'))).toBe(3);
    expect(detalles).toHaveLength(1);
  });

  it('recoger no traga un error que no es un 422 (un fallo de programación debe verse)', () => {
    const detalles = [];
    expect(() => recoger(detalles, () => { throw new TypeError('fallo'); })).toThrow(TypeError);
    expect(() => recoger(detalles, () => { throw new AppError(404, 'NO_EXISTE', 'x'); })).toThrow(AppError);
    expect(detalles).toEqual([]);
  });

  it('validarCampos devuelve { campo: valor } cuando todo es válido (incluidos los opcionales ausentes)', () => {
    const valores = validarCampos({
      nombre: () => texto('  Principal ', 'nombre', { max: 100 }),
      nota: () => texto(undefined, 'nota', { max: 10, opcional: true }),
    });
    expect(valores).toEqual({ nombre: 'Principal', nota: undefined });
  });

  it('validarCampos lanza UN solo 422 con un detalle por campo inválido, en el orden dado', () => {
    const error = capturar(() => validarCampos({
      codigo: () => texto('ok', 'codigo', { max: 30 }),
      nombre: () => texto('', 'nombre', { max: 100 }),
      ciudad: () => texto(5, 'ciudad', { max: 100 }),
      direccion: () => texto(undefined, 'direccion', { max: 255 }),
    }));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 422, codigo: 'DATOS_NO_VALIDOS' });
    expect(error.detalles.map((d) => d.campo)).toEqual(['nombre', 'ciudad', 'direccion']);
  });

  it('validarCampos acepta validaciones que lanzan varios detalles (p. ej. parsePagination)', () => {
    const error = capturar(() => validarCampos({
      a: () => entero(0, 'a'),
      paginas: () => { throw new AppError(422, 'DATOS_NO_VALIDOS', 'x', [{ campo: 'pagina', mensaje: 'm' }, { campo: 'por_pagina', mensaje: 'm' }]); },
    }));
    expect(error.detalles.map((d) => d.campo)).toEqual(['a', 'pagina', 'por_pagina']);
  });

  it('validarCampos no traga errores que no son 422', () => {
    expect(() => validarCampos({ a: () => { throw new TypeError('fallo'); } })).toThrow(TypeError);
  });
});
