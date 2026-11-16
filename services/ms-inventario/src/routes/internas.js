// Rutas internas (`/internas/*`): las llaman solo otros servicios y el Gateway no las publica (RNF09). Hoy, la carga inicial de
// saldos que consume ms-reportes (RF16, D34).

/** Dirección de la carga inicial de saldos (Tabla 9): la declara la ruta y la usa app.js para montar su analizador de cuerpo. */
const RUTA_CARGA_INICIAL = '/internas/saldos/carga-inicial';

/**
 * Tamaño máximo del cuerpo de la carga inicial (D34(c)). Una fila ocupa ~110 bytes y la carga admite 1 000 filas: con los 100 kB
 * del resto de las rutas (D18) solo cabrían ~900. Es el límite de `express.json`, que lo lee como bytes (1 MiB).
 */
const LIMITE_CUERPO_CARGA_INICIAL = '1mb';

module.exports = { RUTA_CARGA_INICIAL, LIMITE_CUERPO_CARGA_INICIAL };
