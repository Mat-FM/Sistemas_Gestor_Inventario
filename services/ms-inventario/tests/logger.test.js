const request = require('supertest');
const { createApp } = require('../src/app');
const { logger } = require('../src/logger');

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
  });
});
