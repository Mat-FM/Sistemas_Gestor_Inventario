// Aserciones sobre las respuestas de la API, compartidas por las suites de los recursos: ÚNICA fuente de estos helpers.
// Forma de todo error: {"error": {"codigo", "mensaje", "detalles"}}.

// Un mensaje de error útil: al menos un carácter que no sea espacio. (No es el validador `texto` de src/http/validate.js.)
const NO_VACIO = /\S/;

// Fecha ISO 8601 en UTC con milisegundos, como la serializa JSON.stringify(Date): 2026-11-15T10:00:00.000Z.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Exige el estado, el código y la forma exacta del cuerpo de error; `campos` son los de `detalles`, en orden. */
function esError(res, status, codigo, campos = []) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { codigo, mensaje: expect.stringMatching(NO_VACIO), detalles: campos.map((campo) => ({ campo, mensaje: expect.stringMatching(NO_VACIO) })) },
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

module.exports = { ISO_8601, esError, datosNoValidos, recursoNoExiste, rutaNoExiste };
