// Aserciones sobre las respuestas de error comunes de la API, compartidas por las suites de los recursos.
// Forma de todo error: {"error": {"codigo", "mensaje", "detalles"}}.

const texto = /\S/;

/** Exige el estado, el código y la forma exacta del cuerpo de error; `campos` son los de `detalles`, en orden. */
function esError(res, status, codigo, campos = []) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { codigo, mensaje: expect.stringMatching(texto), detalles: campos.map((campo) => ({ campo, mensaje: expect.stringMatching(texto) })) },
  });
}

/** 422 DATOS_NO_VALIDOS con un detalle por cada campo de `campos`, en ese orden. */
const datosNoValidos = (res, campos) => esError(res, 422, 'DATOS_NO_VALIDOS', campos);

/**
 * 404 NO_EXISTE de un RECURSO (un id inexistente o inválido). Se distingue del 404 de una ruta que no está montada
 * (rutaNoEncontrada: «La ruta solicitada no existe»), que sin esto haría pasar la prueba aunque no hubiera rutas.
 */
function recursoNoExiste(res) {
  esError(res, 404, 'NO_EXISTE');
  expect(res.body.error.mensaje).not.toBe('La ruta solicitada no existe');
}

/** 404 NO_EXISTE de una ruta que el servicio no declara. */
function rutaNoExiste(res) {
  esError(res, 404, 'NO_EXISTE');
  expect(res.body.error.mensaje).toBe('La ruta solicitada no existe');
}

module.exports = { esError, datosNoValidos, recursoNoExiste, rutaNoExiste };
