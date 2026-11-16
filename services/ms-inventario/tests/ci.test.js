const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { VARIABLES_OBLIGATORIAS, cargarConfig, validarEntorno } = require('../src/config/env');
const { verificarBaseDePrueba } = require('./helpers/db');

// Guarda estática de la integración continua (RNF20): comprueba que .github/workflows/ci-ms-inventario.yml dice lo que el
// servicio necesita para que sus pruebas corran en un GitHub Actions limpio. No ejecuta el workflow (la primera ejecución real
// ocurre en el primer pull request); lo que sí hace es armar con el `env:` del paso de pruebas el MISMO entorno que verá el
// proceso y pasárselo al propio código del servicio (validarEntorno, cargarConfig, la guardia D21), de modo que una variable
// nueva que el servicio exija y el workflow no dé hace fallar esta prueba.

const RAIZ_SERVICIO = path.join(__dirname, '..');
const RAIZ_REPOSITORIO = path.join(RAIZ_SERVICIO, '..', '..');
const RUTA_WORKFLOW = path.join(RAIZ_REPOSITORIO, '.github', 'workflows', 'ci-ms-inventario.yml');
const DIRECTORIO_SERVICIO = 'services/ms-inventario';

const leerWorkflow = () => yaml.load(fs.readFileSync(RUTA_WORKFLOW, 'utf8'));
const leerPaquete = () => JSON.parse(fs.readFileSync(path.join(RAIZ_SERVICIO, 'package.json'), 'utf8'));

/** Las variables de `.env.example` con su valor de ejemplo (líneas CLAVE=valor; se ignoran los comentarios y los vacíos). */
function leerEnvEjemplo() {
  const variables = {};
  for (const linea of fs.readFileSync(path.join(RAIZ_SERVICIO, '.env.example'), 'utf8').split('\n')) {
    const coincide = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(linea.trim());
    if (coincide) variables[coincide[1]] = coincide[2];
  }
  return variables;
}

const trabajo = (workflow) => workflow.jobs.pruebas;
const pasos = (workflow) => trabajo(workflow).steps;
const pasoDe = (workflow, ejecuta) => pasos(workflow).find((paso) => paso.run === ejecuta);
const pasoDePruebas = (workflow) => pasoDe(workflow, 'npm run test:cov');
const servicioPostgres = (workflow) => trabajo(workflow).services.postgres;
/** El entorno que verá `npm run test:cov`: el `env:` del paso, con todo valor convertido a texto como hace el ejecutor. */
const entornoDePruebas = (workflow) => Object.fromEntries(Object.entries(pasoDePruebas(workflow).env ?? {}).map(([k, v]) => [k, String(v)]));
const puertoPublicado = (workflow) => {
  const [publicado] = String(servicioPostgres(workflow).ports[0]).split(':');
  return publicado;
};

describe('forma del workflow', () => {
  it('es YAML válido, se llama «CI ms-inventario» y tiene un único job «pruebas» en ubuntu-latest', () => {
    const workflow = leerWorkflow();
    expect(workflow.name).toBe('CI ms-inventario');
    expect(Object.keys(workflow.jobs)).toEqual(['pruebas']);
    expect(trabajo(workflow)['runs-on']).toBe('ubuntu-latest');
  });

  it('se dispara solo en pull_request, y solo cuando cambia el servicio o el propio workflow', () => {
    const { on } = leerWorkflow();
    expect(Object.keys(on)).toEqual(['pull_request']);
    expect(on.pull_request.paths).toEqual([`${DIRECTORIO_SERVICIO}/**`, '.github/workflows/ci-ms-inventario.yml']);
  });

  it('el token solo lee el código y el job no pide más permisos', () => {
    const workflow = leerWorkflow();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(trabajo(workflow).permissions).toBeUndefined();
  });

  it('una ejecución nueva sobre la misma rama cancela la anterior', () => {
    const { concurrency } = leerWorkflow();
    expect(concurrency['cancel-in-progress']).toBe(true);
    expect(concurrency.group).toContain('github.workflow');
  });

  it('el job tiene un plazo razonable (entre 5 y 30 minutos) y corre dentro de services/ms-inventario, que existe', () => {
    const job = trabajo(leerWorkflow());
    expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(5);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
    expect(job.defaults.run['working-directory']).toBe(DIRECTORIO_SERVICIO);
    expect(fs.statSync(path.join(RAIZ_REPOSITORIO, DIRECTORIO_SERVICIO)).isDirectory()).toBe(true);
  });

  it('toda acción lleva una versión fija (@vN) y la imagen de la base lleva etiqueta', () => {
    const workflow = leerWorkflow();
    const acciones = pasos(workflow).filter((paso) => paso.uses).map((paso) => paso.uses);
    expect(acciones.length).toBeGreaterThanOrEqual(2);
    for (const accion of acciones) expect(accion).toMatch(/^[\w-]+\/[\w.-]+@v\d+(\.\d+){0,2}$/);
    expect(servicioPostgres(workflow).image).toMatch(/^postgres:\d+(\.\d+)?$/);
  });
});

