const { resolverRef, revisarEsquema, validar } = require('./helpers/esquemaOpenapi');

// El validador mínimo de esquemas OpenAPI (tests/helpers/esquemaOpenapi.js): las pruebas de conformidad de docs.test.js confían en
// él para decir que una respuesta real cumple lo que promete openapi.yaml, así que cada palabra clave que soporta tiene aquí
// casos que pasan y casos que fallan (un validador que acepta todo haría pasar cualquier documento).

const DOC = { components: { schemas: {} } };

// Resultado de validar: la lista de incumplimientos.
const errores = (esquema, valor, documento = DOC) => validar(documento, esquema, valor);
const cumple = (esquema, valor, documento = DOC) => expect(errores(esquema, valor, documento)).toEqual([]);
const incumple = (esquema, valor, fragmento, documento = DOC) => {
  const lista = errores(esquema, valor, documento);
  expect(lista.length).toBeGreaterThan(0);
  if (fragmento !== undefined) expect(lista.join('\n')).toContain(fragmento);
};

describe('type', () => {
  it.each([
    ['string', 'hola', 5],
    ['integer', 3, 3.5],
    ['integer', -7, '7'],
    ['number', 3.5, '3.5'],
    ['number', 0, '0'],
    ['boolean', false, 'false'],
    ['object', {}, []],
    ['object', { a: 1 }, 'x'],
    ['array', [], {}],
    ['array', [1, 2], 'x'],
  ])('%s: acepta %j y rechaza %j', (type, bueno, malo) => {
    const esquema = type === 'array' ? { type, items: {} } : { type };
    cumple(esquema, bueno);
    incumple(esquema, malo, `debe ser ${type}`);
  });

  it('integer rechaza 2.5 y acepta 1.0, que en JSON es el mismo número que 1', () => {
    incumple({ type: 'integer' }, 2.5);
    cumple({ type: 'integer' }, 1.0);
  });

  it('sin type admite cualquier valor que no sea null', () => {
    for (const valor of ['a', 1, true, {}, [1]]) cumple({}, valor);
    incumple({}, null, 'no puede ser null');
  });

  it('un valor ausente (undefined) no cumple ningún esquema', () => {
    incumple({ type: 'string' }, undefined, 'falta el valor');
  });
});

describe('nullable', () => {
  it('null solo se acepta con nullable: true', () => {
    cumple({ type: 'integer', nullable: true }, null);
    incumple({ type: 'integer' }, null, 'no puede ser null');
    incumple({ type: 'integer', nullable: false }, null, 'no puede ser null');
  });

  it('con nullable: true un valor que no es null se sigue validando contra el tipo', () => {
    cumple({ type: 'integer', nullable: true }, 5);
    incumple({ type: 'integer', nullable: true }, '5', 'debe ser integer');
  });

  it('una propiedad null se acepta solo si su esquema es nullable (y no basta con que no sea obligatoria)', () => {
    const esquema = { type: 'object', properties: { a: { type: 'string', nullable: true }, b: { type: 'string' } } };
    cumple(esquema, { a: null });
    incumple(esquema, { b: null }, '$.b: no puede ser null');
  });
});

describe('enum', () => {
  it('acepta solo los valores listados, distinguiendo mayúsculas', () => {
    const esquema = { type: 'string', enum: ['ENTRADA', 'SALIDA'] };
    cumple(esquema, 'ENTRADA');
    incumple(esquema, 'entrada', 'no está entre los valores permitidos');
    incumple(esquema, 'AJUSTE', 'ENTRADA');
  });

  it('funciona con números y no confunde 1 con "1"', () => {
    const esquema = { type: 'integer', enum: [1, 2] };
    cumple(esquema, 2);
    incumple(esquema, 3);
    incumple({ enum: [1, 2] }, '1');
  });
});

