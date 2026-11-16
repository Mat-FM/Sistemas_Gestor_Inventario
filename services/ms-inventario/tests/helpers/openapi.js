const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { resolverRef } = require('./esquemaOpenapi');

// Acceso al documento openapi.yaml para las pruebas de la documentación (RNF08): lo lee del disco, lo recorre por operaciones y
// resuelve las referencias de parámetros y respuestas. Los esquemas los valida esquemaOpenapi.js.

const RUTA_OPENAPI = path.join(__dirname, '..', '..', 'openapi.yaml');
const METODOS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** El documento tal como lo sirve /docs/openapi.yaml, ya leído. */
function cargarDocumento() {
  return yaml.load(fs.readFileSync(RUTA_OPENAPI, 'utf8'));
}

/** Si el nodo es una referencia (`$ref`), el nodo al que apunta; si no, el mismo nodo. */
const resolver = (documento, nodo) => (nodo && typeof nodo === 'object' && '$ref' in nodo ? resolverRef(documento, nodo.$ref) : nodo);

/**
 * Los parámetros EFECTIVOS de una operación: los de la ruta más los de la operación, ya resueltos, y con el de la operación
 * reemplazando al de la ruta que tenga el mismo nombre y lugar (así lo define OpenAPI). Así una escritura vuelve obligatorias las
 * cabeceras de identidad que la ruta declara como opcionales.
 */
function parametrosEfectivos(documento, itemDeRuta, operacion) {
  const efectivos = new Map();
  for (const parametro of [...(itemDeRuta.parameters ?? []), ...(operacion.parameters ?? [])]) {
    const resuelto = resolver(documento, parametro);
    efectivos.set(`${resuelto.in}:${resuelto.name}`, resuelto);
  }
  return [...efectivos.values()];
}

/**
 * Todas las operaciones del documento: { clave: 'GET /bodegas/{id}', metodo: 'get', ruta, operacion, parametros }.
 * `parametros` son los efectivos (parametrosEfectivos). No incluye la clave `parameters` de la ruta (no es una operación).
 */
function operaciones(documento) {
  return Object.entries(documento.paths).flatMap(([ruta, itemDeRuta]) => Object.keys(itemDeRuta)
    .filter((clave) => METODOS.includes(clave))
    .map((metodo) => ({
      clave: `${metodo.toUpperCase()} ${ruta}`,
      metodo,
      ruta,
      operacion: itemDeRuta[metodo],
      parametros: parametrosEfectivos(documento, itemDeRuta, itemDeRuta[metodo]),
    })));
}

/** La respuesta que la operación declara para ese estado (resuelta), o undefined si no la declara. */
function respuestaDeclarada(documento, operacion, estado) {
  const respuesta = operacion.responses?.[String(estado)];
  return respuesta === undefined ? undefined : resolver(documento, respuesta);
}

/** El esquema JSON de una respuesta o de un cuerpo de petición ya resueltos (application/json), o undefined si no lleva cuerpo. */
const esquemaJson = (contenedor) => contenedor?.content?.['application/json']?.schema;

/** Convierte la ruta de Express (`/bodegas/:id`) a la del documento (`/bodegas/{id}`). */
const aRutaOpenapi = (ruta) => ruta.replace(/:(\w+)/g, '{$1}');

module.exports = { RUTA_OPENAPI, cargarDocumento, resolver, parametrosEfectivos, operaciones, respuestaDeclarada, esquemaJson, aRutaOpenapi };
