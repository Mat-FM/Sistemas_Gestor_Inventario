const { AGOTADO, PLAZO_HIJO_MS, ejecutarHijo, esperarConPlazo, lanzarHijo } = require('./helpers/hijos');

// Higiene de las pruebas que lanzan procesos hijos o esperan con un plazo: ninguna debe dejar un proceso vivo ni un temporizador
// pendiente, ni siquiera cuando algo falla (la base no responde, un cierre que no llega). Es el ÚNICO sitio donde se prueba el
// mecanismo; db.test.js, lotes.test.js, lotesCapas.test.js y startup.test.js lo usan.

const vive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
// Un hijo que dice su pid y no termina nunca (un intervalo mantiene vivo el bucle de eventos).
const COLGADO = 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);';

describe('ejecutarHijo (proceso hijo con plazo propio)', () => {
  it('el plazo por defecto es de 20 s: menos que el de las pruebas de Jest (30 s) y mucho menos que los 60 s de Knex', () => {
    expect(PLAZO_HIJO_MS).toBe(20000);
  });

  it('un hijo que termina bien devuelve su stdout y su stderr, con el entorno y el directorio pedidos', async () => {
    const { stdout, stderr } = await ejecutarHijo(['-e', 'process.stdout.write(process.env.DATO + "|" + process.cwd()); process.stderr.write("aviso")'], { env: { ...process.env, DATO: 'hola' }, cwd: __dirname });
    expect(stdout).toBe(`hola|${__dirname}`);
    expect(stderr).toBe('aviso');
  });

  it('un hijo que sale con error rechaza con su mensaje y su stderr (no se confunde con el plazo)', async () => {
    const error = await ejecutarHijo(['-e', 'process.stderr.write("causa-centinela"); process.exit(3)']).catch((fallo) => fallo);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('causa-centinela');
    expect(error.message).not.toMatch(/no terminó/);
  });

  it('un hijo colgado → la prueba FALLA con un mensaje claro tras el plazo, y el proceso hijo MUERE (SIGKILL)', async () => {
    const inicio = Date.now();
    const error = await ejecutarHijo(['-e', COLGADO], { plazoMs: 400 }).catch((fallo) => fallo);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/El proceso hijo no terminó en 400 ms y se mató con SIGKILL/);
    expect(Date.now() - inicio).toBeLessThan(5000); // no esperó los 20 s por defecto
    const pid = Number(error.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true); // control: el hijo sí llegó a arrancar y dijo su pid
    expect(vive(pid)).toBe(false);
  });

  it('control: sin el plazo propio, el mismo hijo seguiría vivo (el plazo es lo que lo mata)', async () => {
    // Se lanza con un plazo largo y se mata a mano: así se ve que el hijo NO termina solo.
    const { spawn } = require('node:child_process');
    const hijo = spawn(process.execPath, ['-e', COLGADO], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((resolver) => { hijo.stdout.once('data', resolver); });
      await new Promise((resolver) => { setTimeout(resolver, 300); });
      expect(vive(hijo.pid)).toBe(true);
    } finally {
      hijo.kill('SIGKILL');
      await new Promise((resolver) => { hijo.once('close', resolver); });
    }
    expect(vive(hijo.pid)).toBe(false);
  });
});