describe('format', () => {
  it('date: una fecha YYYY-MM-DD que existe en el calendario', () => {
    const esquema = { type: 'string', format: 'date' };
    for (const valor of ['2027-03-01', '2028-02-29', '2026-12-31']) cumple(esquema, valor);
    for (const valor of ['2027-02-30', '2027-02-29', '2027-13-01', '2027-3-1', '27-03-01', '2027-03-01T00:00:00Z', '', 'mañana']) incumple(esquema, valor, 'fecha YYYY-MM-DD');
  });

  it('date: los años 0001 a 0099 son años reales (el servicio los acepta) y no se confunden con 19xx; el año 0000 no existe', () => {
    const esquema = { type: 'string', format: 'date' };
    for (const valor of ['0001-01-01', '0050-01-01', '0099-12-31', '0004-02-29', '1900-01-01']) cumple(esquema, valor);
    // El año 50 no es bisiesto, el 100 tampoco (es múltiplo de 100 y no de 400) y el 96 sí.
    for (const valor of ['0000-01-01', '0050-02-29', '0100-02-29', '0050-13-01']) incumple(esquema, valor, 'fecha YYYY-MM-DD');
    cumple(esquema, '0096-02-29');
  });

  it('date-time: en este documento es Date#toISOString(): UTC con la Z y exactamente tres decimales', () => {
    const esquema = { type: 'string', format: 'date-time' };
    for (const valor of ['2026-11-15T10:00:00.000Z', '2026-11-10T14:32:05.123Z', '2028-02-29T23:59:59.999Z']) cumple(esquema, valor);
    for (const valor of [
      '2026-11-15T10:00:00Z', // sin milisegundos
      '2026-11-10T09:32:05.000-05:00', // huso distinto de Z
      '2026-11-10T14:32:05.000+00:00', // UTC escrito como +00:00
      '2026-11-10T14:32:05-00:00',
      '2026-11-15T10:00:00.12Z', // dos decimales
      '2026-11-15T10:00:00.123456Z', // seis decimales
      '2026-11-15T10:00:00.000z', // z minúscula
    ]) incumple(esquema, valor, 'toISOString');
    for (const valor of ['2026-11-15', '2026-11-15T10:00:00.000', '2026-11-15 10:00:00.000Z', '2026-13-15T10:00:00.000Z', '2026-02-30T10:00:00.000Z', '2026-11-15T25:00:00.000Z', 'ayer']) incumple(esquema, valor, 'toISOString');
  });

  it('int32: dentro de [-2147483648, 2147483647]', () => {
    const esquema = { type: 'integer', format: 'int32' };
    for (const valor of [0, 2147483647, -2147483648]) cumple(esquema, valor);
    for (const valor of [2147483648, -2147483649]) incumple(esquema, valor, 'int32');
  });

  it('int64: un entero seguro de JavaScript', () => {
    cumple({ type: 'integer', format: 'int64' }, 9007199254740991);
    incumple({ type: 'integer', format: 'int64' }, 9007199254740992, 'entero seguro');
  });

  it('un formato que no soporta (o que no corresponde al tipo) es un error del esquema, no un valor inválido', () => {
    expect(() => errores({ type: 'string', format: 'email' }, 'a@b.c')).toThrow(/formato "email" no está soportado/);
    expect(() => errores({ type: 'integer', format: 'date' }, 1)).toThrow(/formato "date" no está soportado/);
    expect(() => errores({ format: 'date' }, '2027-01-01')).toThrow(/no está soportado/);
  });
});

describe('minimum y maximum', () => {
  it('son inclusivos', () => {
    const esquema = { type: 'integer', minimum: 1, maximum: 100 };
    cumple(esquema, 1);
    cumple(esquema, 100);
    incumple(esquema, 0, 'menor que el mínimo 1');
    incumple(esquema, 101, 'mayor que el máximo 100');
  });

  it('se pueden usar por separado y con decimales', () => {
    cumple({ type: 'number', minimum: 0.5 }, 0.5);
    incumple({ type: 'number', minimum: 0.5 }, 0.4);
    cumple({ type: 'integer', maximum: 3 }, -100);
    incumple({ type: 'integer', maximum: 3 }, 4);
  });
});

describe('minLength y maxLength', () => {
  it('miden caracteres (puntos de código), no unidades UTF-16', () => {
    const esquema = { type: 'string', minLength: 1, maxLength: 3 };
    cumple(esquema, 'abc');
    cumple(esquema, '😀😀😀'); // 3 caracteres, 6 unidades UTF-16
    incumple(esquema, '', 'mínimo es 1');
    incumple(esquema, 'abcd', 'máximo es 3');
    incumple(esquema, '😀😀😀😀', 'máximo es 3');
  });
});

