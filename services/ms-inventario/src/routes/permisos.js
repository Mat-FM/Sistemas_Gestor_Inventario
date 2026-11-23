'use strict';

// Quién puede llamar a cada ruta (D37). Es la misma matriz que aplica el Gateway (Tabla 9 de la Entrega 2, api-gateway/config/gateway_routes.php),
// repetida aquí para que el servicio no dependa de que nadie le salte el Gateway (defensa en profundidad, RNF07, RNF09): un rol que no
// figura recibe 403 SIN_PERMISO antes de que la ruta haga nada. tests/permisosRoles.test.js la compara con la del Gateway y exige que
// cada ruta declarada tenga su entrada, así que una ruta nueva no puede quedar sin regla.
//
// `null` = no se restringe aquí y solo la aplica el Gateway. Son las dos lecturas que ms-reportes hace con la identidad del usuario que
// pidió el reporte (el panel de indicadores lo ve el CONTADOR, y el Gateway solo deja leer a ADMINISTRADOR y OPERADOR_BODEGA estas rutas):
// restringirlas rompería el panel. Una llamada interna sin X-User-Rol (D8) tampoco se restringe nunca.

const ADM = 'ADMINISTRADOR';
const OPE = 'OPERADOR_BODEGA';
const VEN = 'VENDEDOR';
const CON = 'CONTADOR';
const TODOS = [ADM, OPE, VEN, CON];

const PERMISOS = Object.freeze({
  'GET /bodegas': TODOS,
  'GET /bodegas/:id': TODOS,
  'POST /bodegas': [ADM],
  'PUT /bodegas/:id': [ADM],
  'POST /bodegas/:id/inactivar': [ADM],
  'POST /bodegas/:id/activar': [ADM],
  'GET /saldos': TODOS,
  'GET /saldos/bajo-umbral': null, // el panel de indicadores de ms-reportes, con la identidad del contador
  'GET /umbrales': [ADM],
  'PUT /umbrales/:id_producto': [ADM],
  'POST /movimientos': [ADM, OPE],
  'GET /movimientos': [ADM, CON, OPE],
  'GET /movimientos/:id': [ADM, CON, OPE],
  'GET /lotes': null, // lotes por vencer del panel de indicadores de ms-reportes, con la identidad del contador
  'GET /lotes/sugerencia-salida': [ADM, OPE],
  'POST /traslados': [ADM, OPE],
  'GET /traslados': [ADM, OPE],
  'POST /traslados/:id/recepcion': [ADM, OPE],
  'POST /conteos': [ADM],
  'GET /conteos': [ADM, OPE],
  'GET /conteos/:id': [ADM, OPE],
  'PUT /conteos/:id/detalles': [ADM, OPE],
  'POST /conteos/:id/aprobacion': [ADM],
  // Ruta interna de ms-reportes (no pasa por el Gateway): importar stock inicial es de ADMINISTRADOR, y ms-reportes reenvía su identidad.
  'POST /internas/saldos/carga-inicial': [ADM],
});

module.exports = { PERMISOS };