describe('la base de datos de la CI', () => {
  it('es un servicio postgres:16 con el usuario «inventario», una base y una contraseña, y publica el puerto', () => {
    const postgres = servicioPostgres(leerWorkflow());
    expect(postgres.image).toBe('postgres:16');
    expect(postgres.env.POSTGRES_USER).toBe('inventario');
    expect(postgres.env.POSTGRES_PASSWORD).toBeTruthy();
    expect(postgres.env.POSTGRES_DB).toBeTruthy();
    expect(postgres.ports).toHaveLength(1);
    expect(String(postgres.ports[0])).toMatch(/^\d+:5432$/);
  });

  it('espera a que PostgreSQL acepte conexiones: pg_isready con intervalo, plazo y reintentos', () => {
    const { options } = servicioPostgres(leerWorkflow());
    expect(options).toMatch(/--health-cmd\s+"pg_isready[^"]*"/);
    for (const opcion of ['--health-interval', '--health-timeout', '--health-retries']) {
      expect(options).toMatch(new RegExp(`${opcion}\\s+\\d+`));
    }
  });

  it('la contraseña es la de ejemplo de .env.example: una base efímera sin ningún secreto real', () => {
    const workflow = leerWorkflow();
    const marcador = leerEnvEjemplo().DB_PASSWORD;
    expect(marcador).toBe('change_me');
    expect(servicioPostgres(workflow).env.POSTGRES_PASSWORD).toBe(marcador);
    expect(entornoDePruebas(workflow).DB_PASSWORD).toBe(marcador);
    expect(fs.readFileSync(RUTA_WORKFLOW, 'utf8')).not.toContain('secrets.');
  });

  it('el entorno de las pruebas apunta a ESE servicio: mismo usuario, contraseña, base y puerto publicado', () => {
    const workflow = leerWorkflow();
    const postgres = servicioPostgres(workflow);
    const entorno = entornoDePruebas(workflow);
    expect(entorno.DB_USER).toBe(postgres.env.POSTGRES_USER);
    expect(entorno.DB_PASSWORD).toBe(postgres.env.POSTGRES_PASSWORD);
    expect(entorno.DB_NAME).toBe(postgres.env.POSTGRES_DB);
    expect(entorno.DB_PORT).toBe(puertoPublicado(workflow));
    // El servicio se publica en el equipo del ejecutor, no en un nombre de contenedor (el job no corre dentro de uno).
    expect(['127.0.0.1', 'localhost']).toContain(entorno.DB_HOST);
  });
});

describe('Node.js y los pasos', () => {
  it('prepara Node 22 (la versión mínima de package.json) con la caché de npm del package-lock del servicio', () => {
    const workflow = leerWorkflow();
    const paso = pasos(workflow).find((p) => p.uses && p.uses.startsWith('actions/setup-node@'));
    expect(String(paso.with['node-version'])).toMatch(/^22(\.x|\.\d+(\.\d+)?)?$/);
    expect(paso.with.cache).toBe('npm');
    const dependencias = paso.with['cache-dependency-path'];
    expect(dependencias).toBe(`${DIRECTORIO_SERVICIO}/package-lock.json`);
    expect(fs.existsSync(path.join(RAIZ_REPOSITORIO, dependencias))).toBe(true);
    // engines.node es «>=22.9»: la versión que pide el workflow debe cumplirla (mayor igual o superior).
    const minimo = /(\d+)\.(\d+)/.exec(leerPaquete().engines.node);
    expect(Number(minimo[1])).toBeLessThanOrEqual(22);
  });

  it('descarga el código, prepara Node, instala con `npm ci` y solo después corre `npm run test:cov`', () => {
    const workflow = leerWorkflow();
    const lista = pasos(workflow);
    const posicion = (predicado) => lista.findIndex(predicado);
    const descarga = posicion((p) => p.uses && p.uses.startsWith('actions/checkout@'));
    const node = posicion((p) => p.uses && p.uses.startsWith('actions/setup-node@'));
    const instala = posicion((p) => p.run === 'npm ci');
    const prueba = posicion((p) => p.run === 'npm run test:cov');
    expect([descarga, node, instala, prueba].every((i) => i >= 0)).toBe(true);
    expect(descarga).toBeLessThan(node);
    expect(node).toBeLessThan(instala);
    expect(instala).toBeLessThan(prueba);
    expect(prueba).toBe(lista.length - 1);
  });
});

