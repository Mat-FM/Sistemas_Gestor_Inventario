const fs = require('node:fs');
const path = require('node:path');

// Documentación OpenAPI del servicio (RNF08): la página de Swagger UI (GET /docs) y el documento openapi.yaml (GET
// /docs/openapi.yaml). Son archivos estáticos que se entregan tal cual, igual que en el API Gateway y en ms-catalogo.
//
// NO forman parte de rutasDeclaradas (routes/index.js): esa lista son las operaciones de negocio, que registrarRutas protege
// exigiendo X-User-Id en las escrituras, y que openapi.yaml debe describir una por una. /docs, como /health, es una ruta del
// propio servicio: no pasa por el Gateway, no usa la base de datos y no exige identidad (un navegador no envía X-User-*), aunque,
// como toda ruta del servicio, una cabecera X-User-* inválida (p. ej. X-User-Id sin X-User-Rol) es 401. Se monta desde app.js.

// Las rutas se resuelven desde este archivo y no desde el directorio de trabajo: el servicio arranca igual desde el contenedor
// (el Dockerfile copia `openapi.yaml` y `src/`) que con `npm start` desde otra carpeta.
const RUTA_OPENAPI = path.join(__dirname, '..', '..', 'openapi.yaml');
const RUTA_PAGINA = path.join(__dirname, '..', 'docs', 'swagger-ui.html');

const TIPO_PAGINA = 'text/html; charset=utf-8';
const TIPO_DOCUMENTO = 'application/yaml; charset=utf-8';

/**
 * Lee la página y el documento UNA vez, al construir la aplicación, y los guarda en memoria (RNF05: nada que cambie entre
 * peticiones). Si falta alguno lanza el error de lectura, con la ruta del archivo: el servicio no arranca en vez de responder
 * 500 en la primera visita a /docs. Los Buffer se envían sin reinterpretarlos, así que el documento sale byte a byte.
 * @param {{rutaOpenapi?: string, rutaPagina?: string}} [rutas] solo las pruebas las cambian
 * @returns {{pagina: Buffer, documento: Buffer}}
 */
function crearRutasDocs({ rutaOpenapi = RUTA_OPENAPI, rutaPagina = RUTA_PAGINA } = {}) {
  return { pagina: fs.readFileSync(rutaPagina), documento: fs.readFileSync(rutaOpenapi) };
}

/**
 * Monta GET /docs y GET /docs/openapi.yaml en `app`. Express solo responde estos dos métodos y rutas: cualquier otro (POST /docs,
 * GET /docs/otra-cosa) sigue su camino hasta el 404 normal del servicio. El Content-Type se fija completo, con el charset, antes de
 * enviar: con un Buffer Express no lo añade por su cuenta.
 */
function montarDocs(app, rutas) {
  const { pagina, documento } = crearRutasDocs(rutas);
  app.get('/docs', (_req, res) => {
    res.set('Content-Type', TIPO_PAGINA).send(pagina);
  });
  app.get('/docs/openapi.yaml', (_req, res) => {
    res.set('Content-Type', TIPO_DOCUMENTO).send(documento);
  });
}

module.exports = { crearRutasDocs, montarDocs };