describe('esperarConPlazo (Promise.race con un temporizador que no queda vivo)', () => {
  afterEach(() => jest.useRealTimers());

  it('si la promesa gana, devuelve su valor y NO deja el temporizador pendiente', async () => {
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    expect(await esperarConPlazo(Promise.resolve('listo'), 2000)).toBe('listo');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('si la promesa RECHAZA, el rechazo llega a quien espera y el temporizador tampoco queda pendiente', async () => {
    jest.useFakeTimers();
    await expect(esperarConPlazo(Promise.reject(new Error('fallo')), 2000)).rejects.toThrow('fallo');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('si el plazo vence antes, devuelve AGOTADO (un símbolo, nunca un valor que la promesa pudiera dar) y deja el temporizador consumido', async () => {
    jest.useFakeTimers();
    const lenta = new Promise(() => {});
    const espera = esperarConPlazo(lenta, 2000);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1999);
    expect(jest.getTimerCount()).toBe(1); // control: todavía no vence
    jest.advanceTimersByTime(1);
    expect(await espera).toBe(AGOTADO);
    expect(typeof AGOTADO).toBe('symbol');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('con temporizadores reales: una promesa rápida no retrasa la prueba hasta el plazo', async () => {
    const inicio = Date.now();
    expect(await esperarConPlazo(Promise.resolve(7), 5000)).toBe(7);
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});

describe('lanzarHijo (proceso hijo que sigue vivo mientras la prueba le habla, con plazo SIEMPRE)', () => {
  // Un hijo que avisa cuando ya atiende SIGTERM y, al recibirlo, sale con 0 (como el servicio).
  const OBEDIENTE = "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('listo'); setInterval(() => {}, 1000);";

  afterEach(() => jest.restoreAllMocks());

  it('sin indicar plazo usa el de 20 s, y el temporizador se cancela cuando el hijo cierra (no queda vivo tras la prueba)', async () => {
    const poner = jest.spyOn(global, 'setTimeout');
    const quitar = jest.spyOn(global, 'clearTimeout');
    const proceso = lanzarHijo(['-e', '0']);
    await proceso.cierre;
    const llamada = poner.mock.calls.findIndex(([, ms]) => ms === PLAZO_HIJO_MS);
    expect(llamada).toBeGreaterThan(-1); // el plazo por defecto se armó…
    expect(quitar).toHaveBeenCalledWith(poner.mock.results[llamada].value); // …y se canceló al cerrar el hijo
  });

  it('un hijo que termina bien: `cierre` resuelve el mismo objeto con código 0, su stdout y su stderr', async () => {
    const proceso = lanzarHijo(['-e', 'process.stdout.write("salida"); process.stderr.write("aviso")'], { env: { PATH: process.env.PATH } });
    await expect(proceso.cierre).resolves.toBe(proceso);
    expect({ codigo: proceso.codigo, senal: proceso.senal, stdout: proceso.stdout, stderr: proceso.stderr }).toEqual({ codigo: 0, senal: null, stdout: 'salida', stderr: 'aviso' });
  });

  it('un hijo que sale con error NO rechaza: `cierre` resuelve y deja el código para que la prueba lo compruebe', async () => {
    const proceso = lanzarHijo(['-e', 'process.exit(3)']);
    await expect(proceso.cierre).resolves.toBe(proceso);
    expect(proceso.codigo).toBe(3);
  });

  it('respeta el directorio de trabajo y el entorno que se le piden', async () => {
    const proceso = lanzarHijo(['-e', 'process.stdout.write(process.env.DATO + "|" + process.cwd())'], { env: { ...process.env, DATO: 'hola' }, cwd: __dirname });
    await proceso.cierre;
    expect(proceso.stdout).toBe(`hola|${__dirname}`);
  });

  it('se le puede mandar SIGTERM a mitad: sale con 0 antes de que venza el plazo, y su salida en curso ya era visible', async () => {
    const proceso = lanzarHijo(['-e', OBEDIENTE], { plazoMs: 15000 });
    try {
      const limite = Date.now() + 10000;
      while (!proceso.stdout.includes('listo')) {
        if (proceso.codigo !== undefined || Date.now() > limite) throw new Error(`El hijo no arrancó: ${proceso.stderr}`);
        await new Promise((resolver) => { setTimeout(resolver, 10); });
      }
      expect(proceso.codigo).toBeUndefined(); // sigue vivo: todavía no ha cerrado
      proceso.hijo.kill('SIGTERM');
      await expect(proceso.cierre).resolves.toBe(proceso);
      expect(proceso.codigo).toBe(0);
    } finally {
      proceso.hijo.kill('SIGKILL');
    }
  });

  it('un hijo colgado → `cierre` RECHAZA con un mensaje claro tras el plazo (con su salida) y el proceso MUERE (SIGKILL)', async () => {
    const inicio = Date.now();
    const proceso = lanzarHijo(['-e', COLGADO], { plazoMs: 400 });
    const error = await proceso.cierre.catch((fallo) => fallo);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/El proceso hijo no terminó en 400 ms y se mató con SIGKILL/);
    expect(Date.now() - inicio).toBeLessThan(5000); // no esperó los 20 s por defecto
    expect(proceso.senal).toBe('SIGKILL');
    const pid = Number(proceso.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true); // control: el hijo sí llegó a arrancar y dijo su pid
    expect(error.message).toContain(`stdout: ${pid}`);
    expect(vive(pid)).toBe(false);
  });

  it('un rechazo por plazo que nadie esperaba no es un «unhandled rejection» que tumbe la prueba siguiente', async () => {
    const proceso = lanzarHijo(['-e', COLGADO], { plazoMs: 200 });
    await new Promise((resolver) => { proceso.hijo.once('close', resolver); }); // el hijo muere por el plazo; nadie leyó `cierre`
    await new Promise((resolver) => { setImmediate(resolver); }); // un rechazo sin manejar se notificaría aquí
    expect(proceso.senal).toBe('SIGKILL');
  });
});
