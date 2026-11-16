const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { iniciar } = require('../src/server');
const { entornoValido } = require('./helpers/app');
const { PLAZO_HIJO_MS, ejecutarHijo } = require('./helpers/hijos');
const { ocuparPuerto, puertoLibre } = require('./helpers/puertos');

// Arranque del servicio: la función iniciar (con `salir` inyectado) y el proceso real (node src/server.js).

const RAIZ = path.join(__dirname, '..');
const loggerEspia = () => ({ info: jest.fn(), error: jest.fn() });

// PORT=0 (puerto efímero) ya no es válido: las pruebas que arrancan el servicio usan un puerto libre concreto, el mismo para todo el
// archivo (cada prueba cierra su servidor antes de la siguiente).
let PUERTO;
beforeAll(async () => {
  PUERTO = await puertoLibre();
});
const entornoDePrueba = (extra = {}) => ({ ...entornoValido(), NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', PORT: String(PUERTO), ...extra });
const SENALES = ['SIGTERM', 'SIGINT'];

describe('iniciar (arranque con captura de errores)', () => {
  const cerrar = [];
  afterEach(async () => {
    for (const funcion of cerrar.splice(0).reverse()) await funcion();
  });

  // Registra los listeners de señales que añada iniciar y los quita al terminar la prueba.
  function vigilarSenales() {
    const antes = Object.fromEntries(SENALES.map((senal) => [senal, process.listeners(senal)]));
    const nuevos = () => Object.fromEntries(SENALES.map((senal) => [senal, process.listeners(senal).filter((f) => !antes[senal].includes(f))]));
    cerrar.push(() => {
      for (const senal of SENALES) for (const f of nuevos()[senal]) process.removeListener(senal, f);
    });
    return nuevos;
  }

  it('una configuración inválida se registra una vez (nombre y mensaje, sin pila), sale con 1 y no deja nada escuchando', () => {
    const nuevos = vigilarSenales();
    const log = loggerEspia();
    const salir = jest.fn();
    const resultado = iniciar(entornoDePrueba({ CALL_TIMEOUT_MS: 'abc' }), log, salir);

    expect(resultado).toBeNull();
    expect(salir).toHaveBeenCalledTimes(1);
    expect(salir).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]).toEqual([
      {
        mensaje: 'No se pudo iniciar el servicio',
        error: { nombre: 'ErrorDeConfiguracion', mensaje: expect.stringContaining('CALL_TIMEOUT_MS') },
      },
    ]);
    expect(log.info).not.toHaveBeenCalled();
    for (const senal of SENALES) expect(nuevos()[senal]).toHaveLength(0);
  });

  it('cualquier otro error de arranque (aquí NODE_ENV=test sin TEST_DB_NAME) recibe el mismo trato', () => {
    const log = loggerEspia();
    const salir = jest.fn();
    iniciar({ NODE_ENV: 'test' }, log, salir);
    expect(salir).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls[0][0]).toEqual({
      mensaje: 'No se pudo iniciar el servicio',
      error: { nombre: 'Error', mensaje: expect.stringContaining('TEST_DB_NAME') },
    });
  });

  it('un error que no es un Error (un throw de texto) también se registra y sale con 1', () => {
    const log = loggerEspia();
    const salir = jest.fn();
    // cargarConfig recibe un objeto cuyo getter lanza un texto: el arranque no debe romperse al describirlo
    const env = {
      get CALL_TIMEOUT_MS() {
        throw 'sin-clase';
      },
    };
    iniciar(env, log, salir);
    expect(salir).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls[0][0]).toEqual({ mensaje: 'No se pudo iniciar el servicio', error: { nombre: 'string', mensaje: 'sin-clase' } });
  });

  it('con una configuración válida escucha, registra el inicio, sirve /health y no sale', async () => {
    const nuevos = vigilarSenales();
    const log = loggerEspia();
    const salir = jest.fn();
    const arrancado = iniciar(entornoDePrueba({ CALL_TIMEOUT_MS: '2500' }), log, salir);
    expect(arrancado).not.toBeNull();
    const { server, db } = arrancado;
    cerrar.push(async () => {
      if (server.listening) await new Promise((resolver) => server.close(resolver));
      await db.destroy().catch(() => {});
    });
    if (!server.listening) await new Promise((resolver) => server.once('listening', resolver));

    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    expect(respuesta.status).toBe(200);
    expect(server.address().port).toBe(PUERTO);
    expect(log.info).toHaveBeenCalledWith({ mensaje: 'Servidor iniciado', puerto: PUERTO });
    expect(log.error).not.toHaveBeenCalled();
    expect(salir).not.toHaveBeenCalled();
    for (const senal of SENALES) expect(nuevos()[senal]).toHaveLength(1);
  });

  it('al recibir SIGTERM cierra el servidor y el pool y sale con 0', async () => {
    const nuevos = vigilarSenales();
    const salida = new Promise((resolver) => {
      const salir = jest.fn(resolver);
      const arrancado = iniciar(entornoDePrueba(), loggerEspia(), salir);
      cerrar.push(async () => {
        await arrancado.db.destroy().catch(() => {});
      });
      arrancado.server.once('listening', () => nuevos().SIGTERM[0]());
    });
    await expect(salida).resolves.toBe(0);
  });

  it.each([['texto', 'abc'], ['cero', '0'], ['negativo', '-1'], ['por encima de 65535', '65536'], ['decimal', '3000.5'], ['vacío', '']])(
    'PORT inválido (%s) es un error de configuración: se registra una vez (nombre y mensaje, sin pila), sale con 1 y no escucha ni deja señales',
    (_caso, valor) => {
      const nuevos = vigilarSenales();
      const log = loggerEspia();
      const salir = jest.fn();
      const resultado = iniciar(entornoDePrueba({ PORT: valor }), log, salir);

      expect(resultado).toBeNull();
      expect(salir).toHaveBeenCalledTimes(1);
      expect(salir).toHaveBeenCalledWith(1);
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls[0]).toEqual([
        {
          mensaje: 'No se pudo iniciar el servicio',
          error: { nombre: 'ErrorDeConfiguracion', mensaje: `PORT debe ser un número entero entre 1 y 65535 (recibido: ${JSON.stringify(valor)})` },
        },
      ]);
      expect(log.info).not.toHaveBeenCalled();
      for (const senal of SENALES) expect(nuevos()[senal]).toHaveLength(0);
    },
  );

  it('un puerto ocupado (EADDRINUSE) se registra una vez (nombre y mensaje, sin pila), libera el pool, sale con 1 y no deja señales', async () => {
    const nuevos = vigilarSenales();
    const ocupado = await ocuparPuerto();
    cerrar.push(ocupado.cerrar);
    const log = loggerEspia();
    let arrancado;
    const salida = new Promise((resolver) => {
      arrancado = iniciar(entornoDePrueba({ PORT: String(ocupado.puerto) }), log, jest.fn(resolver));
    });
    expect(arrancado).not.toBeNull(); // la configuración era válida: el fallo llega después, al escuchar
    expect(arrancado.db.client.pool).toBeDefined(); // control: el pool existe hasta que el arranque falla

    await expect(salida).resolves.toBe(1);

    expect(arrancado.db.client.pool).toBeUndefined(); // db.destroy() ya corrió: Knex suelta el pool al destruirlo
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]).toEqual([
      {
        mensaje: 'No se pudo escuchar',
        puerto: ocupado.puerto,
        error: { nombre: 'Error', mensaje: expect.stringContaining('EADDRINUSE') },
      },
    ]);
    expect(Object.keys(log.error.mock.calls[0][0].error)).toEqual(['nombre', 'mensaje']); // sin pila
    expect(log.info).not.toHaveBeenCalled(); // nunca llegó a decir «Servidor iniciado»
    expect(arrancado.server.listening).toBe(false);
    for (const senal of SENALES) expect(nuevos()[senal]).toHaveLength(0); // sin servidor, SIGTERM ya no tiene nada que cerrar
  });

  it('un error del servidor que ya escucha (p. ej. EMFILE al aceptar una conexión) recibe el mismo trato, con otro mensaje', async () => {
    vigilarSenales();
    const log = loggerEspia();
    let arrancado;
    const salida = new Promise((resolver) => {
      arrancado = iniciar(entornoDePrueba(), log, jest.fn(resolver));
    });
    cerrar.push(async () => {
      if (arrancado.server.listening) await new Promise((resolver) => arrancado.server.close(resolver));
      await arrancado.db.destroy().catch(() => {});
    });
    if (!arrancado.server.listening) await new Promise((resolver) => arrancado.server.once('listening', resolver));

    arrancado.server.emit('error', Object.assign(new Error('demasiados archivos abiertos'), { code: 'EMFILE' }));

    await expect(salida).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]).toEqual([
      { mensaje: 'Error del servidor', puerto: PUERTO, error: { nombre: 'Error', mensaje: 'demasiados archivos abiertos' } },
    ]);
  });

  it('D17 sigue igual: con variables obligatorias ausentes arranca (no sale) y /health responde 503', async () => {
    vigilarSenales();
    const log = loggerEspia();
    const salir = jest.fn();
    const arrancado = iniciar({ NODE_ENV: 'test', TEST_DB_NAME: 'inventario_test', PORT: String(PUERTO) }, log, salir);
    expect(arrancado).not.toBeNull();
    cerrar.push(async () => {
      if (arrancado.server.listening) await new Promise((resolver) => arrancado.server.close(resolver));
      await arrancado.db.destroy().catch(() => {});
    });
    if (!arrancado.server.listening) await new Promise((resolver) => arrancado.server.once('listening', resolver));
    const respuesta = await fetch(`http://127.0.0.1:${arrancado.server.address().port}/health`);
    expect(respuesta.status).toBe(503);
    expect(salir).not.toHaveBeenCalled();
  });
});

