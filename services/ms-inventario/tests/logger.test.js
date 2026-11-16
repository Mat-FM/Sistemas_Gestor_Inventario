const request = require('supertest');
const { createApp } = require('../src/app');
const { ejecutarEnPeticion, logger, requestIdActual } = require('../src/logger');

describe('logger', () => {
  let escritura;
  beforeEach(() => {
    escritura = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => escritura.mockRestore());

  const lineas = () => escritura.mock.calls.map(([texto]) => texto);

  it('escribe un registro JSON por línea con el servicio, el nivel y los campos recibidos', () => {
    logger.info({ mensaje: 'hola', puerto: 3000 });
    logger.error({ mensaje: 'falla' });
    const [info, error] = lineas();
    expect(info.endsWith('\n')).toBe(true);
    expect(JSON.parse(info)).toEqual({ servicio: 'ms-inventario', nivel: 'info', mensaje: 'hola', puerto: 3000 });
    expect(JSON.parse(error)).toEqual({ servicio: 'ms-inventario', nivel: 'error', mensaje: 'falla' });
  });

  it('los campos fijos servicio y nivel no se pueden sobrescribir desde el registro', () => {
    logger.info({ servicio: 'otro-servicio', nivel: 'debug', mensaje: 'x' });
    logger.error({ servicio: 'otro-servicio', nivel: 'debug', mensaje: 'y' });
    const [info, error] = lineas().map((linea) => JSON.parse(linea));
    expect(info).toEqual({ servicio: 'ms-inventario', nivel: 'info', mensaje: 'x' });
    expect(error).toEqual({ servicio: 'ms-inventario', nivel: 'error', mensaje: 'y' });
  });

  describe('request_id del contexto de la petición (D19)', () => {
    const registros = () => lineas().map((linea) => JSON.parse(linea));

    it('dentro de ejecutarEnPeticion toda línea (info o error) lleva el request_id; fuera no lleva ninguno', () => {
      logger.info({ mensaje: 'antes' });
      ejecutarEnPeticion('id-1', () => {
        logger.info({ mensaje: 'dentro' });
        logger.error({ mensaje: 'dentro con error' });
      });
      logger.info({ mensaje: 'despues' });
      const [antes, dentro, dentroError, despues] = registros();
      expect(antes).not.toHaveProperty('request_id');
      expect(dentro.request_id).toBe('id-1');
      expect(dentroError.request_id).toBe('id-1');
      expect(despues).not.toHaveProperty('request_id');
    });

    it('el contexto sobrevive a un await y a un temporizador', async () => {
      await ejecutarEnPeticion('id-2', async () => {
        await new Promise((resolver) => setTimeout(resolver, 5));
        logger.info({ mensaje: 'tras el await' });
        expect(requestIdActual()).toBe('id-2');
      });
      expect(registros()[0].request_id).toBe('id-2');
      expect(requestIdActual()).toBeUndefined();
    });

    it('dos contextos concurrentes no se mezclan', async () => {
      const tarea = (id, espera) =>
        ejecutarEnPeticion(id, async () => {
          await new Promise((resolver) => setTimeout(resolver, espera));
          logger.info({ mensaje: id });
        });
      await Promise.all([tarea('lento', 30), tarea('rapido', 2)]);
      for (const registro of registros()) expect(registro.request_id).toBe(registro.mensaje);
    });

    it('un request_id explícito en el registro prevalece sobre el del contexto (el contexto solo rellena lo que falta)', () => {
      ejecutarEnPeticion('del-contexto', () => logger.info({ mensaje: 'x', request_id: 'explicito' }));
      expect(registros()[0].request_id).toBe('explicito');
    });
  });

  // Ruling 13: el logger NUNCA lanza, sea cual sea el contenido del registro o el estado de stdout. Una línea sigue siendo
  // una línea (un solo \n, al final) y JSON válido, también la de respaldo.
  describe('el logger nunca lanza ante registros o escrituras problemáticas (Ruling 13)', () => {
    const RESPALDO = 'registro_no_serializable';
    // Texto que solo existe en el contenido que falla: la línea de respaldo no debe volcarlo.
    const CANARIO = 'contenido-sensible-canario-77';

    // Cada línea escrita es JSON válido y ocupa exactamente una línea (un único \n, el final).
    const unaLineaJson = (texto) => {
      expect(texto.endsWith('\n')).toBe(true);
      expect(texto.slice(0, -1)).not.toContain('\n');
      return JSON.parse(texto);
    };
    const unica = () => {
      expect(lineas()).toHaveLength(1);
      return unaLineaJson(lineas()[0]);
    };

    describe('valores que JSON.stringify no sabe escribir, pero que se pueden representar', () => {
      it('un BigInt se registra como texto', () => {
        expect(() => logger.info({ mensaje: 'x', cantidad: 10n, anidado: { total: 2n ** 70n }, lista: [1n] })).not.toThrow();
        expect(unica()).toEqual({
          servicio: 'ms-inventario',
          nivel: 'info',
          mensaje: 'x',
          cantidad: '10',
          anidado: { total: (2n ** 70n).toString() },
          lista: ['1'],
        });
      });

      it('un objeto circular se registra con "[Circular]" en el punto del ciclo y conserva el resto', () => {
        const objeto = { nombre: 'a' };
        objeto.yo = objeto;
        const lista = [1];
        lista.push(lista);
        expect(() => logger.error({ mensaje: 'ciclo', objeto, lista })).not.toThrow();
        expect(unica()).toEqual({
          servicio: 'ms-inventario',
          nivel: 'error',
          mensaje: 'ciclo',
          objeto: { nombre: 'a', yo: '[Circular]' },
          lista: [1, '[Circular]'],
        });
      });

      it('un ciclo indirecto (a -> b -> a) también se detecta', () => {
        const a = { id: 'a' };
        const b = { id: 'b', de: a };
        a.hacia = b;
        logger.info({ a });
        expect(unica().a).toEqual({ id: 'a', hacia: { id: 'b', de: '[Circular]' } });
      });

      it('una referencia compartida que NO es un ciclo se escribe completa las dos veces', () => {
        const compartido = { id: 1 };
        logger.info({ primero: compartido, segundo: compartido, lista: [compartido, compartido], profundo: { otra: compartido } });
        expect(unica()).toMatchObject({
          primero: { id: 1 },
          segundo: { id: 1 },
          lista: [{ id: 1 }, { id: 1 }],
          profundo: { otra: { id: 1 } },
        });
      });

      it('el estado del detector no pasa de una llamada a otra (el mismo objeto sale completo en la siguiente)', () => {
        const objeto = { id: 1 };
        logger.info({ objeto });
        logger.info({ objeto });
        expect(lineas().map((texto) => unaLineaJson(texto).objeto)).toEqual([{ id: 1 }, { id: 1 }]);
      });

      it('las cadenas con saltos de línea no rompen la línea', () => {
        logger.info({ mensaje: 'uno\ndos\r\ntres', cantidad: 3n });
        expect(unica().mensaje).toBe('uno\ndos\r\ntres');
      });
    });

    describe('registros que no se pueden serializar → línea mínima de respaldo', () => {
      it.each([
        ['un toJSON anidado que lanza', () => ({ mensaje: CANARIO, detalle: { toJSON() { throw new Error('toJSON falla'); } } })],
        ['un getter anidado que lanza', () => ({ mensaje: CANARIO, detalle: { get explota() { throw new Error('getter falla'); } } })],
        ['el propio registro con un getter que lanza', () => ({ mensaje: CANARIO, get explota() { throw new Error('getter falla'); } })],
        ['el propio registro con un toJSON que lanza', () => ({ mensaje: CANARIO, toJSON() { throw new Error('toJSON falla'); } })],
        ['el propio registro con un toJSON que no devuelve texto serializable', () => ({ mensaje: CANARIO, toJSON: () => undefined })],
        ['un objeto tan profundo que desborda la pila', () => {
          let profundo = { mensaje: CANARIO };
          for (let i = 0; i < 50000; i += 1) profundo = { hijo: profundo };
          return { mensaje: CANARIO, profundo };
        }],
      ])('%s', (_descripcion, crear) => {
        expect(() => logger.info(crear())).not.toThrow();
        const linea = unica();
        expect(linea).toEqual({ aviso: RESPALDO, servicio: 'ms-inventario', nivel: 'info' });
        expect(lineas()[0]).not.toContain(CANARIO);
      });

      it('conserva el nivel de la llamada y no deja que el registro sobrescriba servicio ni nivel', () => {
        logger.error({ servicio: 'otro', nivel: 'debug', toJSON() { throw new Error('falla'); } });
        expect(unica()).toEqual({ aviso: RESPALDO, servicio: 'ms-inventario', nivel: 'error' });
      });

      it('lleva el request_id de la petición en curso', () => {
        ejecutarEnPeticion('id-respaldo', () => logger.info({ detalle: { toJSON() { throw new Error('falla'); } } }));
        expect(unica()).toEqual({ aviso: RESPALDO, servicio: 'ms-inventario', nivel: 'info', request_id: 'id-respaldo' });
      });

      it('lleva el request_id explícito del registro cuando es texto (aunque no haya contexto)', () => {
        logger.info({ request_id: 'explicito-1', detalle: { toJSON() { throw new Error('falla'); } } });
        expect(unica()).toEqual({ aviso: RESPALDO, servicio: 'ms-inventario', nivel: 'info', request_id: 'explicito-1' });
      });

      it('el request_id explícito prevalece sobre el del contexto también en la línea de respaldo', () => {
        ejecutarEnPeticion('del-contexto', () => logger.info({ request_id: 'explicito-2', detalle: { toJSON() { throw new Error('falla'); } } }));
        expect(unica().request_id).toBe('explicito-2');
      });

      it('si el propio request_id del registro es un getter que lanza, usa el del contexto y no lanza', () => {
        const registro = { get request_id() { throw new Error('getter falla'); } };
        expect(() => ejecutarEnPeticion('del-contexto', () => logger.info(registro))).not.toThrow();
        expect(unica()).toEqual({ aviso: RESPALDO, servicio: 'ms-inventario', nivel: 'info', request_id: 'del-contexto' });
      });

      it('un request_id explícito que no es texto no se vuelca: se usa el del contexto', () => {
        ejecutarEnPeticion('del-contexto', () => logger.info({ request_id: { toJSON() { throw new Error('falla'); } } }));
        expect(unica().request_id).toBe('del-contexto');
      });

      it('sin contexto ni request_id la línea de respaldo no trae request_id', () => {
        logger.info({ detalle: { toJSON() { throw new Error('falla'); } } });
        expect(unica()).not.toHaveProperty('request_id');
      });
    });

    describe('fallos de escritura en stdout', () => {
      it('una escritura que lanza no se propaga', () => {
        escritura.mockImplementation(() => {
          throw new Error('write EPIPE');
        });
        expect(() => logger.info({ mensaje: 'x' })).not.toThrow();
        expect(() => logger.error({ mensaje: 'y' })).not.toThrow();
        expect(escritura).toHaveBeenCalledTimes(2);
      });

      it('un evento "error" de stdout (el EPIPE real llega así, de forma asíncrona) no tumba el proceso', () => {
        logger.info({ mensaje: 'x' });
        // Sin un listener de 'error', emit lanza y en un proceso real sería una excepción no capturada.
        expect(() => process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
      });

      it('cargar el logger varias veces (otro registro de módulos) no acumula listeners en stdout', () => {
        logger.info({ mensaje: 'x' });
        const antes = process.stdout.listenerCount('error');
        for (let i = 0; i < 12; i += 1) {
          jest.isolateModules(() => require('../src/logger'));
        }
        expect(process.stdout.listenerCount('error')).toBe(antes);
      });
    });
  });

  it('es el logger que usa la aplicación cuando no se inyecta otro (el aviso del 503 de /health queda registrado)', async () => {
    const app = createApp({ env: { DB_HOST: 'host-centinela.interno', MS_CATALOGO_URL: 'catalogo-centinela' } });
    const res = await request(app).get('/health');
    const [linea] = lineas();
    const registro = JSON.parse(linea);
    expect(res.status).toBe(503);
    expect(registro).toMatchObject({ servicio: 'ms-inventario', nivel: 'error', invalidas: ['MS_CATALOGO_URL'] });
    expect(registro.faltantes).toEqual(['DB_PORT', 'DB_NAME', 'DB_USER', 'MS_NOTIFICACIONES_URL']);
    expect(linea).not.toContain('host-centinela.interno');
    expect(linea).not.toContain('catalogo-centinela');
    // El aviso de configuración lleva el request_id de la petición (D19).
    expect(registro.request_id).toBe(res.headers['x-request-id']);
  });

  it('con el logger por defecto, /health no escribe la línea de la petición (Ruling 11) y una petición normal sí, con su request_id', async () => {
    const app = createApp({ env: { DB_HOST: 'host-centinela.interno' } });
    const sonda = await request(app).get('/health');
    const normal = await request(app).get('/no-existe');
    // La línea de la petición sale al cerrarse la respuesta: se espera a la de la petición normal antes de soltar el espía.
    const limite = Date.now() + 1000;
    while (!lineas().some((linea) => linea.includes('"ruta":"/no-existe"')) && Date.now() < limite) {
      await new Promise((resolver) => setTimeout(resolver, 5));
    }
    const registros = lineas().map((linea) => JSON.parse(linea));
    expect(sonda.status).toBe(503);
    expect(registros.filter((registro) => registro.ruta === '/health')).toEqual([]);
    expect(registros.filter((registro) => registro.nivel === 'error')).toHaveLength(1); // el aviso de configuración
    const peticion = registros.find((registro) => registro.ruta === '/no-existe');
    expect(peticion).toMatchObject({ servicio: 'ms-inventario', nivel: 'info', metodo: 'GET', estado: 404 });
    expect(peticion.request_id).toBe(normal.headers['x-request-id']);
  });
});
