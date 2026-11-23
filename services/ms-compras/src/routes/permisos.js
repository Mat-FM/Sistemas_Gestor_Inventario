// Quién puede llamar a cada ruta. Es la misma matriz que aplica el Gateway (Tabla 10 de la Entrega 2, api-gateway/config/gateway_routes.php),
// repetida aquí para que el servicio no dependa de que nadie le salte el Gateway (defensa en profundidad, RNF07, RNF09): un rol que no figura
// recibe 403 SIN_PERMISO antes de que la ruta haga nada. tests/permisosRoles.test.js exige una entrada por cada ruta y la compara con la del
// Gateway.
//
// `null` = no se restringe aquí y solo la aplica el Gateway. Es la lectura de órdenes que ms-reportes hace con la identidad del usuario que
// pidió el panel de indicadores (un CONTADOR), mientras que el Gateway solo deja entrar a ADMINISTRADOR y OPERADOR_BODEGA: restringirla
// aquí rompería el panel. Una petición sin usuario es una llamada interna y tampoco se restringe nunca.
const ADM = 'ADMINISTRADOR';
const OPE = 'OPERADOR_BODEGA';

const PERMISOS = Object.freeze({
  'GET /ordenes-compra': null,
  'GET /ordenes-compra/:id': [ADM, OPE],
  'POST /ordenes-compra': [ADM],
  'PUT /ordenes-compra/:id': [ADM],
  'PATCH /ordenes-compra/:id/estado': [ADM],
  'POST /ordenes-compra/:id/recepciones': [ADM, OPE],
  'GET /ordenes-compra/:id/recepciones': [ADM, OPE],
  'POST /devoluciones-proveedor': [ADM, OPE],
  'GET /devoluciones-proveedor': [ADM, OPE],
});

module.exports = { PERMISOS };