describe('properties y required', () => {
  const esquema = {
    type: 'object',
    required: ['id', 'nombre'],
    properties: { id: { type: 'integer' }, nombre: { type: 'string' }, nota: { type: 'string' } },
  };

  it('acepta un objeto completo y uno al que solo le falta una propiedad opcional', () => {
    cumple(esquema, { id: 1, nombre: 'x', nota: 'y' });
    cumple(esquema, { id: 1, nombre: 'x' });
  });

  it('rechaza el required ausente y nombra la propiedad', () => {
    incumple(esquema, { nombre: 'x' }, 'falta la propiedad obligatoria "id"');
    incumple(esquema, {}, 'falta la propiedad obligatoria "nombre"');
  });

  it('una propiedad obligatoria con valor null falta de verdad si el esquema no es nullable', () => {
    incumple(esquema, { id: null, nombre: 'x' }, '$.id: no puede ser null');
  });

  it('valida cada propiedad presente con su esquema y dice en qué ruta falla', () => {
    incumple(esquema, { id: '1', nombre: 'x' }, '$.id: debe ser integer');
    incumple(esquema, { id: 1, nombre: 'x', nota: 7 }, '$.nota: debe ser string');
  });

  it('anida: la ruta del error recorre objetos y arreglos', () => {
    const anidado = { type: 'object', properties: { datos: { type: 'array', items: esquema } } };
    incumple(anidado, { datos: [{ id: 1, nombre: 'x' }, { id: 2 }] }, '$.datos[1]: falta la propiedad obligatoria "nombre"');
  });

  it('informa TODOS los incumplimientos, no solo el primero', () => {
    const lista = errores(esquema, { id: 'a', nota: 3 });
    expect(lista).toHaveLength(3);
  });
});

describe('additionalProperties', () => {
  const base = { type: 'object', properties: { a: { type: 'integer' } } };

  it('false rechaza el campo de más y lo nombra', () => {
    const estricto = { ...base, additionalProperties: false };
    cumple(estricto, { a: 1 });
    cumple(estricto, {});
    incumple(estricto, { a: 1, b: 2 }, 'la propiedad "b" no está declarada');
  });

  it('ausente o true admiten propiedades de más', () => {
    cumple(base, { a: 1, b: 'cualquiera' });
    cumple({ ...base, additionalProperties: true }, { a: 1, b: 'cualquiera' });
  });

  it('con un esquema valida cada propiedad de más contra él', () => {
    const mapa = { type: 'object', additionalProperties: { type: 'integer' } };
    cumple(mapa, { x: 1, y: 2 });
    incumple(mapa, { x: 1, y: 'dos' }, '$.y: debe ser integer');
  });

  it('actúa a todos los niveles, también dentro de los elementos de un arreglo', () => {
    const esquema = { type: 'array', items: { ...base, additionalProperties: false } };
    cumple(esquema, [{ a: 1 }]);
    incumple(esquema, [{ a: 1 }, { a: 1, extra: true }], '$[1]: la propiedad "extra"');
  });
});

describe('items, minItems, maxItems y uniqueItems', () => {
  it('items valida cada elemento y dice la posición del que falla', () => {
    const esquema = { type: 'array', items: { type: 'integer' } };
    cumple(esquema, [1, 2, 3]);
    cumple(esquema, []);
    incumple(esquema, [1, 'dos', 3], '$[1]: debe ser integer');
  });

  it('minItems y maxItems son inclusivos', () => {
    const esquema = { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 3 };
    cumple(esquema, [1]);
    cumple(esquema, [1, 2, 3]);
    incumple(esquema, [], 'mínimo es 1');
    incumple(esquema, [1, 2, 3, 4], 'máximo es 3');
  });

  it('uniqueItems rechaza el elemento repetido (también objetos iguales)', () => {
    const esquema = { type: 'array', items: {}, uniqueItems: true };
    cumple(esquema, [1, 2, '1']);
    incumple(esquema, [1, 2, 1], '$[2]: elemento repetido');
    incumple(esquema, [{ a: 1 }, { a: 1 }], 'elemento repetido');
  });
});

