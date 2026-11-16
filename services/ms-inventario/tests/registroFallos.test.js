const { ejecutarEnPeticion, logger } = require('../src/logger');
const { registrarFallo } = require('../src/services/registroFallos');
const { capturarStdout } = require('./helpers/stdout');

// registrarFallo: el ÚNICO helper con el que los servicios registran un fallo que no debe cambiar su respuesta (el aviso de
// stock bajo de movimientoService, el umbral tras aprobar un conteo). Lo usan movimientoService y conteoService.

describe('registrarFallo', () => {
  it('registra con logger.error el registro más `error` como { nombre, mensaje, pila } (nunca el objeto Error crudo)', () => {
    /* Un Error crudo saldría como {} al serializarlo. */
    const error = jest.fn();
    const fallo = new TypeError('se rompió');
    registrarFallo({ error }, { mensaje: 'No se pudo avisar', id_producto: 5 }, fallo);
    expect(error).toHaveBeenCalledTimes(1);
    const [registro] = error.mock.calls[0];
    expect(registro).toEqual({ mensaje: 'No se pudo avisar', id_producto: 5, error: { nombre: 'TypeError', mensaje: 'se rompió', pila: fallo.stack } });
    expect(registro.error).not.toBeInstanceOf(Error);
    expect(Object.values(registro).some((valor) => valor instanceof Error)).toBe(false);
  });

  it('con el logger real, la línea lleva el request_id de la petición en curso', () => {
    /* D19: el contexto lo añade el logger. */
    const salida = capturarStdout();
    try {
      ejecutarEnPeticion('req-fallo-1', () => registrarFallo(logger, { mensaje: 'falló el aviso' }, new Error('x')));
      expect(salida.lineas()).toEqual([expect.objectContaining({
        mensaje: 'falló el aviso', nivel: 'error', request_id: 'req-fallo-1', error: expect.objectContaining({ nombre: 'Error', mensaje: 'x' }),
      })]);
    } finally {
      salida.restaurar();
    }
  });

  it('nunca lanza: ni si logger.error lanza, ni sin logger, ni con un error que no es un Error', () => {
    /* Registrar es secundario: nunca cambia la respuesta de quien lo llama. */
    const roto = { error: jest.fn(() => { throw new Error('logger roto'); }) };
    expect(() => registrarFallo(roto, { mensaje: 'm' }, new Error('y'))).not.toThrow();
    expect(roto.error).toHaveBeenCalledTimes(1);
    expect(() => registrarFallo(undefined, { mensaje: 'm' }, new Error('y'))).not.toThrow();
    const error = jest.fn();
    registrarFallo({ error }, { mensaje: 'm' }, 'texto');
    expect(error).toHaveBeenCalledWith({ mensaje: 'm', error: { nombre: 'string', mensaje: 'texto' } });
  });
});
