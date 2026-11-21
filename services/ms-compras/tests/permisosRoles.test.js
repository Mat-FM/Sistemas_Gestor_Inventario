const fs = require('fs');
const path = require('path');
const { app, request, pool, reiniciarBase } = require('./apoyo');
const { PERMISOS } = require('../src/routes/permisos');
const comprasRutas = require('../src/routes/comprasRutas');

// Defensa de roles dentro del servicio. El Gateway ya comprueba el rol de cada ruta (Tabla 10), pero el servicio no debe depender de que nadie
// le salte el Gateway: cada ruta lleva en src/routes/permisos.js su lista de roles. Estas pruebas comprueban que (1) ninguna ruta se queda
// sin regla, (2) la tabla coincide con la matriz del Gateway y (3) un rol que no corresponde recibe 403 antes de que la ruta haga nada.

const ROLES = ['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'];
const ROL_DE = { ADM: 'ADMINISTRADOR', OPE: 'OPERADOR_BODEGA', VEN: 'VENDEDOR', CON: 'CONTADOR' };
const GATEWAY = path.join(__dirname, '../../../api-gateway/config/gateway_routes.php');

beforeAll(reiniciarBase);
afterAll(() => pool.end());

const declaradas = () => comprasRutas.stack
  .flatMap((capa) => Object.keys(capa.route.methods).map((metodo) => `${metodo.toUpperCase()} ${capa.route.path}`))
  .sort();

describe('la tabla de permisos', () => {
  it('tiene una regla para cada ruta declarada, y ninguna de más', () => {
    expect(Object.keys(PERMISOS).sort()).toEqual(declaradas());
  });

  it('cada regla es null (la aplica solo el Gateway, y se explica) o una lista de roles válidos', () => {
    for (const regla of Object.values(PERMISOS)) {
      if (regla === null) continue;
      expect(regla.length).toBeGreaterThan(0);
      expect(regla.filter((rol) => !ROLES.includes(rol))).toEqual([]);
    }
  });

  (fs.existsSync(GATEWAY) ? it : it.skip)('coincide con la matriz del Gateway; solo se exime lo que ms-reportes lee con la identidad del usuario', () => {
    const fuente = fs.readFileSync(GATEWAY, 'utf8');
    const reglas = [...fuente.matchAll(/\['metodo' => '(\w+)', 'ruta' => '([^']+)', 'servicio' => 'ms-compras', 'roles' => ([^\n]+?)\],?\n/g)];
    expect(reglas).toHaveLength(9);
    const eximidas = [];
    for (const [, metodo, ruta, expresion] of reglas) {
      const roles = expresion.includes('Roles::TODOS') ? [...ROLES] : [...expresion.matchAll(/Roles::(\w+)/g)].map((m) => ROL_DE[m[1]]);
      const local = PERMISOS[`${metodo} /${ruta.replace(/\{(\w+)\}/g, ':$1')}`];
      if (local === null) eximidas.push(`${metodo} ${ruta}`);
      else expect({ ruta: `${metodo} ${ruta}`, roles: [...local].sort() }).toEqual({ ruta: `${metodo} ${ruta}`, roles: [...roles].sort() });
    }
    expect(eximidas).toEqual(['GET ordenes-compra']);
  });
});

describe('un rol sin permiso recibe 403 SIN_PERMISO', () => {
  const casos = Object.entries(PERMISOS).filter(([, roles]) => roles !== null)
    .flatMap(([clave, roles]) => ROLES.map((rol) => [clave, rol, roles.includes(rol)]));

  it.each(casos)('%s con %s → permitido: %s', async (clave, rol, permitido) => {
    const [metodo, ruta] = clave.split(' ');
    const cabeceras = { 'X-User-Id': '7', 'X-User-Rol': rol, ...(rol === 'OPERADOR_BODEGA' ? { 'X-User-Bodega': '1' } : {}) };
    const res = await request(app)[metodo.toLowerCase()](ruta.replace(/:\w+/g, '1')).set(cabeceras).send(metodo === 'GET' ? undefined : {});
    if (permitido) expect(res.status).not.toBe(403);
    else {
      expect(res.status).toBe(403);
      expect(res.body.error.codigo).toBe('SIN_PERMISO');
    }
  });

  it('la lectura que ms-reportes hace con la identidad del contador no se restringe', async () => {
    const res = await request(app).get('/ordenes-compra?estado=ENVIADA').set({ 'X-User-Id': '9', 'X-User-Rol': 'CONTADOR' });
    expect(res.status).toBe(200);
  });

  it('una llamada interna sin identidad lee las órdenes', async () => {
    expect((await request(app).get('/ordenes-compra')).status).toBe(200);
  });
});