describe('el entorno del paso de pruebas', () => {
  it('da TODAS las variables de .env.example y las obligatorias del servicio, ya que en la CI no hay .env', () => {
    const entorno = entornoDePruebas(leerWorkflow());
    for (const nombre of [...Object.keys(leerEnvEjemplo()), ...VARIABLES_OBLIGATORIAS]) {
      expect(Object.keys(entorno)).toContain(nombre);
      expect(entorno[nombre].trim()).not.toBe('');
    }
  });

  it('con ese entorno el servicio lo da por válido: /health respondería 200 y la configuración se lee sin error', () => {
    const entorno = entornoDePruebas(leerWorkflow());
    expect(validarEntorno(entorno)).toEqual({ faltantes: [], invalidas: [] });
    expect(() => cargarConfig(entorno)).not.toThrow();
    expect(() => cargarConfig({ ...entorno, NODE_ENV: 'test' })).not.toThrow();
  });

  it('con ese entorno la guardia D21 acepta una base de pruebas distinta de la de desarrollo (las pruebas no la tocan)', () => {
    const entorno = entornoDePruebas(leerWorkflow());
    const base = verificarBaseDePrueba(entorno);
    expect(base).toMatch(/_test$/);
    expect(base).not.toBe(entorno.DB_NAME);
    // Con NODE_ENV=test (Jest lo fija) el servicio usa esa base, no DB_NAME.
    expect(cargarConfig({ ...entorno, NODE_ENV: 'test' }).db.database).toBe(base);
  });

  it('CALL_TIMEOUT_MS está en el rango que acepta el servicio y se lee tal cual (no cae al valor por defecto)', () => {
    const entorno = entornoDePruebas(leerWorkflow());
    expect(cargarConfig(entorno).callTimeoutMs).toBe(Number(entorno.CALL_TIMEOUT_MS));
  });

  it('no fija TZ: la suite debe pasar en cualquier huso horario, también en el UTC del ejecutor de GitHub', () => {
    // Una prueba (conteos: el día UTC) suponía el huso de Colombia y falló en la simulación en limpio con TZ=UTC; se hizo hermética
    // (proceso hijo con su propio TZ). Fijar TZ aquí volvería a esconder cualquier prueba que dependa del huso de la máquina.
    expect(Object.keys(entornoDePruebas(leerWorkflow()))).not.toContain('TZ');
  });

  it('ningún paso copia un .env: el entorno de las pruebas lo da solo el workflow', () => {
    const workflow = leerWorkflow();
    for (const paso of pasos(workflow)) expect(String(paso.run ?? '')).not.toMatch(/\.env/);
  });
});

describe('la cobertura mínima del 60 % (RNF20)', () => {
  it('`npm run test:cov` corre Jest con --coverage', () => {
    expect(leerPaquete().scripts['test:cov']).toMatch(/--coverage/);
  });

  it('jest.config.js exige al menos 60 en líneas, sentencias, funciones y ramas, de forma global', () => {
    const { coverageThreshold } = require('../jest.config.js');
    for (const metrica of ['lines', 'statements', 'functions', 'branches']) {
      expect(coverageThreshold.global[metrica]).toBeGreaterThanOrEqual(60);
    }
  });

  it('la cobertura se mide sobre el código del servicio (src/), no solo sobre lo que las pruebas importan', () => {
    const { collectCoverageFrom } = require('../jest.config.js');
    expect(collectCoverageFrom).toContain('src/**/*.js');
  });
});