describe('proceso real: node src/server.js', () => {
  let senuelo; // un servidor TCP que cuenta conexiones: la base de datos "falsa" a la que apunta DB_PORT
  let conexiones = 0;

  beforeAll(async () => {
    senuelo = net.createServer((socket) => {
      conexiones += 1;
      socket.destroy();
    });
    await new Promise((resolver) => senuelo.listen(0, '127.0.0.1', resolver));
  });
  afterAll(async () => {
    senuelo.closeAllConnections?.();
    await new Promise((resolver) => senuelo.close(resolver));
  });
  beforeEach(() => {
    conexiones = 0;
  });

  // Entorno mínimo del hijo: sin NODE_ENV ni TEST_DB_NAME, y con la base apuntando al señuelo (nunca a una base real).
  const entornoDelHijo = (extra = {}) => ({
    PATH: process.env.PATH,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(senuelo.address().port),
    DB_NAME: 'base_senuelo',
    DB_USER: 'usuario',
    DB_PASSWORD: 'clave',
    MS_CATALOGO_URL: 'http://127.0.0.1:9',
    MS_NOTIFICACIONES_URL: 'http://127.0.0.1:9',
    PORT: String(PUERTO),
    ...extra,
  });

  // Lanza `node src/server.js` con un plazo propio de `plazoMs` desde que nace (menos que el de las pruebas de Jest, 30 s): si
  // el hijo no ha cerrado para entonces se le manda SIGKILL y `cierre` RECHAZA con un mensaje claro, en vez de dejar al proceso
  // vivo y a la prueba esperando. El temporizador se cancela cuando el hijo cierra.
  function lanzar(env, { plazoMs = PLAZO_HIJO_MS, cwd = RAIZ } = {}) {
    // La ruta del script es absoluta para poder lanzarlo desde otra carpeta (la de un archivo que no debe aparecer, ver PORT=abc).
    const hijo = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const resultado = { stdout: '', stderr: '', codigo: undefined, senal: undefined };
    let agotado = false;
    const temporizador = setTimeout(() => {
      agotado = true;
      hijo.kill('SIGKILL');
    }, plazoMs);
    hijo.stdout.on('data', (trozo) => { resultado.stdout += trozo; });
    hijo.stderr.on('data', (trozo) => { resultado.stderr += trozo; });
    resultado.cierre = new Promise((resolver, rechazar) => {
      hijo.on('close', (codigo, senal) => {
        clearTimeout(temporizador);
        resultado.codigo = codigo;
        resultado.senal = senal;
        if (agotado) rechazar(new Error(`El proceso hijo no terminó en ${plazoMs} ms y se mató con SIGKILL. stdout: ${resultado.stdout} stderr: ${resultado.stderr}`));
        else resolver(resultado);
      });
    });
    resultado.cierre.catch(() => {}); // si nadie la espera cuando vence el plazo, no es un rechazo sin manejar
    resultado.hijo = hijo;
    return resultado;
  }

  const lineasDe = (texto) => texto.split('\n').filter((linea) => linea.trim() !== '');

  it('CALL_TIMEOUT_MS=abc: sale con código 1 y escribe UNA línea JSON con el mensaje, sin TypeError ni pila, sin tocar la base', async () => {
    const proceso = lanzar(entornoDelHijo({ CALL_TIMEOUT_MS: 'abc' }));
    try {
      await proceso.cierre;
    } finally {
      proceso.hijo.kill('SIGKILL');
    }
    expect(proceso.codigo).toBe(1);

    const salida = `${proceso.stdout}\n${proceso.stderr}`;
    const lineas = lineasDe(salida);
    expect(lineas).toHaveLength(1);
    const registro = JSON.parse(lineas[0]);
    expect(registro).toEqual({
      mensaje: 'No se pudo iniciar el servicio',
      error: { nombre: 'ErrorDeConfiguracion', mensaje: expect.stringContaining('CALL_TIMEOUT_MS') },
      servicio: 'ms-inventario',
      nivel: 'error',
    });
    expect(Object.keys(registro.error)).toEqual(['nombre', 'mensaje']); // sin pila
    expect(salida).not.toMatch(/TypeError|Node\.js v|node:internal|\n\s+at /);
    expect(conexiones).toBe(0);
  });

  // Una carpeta de trabajo vacía y desechable, fuera del repositorio.
  const carpetaTemporal = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ms-inventario-puerto-'));

  it('control: listen() con un TEXTO no numérico abre un socket Unix con ese nombre en el directorio de trabajo (por eso PORT no puede llegar como texto)', async () => {
    const carpeta = carpetaTemporal();
    try {
      const { stdout } = await ejecutarHijo(['-e', "const s = require('node:http').createServer().listen('abc', () => { console.log(JSON.stringify(require('node:fs').readdirSync('.'))); s.close(); });"], { cwd: carpeta });
      expect(JSON.parse(stdout)).toEqual(['abc']);
    } finally {
      fs.rmSync(carpeta, { recursive: true, force: true });
    }
  });

  it('PORT=abc: sale con 1 y escribe UNA línea JSON con el mensaje, sin pila, sin tocar la base y SIN crear ningún archivo en el directorio de trabajo', async () => {
    const carpeta = carpetaTemporal();
    try {
      const proceso = lanzar(entornoDelHijo({ PORT: 'abc' }), { cwd: carpeta });
      try {
        await proceso.cierre;
      } finally {
        proceso.hijo.kill('SIGKILL');
      }
      expect(proceso.codigo).toBe(1);

      const salida = `${proceso.stdout}\n${proceso.stderr}`;
      const lineas = lineasDe(salida);
      expect(lineas).toHaveLength(1);
      expect(JSON.parse(lineas[0])).toEqual({
        mensaje: 'No se pudo iniciar el servicio',
        error: { nombre: 'ErrorDeConfiguracion', mensaje: 'PORT debe ser un número entero entre 1 y 65535 (recibido: "abc")' },
        servicio: 'ms-inventario',
        nivel: 'error',
      });
      expect(salida).not.toMatch(/RangeError|TypeError|ERR_SOCKET_BAD_PORT|Node\.js v|node:internal|\n\s+at /);
      expect(conexiones).toBe(0);
      expect(fs.readdirSync(carpeta)).toEqual([]); // ni un socket «abc» ni nada
    } finally {
      fs.rmSync(carpeta, { recursive: true, force: true });
    }
  });

  it('un puerto ocupado: sale con 1 y escribe UNA línea JSON con el mensaje (nombre y mensaje), no la pila de Node ni «Unhandled error event»', async () => {
    const ocupado = await ocuparPuerto();
    try {
      const proceso = lanzar(entornoDelHijo({ PORT: String(ocupado.puerto) }));
      try {
        await proceso.cierre;
      } finally {
        proceso.hijo.kill('SIGKILL');
      }
      expect(proceso.codigo).toBe(1);

      const salida = `${proceso.stdout}\n${proceso.stderr}`;
      const lineas = lineasDe(salida);
      expect(lineas).toHaveLength(1);
      const registro = JSON.parse(lineas[0]);
      expect(registro).toEqual({
        mensaje: 'No se pudo escuchar',
        puerto: ocupado.puerto,
        error: { nombre: 'Error', mensaje: expect.stringContaining('EADDRINUSE') },
        servicio: 'ms-inventario',
        nivel: 'error',
      });
      expect(Object.keys(registro.error)).toEqual(['nombre', 'mensaje']); // sin pila
      expect(salida).not.toMatch(/Unhandled 'error' event|node:events|Node\.js v|\n\s+at /);
    } finally {
      await ocupado.cerrar();
    }
  });

  it('control: con CALL_TIMEOUT_MS válido el mismo proceso arranca y, al recibir SIGTERM, sale con 0', async () => {
    const proceso = lanzar(entornoDelHijo({ CALL_TIMEOUT_MS: '3000' }));
    try {
      const limite = Date.now() + 15000;
      while (!proceso.stdout.includes('Servidor iniciado')) {
        if (proceso.codigo !== undefined || Date.now() > limite) throw new Error(`El proceso no arrancó: ${proceso.stdout} ${proceso.stderr}`);
        await new Promise((resolver) => setTimeout(resolver, 20));
      }
      proceso.hijo.kill('SIGTERM');
      await proceso.cierre;
    } finally {
      proceso.hijo.kill('SIGKILL');
    }
    expect(proceso.codigo).toBe(0);
    expect(proceso.stderr).toBe('');
    const lineas = lineasDe(proceso.stdout).map((linea) => JSON.parse(linea));
    expect(lineas).toEqual([expect.objectContaining({ mensaje: 'Servidor iniciado', nivel: 'info', servicio: 'ms-inventario' })]);
  });

  it('higiene: un servidor que no cierra en su plazo se MATA y `cierre` rechaza con un mensaje claro (no queda vivo ni la prueba esperando)', async () => {
    // El servidor de control arranca y se queda escuchando: con un plazo de 1,5 s no llega a cerrar solo.
    const proceso = lanzar(entornoDelHijo({ CALL_TIMEOUT_MS: '3000' }), { plazoMs: 1500 });
    try {
      await expect(proceso.cierre).rejects.toThrow(/El proceso hijo no terminó en 1500 ms y se mató con SIGKILL/);
      expect(proceso.senal).toBe('SIGKILL');
      expect(() => process.kill(proceso.hijo.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })); // ya no existe
    } finally {
      proceso.hijo.kill('SIGKILL');
    }
  });
});
