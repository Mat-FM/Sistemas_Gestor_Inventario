const crypto = require('node:crypto');

// Un X-Request-Id ajeno acaba en cada línea del registro y en una cabecera de respuesta: solo se acepta con un formato
// acotado (los UUID del Gateway y los identificadores de traza habituales lo cumplen).
const FORMATO_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Identificador de la petición: el X-Request-Id del cliente si es válido y, si no, un UUID nuevo.
 * Se resuelve una sola vez por petición (queda en req.requestId), así que requestLog e identity comparten el mismo.
 */
function resolverRequestId(req) {
  if (req.requestId === undefined) {
    const entrante = req.headers['x-request-id'];
    req.requestId = typeof entrante === 'string' && FORMATO_REQUEST_ID.test(entrante) ? entrante : crypto.randomUUID();
  }
  return req.requestId;
}

// Ruta de la petición sin la cadena de consulta (que puede llevar datos del cliente).
function rutaDe(req) {
  return req.originalUrl.split('?')[0];
}

module.exports = { resolverRequestId, rutaDe };
