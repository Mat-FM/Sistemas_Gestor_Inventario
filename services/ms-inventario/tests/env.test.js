const { ErrorDeConfiguracion, PLAZO_MAX_MS, PLAZO_MIN_MS, PUERTO_MAX, PUERTO_MIN, cargarConfig, mensajePlazoInvalido, plazoValido } = require('../src/config/env');

describe('cargarConfig con NODE_ENV=test', () => {
  const base = { DB_HOST: '127.0.0.1', DB_PORT: '5439', DB_NAME: 'inventario_db', DB_USER: 'inventario' };

  it('sin TEST_DB_NAME lanza un error claro en vez de dejar database en undefined', () => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'test' })).toThrow(/TEST_DB_NAME/);
  });

  it.each([['vacía', ''], ['solo con espacios', '   ']])('con TEST_DB_NAME %s también lanza el error', (_descripcion, valor) => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'test', TEST_DB_NAME: valor })).toThrow(/TEST_DB_NAME/);
  });

  it('no cae en DB_NAME: la base de desarrollo nunca se usa en pruebas', () => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'test' })).toThrow(/NODE_ENV=test/);
  });

  it('con TEST_DB_NAME definido usa esa base', () => {
    expect(cargarConfig({ ...base, NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test' }).db.database).toBe('inventario_test');
  });

  it.each([['production'], ['development'], [undefined]])('con NODE_ENV=%s no exige TEST_DB_NAME y usa DB_NAME', (entorno) => {
    expect(cargarConfig({ ...base, NODE_ENV: entorno }).db.database).toBe('inventario_db');
  });
});

describe('cargarConfig: CALL_TIMEOUT_MS (plazo de las llamadas a otros servicios)', () => {
  const base = { DB_HOST: '127.0.0.1', DB_PORT: '5439', DB_NAME: 'inventario_db', DB_USER: 'inventario' };
  const plazo = (valor) => cargarConfig({ ...base, CALL_TIMEOUT_MS: valor }).callTimeoutMs;

  it('ausente: usa 3000 ms (RNF18)', () => {
    expect(cargarConfig(base).callTimeoutMs).toBe(3000);
  });

  it.each([
    ['el mínimo', '1', 1],
    ['un valor normal', '3000', 3000],
    ['el máximo', '60000', 60000],
    ['con espacios alrededor', ' 2500 ', 2500],
    ['con ceros a la izquierda', '0100', 100],
  ])('acepta un entero entre 1 y 60000: %s', (_caso, texto, esperado) => {
    expect(plazo(texto)).toBe(esperado);
  });

  it.each([
    ['decimal', '1.5'],
    ['decimal con parte cero (3.0 no es la forma canónica de un entero)', '3.0'],
    ['punto final', '3.'],
    ['cero', '0'],
    ['negativo', '-5'],
    ['por encima del máximo', '60001'],
    ['3e9 (desbordaría el temporizador de Node y dejaría 1 ms en silencio)', '3e9'],
    ['3000000000', '3000000000'],
    ['notación científica', '1e3'],
    ['hexadecimal', '0x10'],
    ['texto', 'abc'],
    ['texto con número', '3000ms'],
    ['vacío (definida pero sin valor)', ''],
    ['solo espacios', '   '],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['con signo más', '+5'],
    ['cifras de ancho completo', '３０００'],
  ])('rechaza %s con un error de configuración que nombra la variable y el valor', (_caso, texto) => {
    let error;
    try {
      plazo(texto);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ErrorDeConfiguracion);
    expect(error.name).toBe('ErrorDeConfiguracion');
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toContain('CALL_TIMEOUT_MS');
    expect(error.message).toContain('entre 1 y 60000');
    expect(error.message).toContain(JSON.stringify(texto));
  });

  it('el rango vive en un único sitio y lo usan la validación y el mensaje', () => {
    expect([PLAZO_MIN_MS, PLAZO_MAX_MS]).toEqual([1, 60000]);
    for (const valido of [1, 1000, 60000]) expect(plazoValido(valido)).toBe(true);
    for (const invalido of [0, -1, 1.5, 60001, 3e9, NaN, Infinity, '3000', null, undefined, {}]) expect(plazoValido(invalido)).toBe(false);
    expect(mensajePlazoInvalido('abc')).toBe('CALL_TIMEOUT_MS debe ser un número entero de milisegundos entre 1 y 60000 (recibido: "abc")');
    expect(mensajePlazoInvalido(1.5, 'timeoutMs')).toBe('timeoutMs debe ser un número entero de milisegundos entre 1 y 60000 (recibido: 1.5)');
    // un valor que no se puede convertir a texto no hace fallar al mensaje
    expect(mensajePlazoInvalido({ toString() { throw new Error('x'); } })).toContain('recibido: ');
  });

  it('un plazo inválido no cambia el comportamiento de las demás variables (las obligatorias ausentes no lanzan: /health las avisa, D17)', () => {
    expect(() => cargarConfig({})).not.toThrow();
    expect(cargarConfig({ PORT: '4000' })).toMatchObject({ puerto: 4000, callTimeoutMs: 3000 });
  });
});

describe('cargarConfig: PORT (puerto HTTP del servicio)', () => {
  const base = { DB_HOST: '127.0.0.1', DB_PORT: '5439', DB_NAME: 'inventario_db', DB_USER: 'inventario' };
  const puerto = (valor) => cargarConfig({ ...base, PORT: valor }).puerto;

  it('ausente (o undefined): usa 3000', () => {
    expect(cargarConfig(base).puerto).toBe(3000);
    expect(cargarConfig({ ...base, PORT: undefined }).puerto).toBe(3000);
  });

  it.each([
    ['el mínimo', '1', 1],
    ['un valor normal', '3055', 3055],
    ['el máximo', '65535', 65535],
    ['con espacios alrededor', ' 8080 ', 8080],
    ['con ceros a la izquierda', '0080', 80],
  ])('acepta un entero entre 1 y 65535: %s', (_caso, texto, esperado) => {
    expect(puerto(texto)).toBe(esperado);
  });

  it.each([
    ['texto (si llegara a listen como texto, Node abriría un socket Unix con ese nombre)', 'abc'],
    ['cero (puerto efímero: nadie sabría dónde escucha)', '0'],
    ['negativo', '-1'],
    ['por encima del máximo', '65536'],
    ['70000', '70000'],
    ['decimal', '3000.5'],
    ['decimal con parte cero', '3000.0'],
    ['notación científica (Number la aceptaba y escuchaba en el 1000)', '1e3'],
    ['hexadecimal (Number la aceptaba y escuchaba en el 8080)', '0x1F90'],
    ['texto con número', '3000abc'],
    ['con signo más', '+3000'],
    ['vacío (definida pero sin valor)', ''],
    ['solo espacios', '   '],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['cifras de ancho completo', '３０００'],
  ])('rechaza %s con un error de configuración que nombra la variable y el valor', (_caso, texto) => {
    let error;
    try {
      puerto(texto);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ErrorDeConfiguracion);
    expect(error.name).toBe('ErrorDeConfiguracion');
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.message).toBe(`PORT debe ser un número entero entre 1 y 65535 (recibido: ${JSON.stringify(texto)})`);
  });

  it('el rango vive en un único sitio y lo que sale de cargarConfig es siempre un número entero válido para listen', () => {
    expect([PUERTO_MIN, PUERTO_MAX]).toEqual([1, 65535]);
    for (const texto of ['1', '80', '3000', '65535', ' 7 ']) {
      const resultado = puerto(texto);
      expect(typeof resultado).toBe('number'); // jamás el texto: un listen('abc') abriría un socket Unix
      expect(Number.isInteger(resultado) && resultado >= PUERTO_MIN && resultado <= PUERTO_MAX).toBe(true);
    }
  });

  it('un PORT inválido lo rechaza cargarConfig y, con ella, también knexfile.js (que la llama); DB_PORT sigue con su propia lectura', () => {
    expect(() => cargarConfig({ PORT: 'abc' })).toThrow(ErrorDeConfiguracion);
    expect(cargarConfig({ DB_PORT: '' }).db.port).toBeUndefined(); // DB_PORT sigue su propia lectura: vacío = ausente
    expect(cargarConfig({ DB_PORT: '5439' }).db.port).toBe(5439);
  });
});
