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

  it('es el logger que usa la aplicación cuando no se inyecta otro (el 503 de /health queda registrado)', async () => {
    const app = createApp({ env: { DB_HOST: 'host-centinela.interno', MS_CATALOGO_URL: 'catalogo-centinela' } });
    const res = await request(app).get('/health');
    const [linea] = lineas();
    const registro = JSON.parse(linea);
    expect(res.status).toBe(503);
    expect(registro).toMatchObject({ servicio: 'ms-inventario', nivel: 'error', invalidas: ['MS_CATALOGO_URL'] });
    expect(registro.faltantes).toEqual(['DB_PORT', 'DB_NAME', 'DB_USER', 'MS_NOTIFICACIONES_URL']);
    expect(linea).not.toContain('host-centinela.interno');
    expect(linea).not.toContain('catalogo-centinela');

    // Con el logger por defecto, el aviso de configuración y la línea de la petición llevan el mismo request_id.
    // La línea de la petición sale al cerrarse la respuesta: se espera antes de soltar el espía.
    const limite = Date.now() + 1000;
    while (lineas().length < 2 && Date.now() < limite) await new Promise((resolver) => setTimeout(resolver, 5));
    const peticion = JSON.parse(lineas()[1]);
    expect(peticion).toMatchObject({ servicio: 'ms-inventario', nivel: 'info', metodo: 'GET', ruta: '/health', estado: 503 });
    expect(registro.request_id).toBe(res.headers['x-request-id']);
    expect(peticion.request_id).toBe(res.headers['x-request-id']);
  });
});