describe('$ref', () => {
  const documento = {
    components: {
      schemas: {
        Id: { type: 'integer', minimum: 1 },
        Par: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { $ref: '#/components/schemas/Id' } } },
        Alias: { $ref: '#/components/schemas/Par' },
      },
    },
  };

  it('resuelve la referencia, también encadenada y dentro de propiedades', () => {
    cumple({ $ref: '#/components/schemas/Par' }, { id: 5 }, documento);
    cumple({ $ref: '#/components/schemas/Alias' }, { id: 5 }, documento);
    incumple({ $ref: '#/components/schemas/Alias' }, { id: 0 }, '$.id: 0 es menor que el mínimo 1', documento);
    incumple({ $ref: '#/components/schemas/Par' }, { id: 5, extra: 1 }, 'no está declarada', documento);
  });

  it('una referencia que no resuelve es un error del documento (lanza), no un valor inválido', () => {
    expect(() => errores({ $ref: '#/components/schemas/NoExiste' }, 1, documento)).toThrow(/no resuelve/);
    expect(() => errores({ $ref: 'otro.yaml#/x' }, 1, documento)).toThrow(/no es local/);
  });

  it('en OpenAPI 3.0 los hermanos de $ref se ignoran: el validador los trata como error del esquema', () => {
    expect(() => errores({ $ref: '#/components/schemas/Id', nullable: true }, null, documento)).toThrow(/hermanos de \$ref/);
  });

  it('resolverRef devuelve el nodo apuntado y entiende las barras escapadas', () => {
    expect(resolverRef({ a: { 'b/c': { d: 1 } } }, '#/a/b~1c/d')).toBe(1);
    expect(() => resolverRef({ a: {} }, '#/a/b')).toThrow(/no resuelve/);
  });
});

