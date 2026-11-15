const { requireUser } = require('../middleware/identity');
const { rutasBodegas } = require('./bodegas');

// Rutas de negocio del servicio: una única fuente de verdad. registrarRutas las monta y la Tarea 14 comprueba contra ella
// que cada ruta esté en el OpenAPI. Cada tarea nueva añade aquí su módulo (saldos, movimientos, lotes, traslados, conteos…).

/**
 * Todas las rutas de negocio. Excluye /health y /docs*, que no pasan por el Gateway y se montan aparte en app.js.
 * Cada entrada es { metodo, ruta, handler }:
 * - metodo: en minúsculas ('get', 'post', 'put'…), tal como lo nombra Express y las claves del OpenAPI.
 * - ruta: en sintaxis de Express ('/bodegas/:id'); para el OpenAPI hay que convertir ':id' en '{id}'.
 * - handler: el controlador, sin envolver (la identidad la añade registrarRutas).
 * `deps` = { db, clients, logger }. No abre conexiones, así que se puede llamar sin dependencias (`rutasDeclaradas()`).
 */
function rutasDeclaradas(deps = {}) {
  return [
    ...rutasBodegas(deps),
  ];
}

// Toda escritura exige un usuario (D8, D22): cada cambio guarda su autor (RF10). Las lecturas (GET) son válidas sin
// X-User-Id: son las llamadas internas de ms-reportes y ms-notificaciones. Se aplica aquí, en un solo sitio, para que
// ninguna ruta nueva pueda olvidarlo; routes.test.js lo comprueba con TODAS las rutas declaradas.
function exigirUsuario(req, _res, next) {
  requireUser(req.identity);
  next();
}

/** Monta en `app` las rutas de rutasDeclaradas(deps). Debe llamarse después de `identity` y antes del 404. */
function registrarRutas(app, deps) {
  for (const { metodo, ruta, handler } of rutasDeclaradas(deps)) {
    const cadena = metodo === 'get' ? [handler] : [exigirUsuario, handler];
    app[metodo](ruta, ...cadena);
  }
}

module.exports = { registrarRutas, rutasDeclaradas };
