const { AppError } = require('../src/errors');
const idempotencia = require('../src/services/idempotencia');

// Claves de idempotencia (RNF17; D25, D25b, D25c): la clave guardada `<id_usuario>:<operacion>:<clave>`, las derivadas
// `<guardada>#<sufijo>` (D5) y la lectura de la cabecera Idempotency-Key. Sin base de datos: son funciones puras. El
// comportamiento de punta a punta está en movimientos.test.js.

const { OPERACIONES, claveAlmacenada, derivada, leerClaveIdempotencia, LARGO_MAXIMO_CLAVE } = idempotencia;

function atraparSincrono(funcion) {
  try {
    funcion();
  } catch (error) {
    return error;
  }
  throw new Error('Se esperaba una excepción');
}

describe('OPERACIONES (D25b)', () => {
  it('son exactamente mov, tras, con e ini, congeladas', () => {
    expect(OPERACIONES).toEqual({ MOVIMIENTO: 'mov', TRASLADO: 'tras', CONTEO: 'con', CARGA_INICIAL: 'ini' });
    expect(Object.isFrozen(OPERACIONES)).toBe(true);
  });
});

describe('claveAlmacenada (D25, D25b)', () => {
  it('es `<id_usuario>:<operacion>:<clave>`, sin transformar la clave', () => {
    expect(claveAlmacenada(7, OPERACIONES.MOVIMIENTO, 'k1')).toBe('7:mov:k1');
    expect(claveAlmacenada(12, OPERACIONES.TRASLADO, ' A b ')).toBe('12:tras: A b ');
  });

  it('el MISMO usuario con la MISMA clave en dos operaciones da claves distintas', () => {
    const claves = Object.values(OPERACIONES).map((operacion) => claveAlmacenada(7, operacion, 'k'));
    expect(claves).toEqual(['7:mov:k', '7:tras:k', '7:con:k', '7:ini:k']);
    expect(new Set(claves).size).toBe(4);
  });

  it('es inyectiva: usuario (solo dígitos) y operación (sin ":") se separan siempre por los dos primeros ":"', () => {
    const tripletas = [[1, 'mov', '2:x'], [12, 'mov', 'x'], [1, 'mov', 'tras:x'], [1, 'tras', 'x'], [12, 'mov', ':x'], [121, 'mov', 'x']];
    const claves = tripletas.map((tripleta) => claveAlmacenada(...tripleta));
    expect(new Set(claves).size).toBe(tripletas.length);
    for (const [indice, [usuario, operacion, clave]] of tripletas.entries()) {
      const [u, o, ...resto] = claves[indice].split(':');
      expect([Number(u), o, resto.join(':')]).toEqual([usuario, operacion, clave]);
    }
  });

  it.each([['MOV'], ['movimiento'], [''], [undefined], ['x:y'], [7]])('una operación desconocida (%p) es un error de PROGRAMACIÓN (TypeError, no AppError)', (operacion) => {
    const error = atraparSincrono(() => claveAlmacenada(7, operacion, 'k'));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(AppError);
  });

  it.each([
    [null, 'k'], [0, 'k'], [1.5, 'k'], ['7', 'k'], [7, ''], [7, null], [7, 5],
  ])('claveAlmacenada(%p, "mov", %p) → TypeError', (usuario, clave) => {
    expect(() => claveAlmacenada(usuario, 'mov', clave)).toThrow(TypeError);
  });
});

describe('derivada (D5, D25c)', () => {
  const base = claveAlmacenada(7, OPERACIONES.CONTEO, 'k');

  it('es `<guardada>#<sufijo>` con un entero o un texto', () => {
    expect(derivada(base, 1)).toBe('7:con:k#1');
    expect(derivada(base, 'linea-3')).toBe('7:con:k#linea-3');
  });

  it('pares (clave, sufijo) distintos dan claves distintas', () => {
    const pares = [['k', 1], ['k', 2], ['k', 12], ['k1', 2], ['k', '1'], ['k2', 1]];
    const claves = pares.map(([clave, sufijo]) => derivada(claveAlmacenada(7, 'ini', clave), sufijo));
    // ['k', 1] y ['k', '1'] son el mismo sufijo: se espera exactamente una coincidencia, la de esos dos.
    expect(new Set(claves).size).toBe(pares.length - 1);
    expect(claves[0]).toBe(claves[4]);
  });

  it('con `#` prohibido en la cabecera, una clave de usuario nunca coincide con una derivada: "abc#1" no llega a armarse', () => {
    expect(() => leerClaveIdempotencia('abc#1')).toThrow(AppError);
    const deUsuario = claveAlmacenada(7, 'mov', leerClaveIdempotencia('abc-1'));
    expect(deUsuario).not.toBe(derivada(claveAlmacenada(7, 'mov', 'abc'), 1));
    expect(deUsuario).not.toContain('#');
  });

  it.each([[''], [null], [undefined], [1.5], [-1], [Number.MAX_SAFE_INTEGER + 1], [{}], [['1']], ['a#b']])('un sufijo vacío o que no es texto ni entero seguro no negativo (o con «#») (%p) → TypeError', (sufijo) => {
    expect(() => derivada(base, sufijo)).toThrow(TypeError);
  });

  it('una base que no es texto o está vacía → TypeError', () => {
    expect(() => derivada('', 1)).toThrow(TypeError);
    expect(() => derivada(null, 1)).toThrow(TypeError);
  });

  it('el peor caso cabe en varchar(255): id de 10 dígitos, operación de 4, clave de 200 y sufijo de 10 → 227', () => {
    const peor = derivada(claveAlmacenada(2147483647, OPERACIONES.TRASLADO, 'k'.repeat(LARGO_MAXIMO_CLAVE)), 2147483647);
    expect(peor.length).toBe(227);
    expect(peor.length).toBeLessThanOrEqual(255);
  });
});

describe('leerClaveIdempotencia', () => {
  it('devuelve la clave sin espacios en los extremos, de 1 a 200 caracteres', () => {
    expect(leerClaveIdempotencia('  k1 ')).toBe('k1');
    expect(leerClaveIdempotencia('k')).toBe('k');
    expect(leerClaveIdempotencia('k'.repeat(200))).toBe('k'.repeat(200));
  });

  it.each([[undefined], [''], ['   '], ['k'.repeat(201)], [['a', 'b']], [5], ['abc#1'], ['#'], ['a#']])('%p → 400 PETICION_MAL_FORMADA', (valor) => {
    const error = atraparSincrono(() => leerClaveIdempotencia(valor));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 400, codigo: 'PETICION_MAL_FORMADA' });
  });

  it('el 400 por `#` lo explica en español y no repite el valor recibido', () => {
    const secreto = `${'s'.repeat(50)}#centinela`;
    const error = atraparSincrono(() => leerClaveIdempotencia(secreto));
    expect(error.message).toMatch(/#/);
    expect(error.message).toMatch(/no puede contener/);
    expect(error.message).not.toContain('centinela');
  });
});