describe('palabras clave que no soporta', () => {
  it.each([
    ['oneOf', { oneOf: [{ type: 'string' }] }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['anyOf', { anyOf: [{ type: 'string' }] }],
    ['not', { not: { type: 'string' } }],
    ['pattern', { type: 'string', pattern: '^a' }],
    ['exclusiveMinimum', { type: 'integer', exclusiveMinimum: true }],
    ['multipleOf', { type: 'integer', multipleOf: 2 }],
    ['minProperties', { type: 'object', minProperties: 1 }],
  ])('%s lanza en vez de ignorarse en silencio', (palabra, esquema) => {
    expect(() => errores(esquema, 'a')).toThrow(new RegExp(`"${palabra}" no está soportada`));
  });

  it('las anotaciones y las extensiones x-* se ignoran', () => {
    const esquema = {
      type: 'integer', description: 'd', example: 1, title: 't', default: 0, readOnly: true, deprecated: false, 'x-algo': { raro: true },
    };
    cumple(esquema, 5);
    incumple(esquema, 'cinco');
  });

  it('un type desconocido o un required que nombra una propiedad inexistente también son errores del esquema', () => {
    expect(() => errores({ type: 'file' }, 1)).toThrow(/type "file" no es válido/);
    expect(() => errores({ type: 'object', required: ['x'], properties: { y: { type: 'string' } } }, { x: 1 })).toThrow(/required nombra "x"/);
  });
});

describe('revisarEsquema (revisión estructural, sin valores)', () => {
  it('un esquema correcto, con todo lo que soporta, no tiene problemas', () => {
    const esquema = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: {
        a: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer', format: 'int32', minimum: 0, maximum: 5 } },
        b: { type: 'string', nullable: true, enum: ['x', null] },
        c: { type: 'object', additionalProperties: { type: 'string', format: 'date' } },
      },
    };
    expect(revisarEsquema(DOC, esquema)).toEqual([]);
  });

  it('lista todos los problemas y dice dónde están, también en propiedades, items y additionalProperties', () => {
    const esquema = {
      type: 'object',
      required: ['falta'],
      properties: {
        a: { type: 'string', pattern: 'x' },
        b: { type: 'array', items: { oneOf: [] } },
        c: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Roto' } },
        d: { $ref: '#/components/schemas/Roto', nullable: true },
        e: { type: 'array' },
      },
    };
    const lista = revisarEsquema(DOC, esquema);
    const texto = lista.join('\n');
    expect(texto).toContain('$: required nombra "falta"');
    expect(texto).toContain('$.a: la palabra clave "pattern" no está soportada');
    expect(texto).toContain('$.b[]: la palabra clave "oneOf" no está soportada');
    expect(texto).toContain('$.c{}: ');
    expect(texto).toContain('no resuelve');
    expect(texto).toContain('$.d: en OpenAPI 3.0 los hermanos de $ref se ignoran');
    expect(texto).toContain('$.e: un arreglo debe declarar items');
    expect(lista.length).toBeGreaterThanOrEqual(7);
  });

  it('todo esquema que no sea una referencia debe declarar type (si no, admitiría cualquier valor en silencio)', () => {
    expect(revisarEsquema(DOC, { description: 'sin tipo' }).join()).toContain('$: debe declarar type');
    expect(revisarEsquema(DOC, { type: 'object', properties: { a: { description: 'sin tipo' } } }).join()).toContain('$.a: debe declarar type');
    expect(revisarEsquema(DOC, { type: 'array', items: {} }).join()).toContain('$[]: debe declarar type');
    expect(revisarEsquema(DOC, { type: 'object', additionalProperties: { nullable: true } }).join()).toContain('${}: debe declarar type');
    // Una referencia no lleva type (lo lleva el esquema al que apunta) y no es un problema.
    const documento = { components: { schemas: { Bien: { type: 'string' } } } };
    expect(revisarEsquema(documento, { type: 'object', properties: { a: { $ref: '#/components/schemas/Bien' } } })).toEqual([]);
    // validar() sigue admitiendo un esquema sin type (es una opción del validador, no del documento).
    expect(validar(DOC, {}, 'cualquier cosa')).toEqual([]);
  });

  it('items sin type array y nullable que no es booleano también se señalan', () => {
    expect(revisarEsquema(DOC, { type: 'string', items: { type: 'string' } }).join()).toContain('items solo vale con type: array');
    expect(revisarEsquema(DOC, { type: 'string', nullable: 'si' }).join()).toContain('nullable debe ser true o false');
  });

  it('con una referencia buena no la sigue (cada esquema se revisa en su sitio) y no se queja', () => {
    const documento = { components: { schemas: { Bien: { type: 'string' } } } };
    expect(revisarEsquema(documento, { $ref: '#/components/schemas/Bien' })).toEqual([]);
  });
});

describe('observador (medir qué se ejercitó)', () => {
  const documento = {
    components: { schemas: { Dato: { type: 'integer', nullable: true } } },
  };
  const esquema = {
    type: 'object',
    required: ['a'],
    properties: { a: { $ref: '#/components/schemas/Dato' }, b: { type: 'string' } },
  };

  it('valor() recibe cada esquema ya resuelto con lo que validó, también null; objeto() recibe cada objeto', () => {
    const valores = [];
    const objetos = [];
    validar(documento, esquema, { a: null, b: 'x' }, '$', { valor: (e, v) => valores.push([e, v]), objeto: (e, v) => objetos.push([e, v]) });
    expect(valores.map(([, v]) => v)).toEqual([{ a: null, b: 'x' }, null, 'x']);
    expect(valores[1][0]).toBe(documento.components.schemas.Dato); // el esquema resuelto, no el { $ref }
    expect(objetos).toEqual([[esquema, { a: null, b: 'x' }]]);
  });

  it('un campo ausente no se observa como valor, pero el objeto sí permite ver qué propiedades faltaron', () => {
    const valores = [];
    validar(documento, esquema, { a: 3 }, '$', { valor: (_e, v) => valores.push(v) });
    expect(valores).toEqual([{ a: 3 }, 3]);
  });

  it('no cambia el resultado: los mismos incumplimientos con y sin observador', () => {
    const observador = { valor() {}, objeto() {} };
    for (const valor of [{ a: 1 }, { a: 'x' }, {}, { a: 1, b: 2 }]) {
      expect(validar(documento, esquema, valor, '$', observador)).toEqual(validar(documento, esquema, valor));
    }
  });
});
