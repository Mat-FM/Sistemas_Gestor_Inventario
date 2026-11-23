const fs = require('fs');
const path = require('path');
const { buildTestApp } = require('./helpers/app');
const { headers } = require('./helpers/fixtures');
const { esError } = require('./helpers/respuestas');
const { rutasDeclaradas } = require('../src/routes');
const { PERMISOS } = require('../src/routes/permisos');
const { ROLES } = require('../src/middleware/identity');

// Defensa de roles dentro del servicio (D37). El Gateway ya comprueba el rol de cada ruta (matriz de la Tabla 9), pero el servicio no
// debe depender de que nadie le salte el Gateway: cada ruta lleva aquí su lista de roles. Estas pruebas comprueban que (1) ninguna ruta
// se queda sin regla, (2) la tabla coincide con la matriz del Gateway y (3) un rol que no corresponde recibe 403 antes de que la
// ruta haga nada.

const ADM = 'ADMINISTRADOR';
const OPE = 'OPERADOR_BODEGA';
const GATEWAY = path.join(__dirname, '../../../api-gateway/config/gateway_routes.php');
const ROL_DE = { ADM, OPE, VEN: 'VENDEDOR', CON: 'CONTADOR' };

let request;
let db;
beforeAll(() => {
  ({ request, db } = buildTestApp());
});
afterAll(() => db.destroy());

const clave = (metodo, ruta) => `${metodo.toUpperCase()} ${ruta}`;
const rutas = () => rutasDeclaradas({}).map(({ metodo, ruta }) => ({ metodo, ruta, clave: clave(metodo, ruta) }));

describe('la tabla de permisos', () => {
  it('tiene una regla para cada ruta declarada, y ninguna de más', () => {
    expect(Object.keys(PERMISOS).sort()).toEqual(rutas().map((r) => r.clave).sort());
  });

  it('cada regla es null (la aplica solo el Gateway, y dice por qué) o una lista de roles válidos', () => {
    for (const [ruta, regla] of Object.entries(PERMISOS)) {
      if (regla === null) continue;
      expect(regla.length).toBeGreaterThan(0);
      for (const rol of regla) expect({ ruta, rol, valido: ROLES.includes(rol) }).toEqual({ ruta, rol, valido: true });
    }
  });

  // La matriz del Gateway (api-gateway/config/gateway_routes.php, las 23 reglas de ms-inventario) es la autoridad: la tabla del servicio
  // solo puede ser igual o, en las lecturas que otros servicios hacen con la identidad del usuario, no aplicarse.
  const hayGateway = fs.existsSync(GATEWAY);
  (hayGateway ? it : it.skip)('coincide con la matriz del Gateway; solo se exime lo que leen ms-reportes y ms-notificaciones', () => {
    const fuente = fs.readFileSync(GATEWAY, 'utf8');
    const reglas = [...fuente.matchAll(/\['metodo' => '(\w+)', 'ruta' => '([^']+)', 'servicio' => 'ms-inventario', 'roles' => ([^\n]+?)\],?\n/g)];
    expect(reglas).toHaveLength(23);
    const eximidas = [];
    for (const [, metodo, ruta, expresion] of reglas) {
      const roles = expresion.includes('Roles::TODOS') ? [...ROLES] : [...expresion.matchAll(/Roles::(\w+)/g)].map((m) => ROL_DE[m[1]]);
      const local = PERMISOS[clave(metodo, `/${ruta.replace(/\{(\w+)\}/g, ':$1')}`)];
      if (local === null) eximidas.push(clave(metodo, ruta));
      else expect({ ruta: clave(metodo, ruta), roles: [...local].sort() }).toEqual({ ruta: clave(metodo, ruta), roles: [...roles].sort() });
    }
    expect(eximidas.sort()).toEqual(['GET lotes', 'GET saldos/bajo-umbral']);
  });
});

// Una petición por ruta con identificadores y cuerpo que valen para llegar hasta la regla de roles: lo que pase después (404, 422…) no
// importa, solo que un rol sin permiso reciba 403 SIN_PERMISO y uno con permiso no.
const concreta = (ruta) => ruta.replace(/:\w+/g, '1');
const lanzar = (metodo, ruta, rol) => {
  const cabeceras = { ...headers(rol, { idBodega: rol === OPE ? 1 : undefined }), 'Idempotency-Key': `permiso-${metodo}-${ruta}-${rol}` };
  return request[metodo](concreta(ruta)).set(cabeceras).send(metodo === 'get' ? undefined : {});
};

describe('un rol sin permiso recibe 403 SIN_PERMISO', () => {
  const casos = [];
  for (const { clave: k } of rutas()) {
    const permitidos = PERMISOS[k];
    if (permitidos === null) continue;
    for (const rol of ROLES) casos.push([k, rol, permitidos.includes(rol)]);
  }

  it.each(casos)('%s con %s → permitido: %s', async (k, rol, permitido) => {
    const [metodo, ruta] = k.split(' ');
    const res = await lanzar(metodo.toLowerCase(), ruta, rol);
    if (permitido) expect(res.status).not.toBe(403);
    else esError(res, 403, 'SIN_PERMISO');
  });
});

describe('lo que otros servicios leen con la identidad del usuario no se restringe aquí', () => {
  it('un CONTADOR (reportes del panel) puede leer saldos/bajo-umbral y lotes', async () => {
    for (const ruta of ['/saldos/bajo-umbral', '/lotes']) {
      const res = await request.get(ruta).set(headers('CONTADOR'));
      expect({ ruta, estado: res.status }).toEqual({ ruta, estado: 200 });
    }
  });

  it('una llamada interna sin identidad lee lotes sin rol', async () => {
    expect((await request.get('/lotes')).status).toBe(200);
  });
});
