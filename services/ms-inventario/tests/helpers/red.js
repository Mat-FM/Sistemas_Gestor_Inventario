// Peticiones HTTP de las pruebas a un servidor que la propia prueba cierra después.
//
// El `fetch` de Node comparte un depósito de conexiones keep-alive entre TODAS las peticiones del proceso. Una petición normal deja
// su conexión abierta y disponible para la siguiente petición al mismo host y puerto; si el servidor se cierra y otro escucha
// luego en ese mismo puerto (startup.test.js reutiliza uno para todas sus pruebas), la siguiente petición puede reutilizar la
// conexión del servidor ya cerrado y falla con `TypeError: fetch failed` / `read ECONNRESET`, de forma intermitente (entre 1 de
// cada 25 y 1 de cada 6 corridas de startup.test.js, según la carga del equipo). No es un fallo del servicio: es la conexión de una
// prueba anterior.
//
// `pedir` hace la petición con `Connection: close`: la conexión se cierra al terminar la respuesta y no queda nada que reutilizar.
// Úsese en toda petición a un servidor que luego se cierra y cuyo puerto puede volver a usarse. Una petición a un servidor que
// vive toda la prueba (limiteCuerpo.test.js, errors.test.js) puede seguir usando `fetch` tal cual: su puerto no se reutiliza.

/**
 * `fetch` sin conexión keep-alive.
 * @param {string} url
 * @param {{headers?: Record<string, string>}} [opciones] las de `fetch`; `headers` debe ser un objeto simple, no una instancia de Headers
 * @returns {Promise<Response>}
 */
function pedir(url, opciones = {}) {
  return fetch(url, { ...opciones, headers: { ...opciones.headers, connection: 'close' } });
}

module.exports = { pedir };
