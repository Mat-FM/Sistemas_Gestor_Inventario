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
/** Todos los bloques `env:` del workflow: el raíz, el del job y el de cada paso (nombre → variables). */
const bloquesDeEnv = (workflow) => [
  ['workflow', workflow.env ?? {}],
  ['job', trabajo(workflow).env ?? {}],
  ...pasos(workflow).map((paso, i) => [`paso ${i + 1} (${paso.name ?? paso.uses ?? paso.run})`, paso.env ?? {}]),
];
/**
 * El entorno que verá `npm run test:cov`: el `env:` del workflow, el del job y el del paso (el del paso gana), con todo valor
 * convertido a texto como hace el ejecutor.
 */
const entornoDePruebas = (workflow) => Object.fromEntries(
  [workflow.env, trabajo(workflow).env, pasoDePruebas(workflow).env].flatMap((env) => Object.entries(env ?? {})).map(([k, v]) => [k, String(v)]),
);

/**
 * ¿La `node-version` que pide setup-node cumple `engines.node` de package.json (solo la forma «>=X.Y», la que usa el servicio)?
 * Una versión con solo la mayor (`22`, `22.x`) pide el último lanzamiento de esa mayor, que cumple el mínimo de su misma mayor; con
 * menor (`22.9`, `22.0`) se compara también la menor. Cualquier otra forma (`lts/*`, `>=22`) no se da por buena.
 */
function cumpleEngines(versionPedida, rango) {
  const minimo = /^>=\s*(\d+)(?:\.(\d+))?/.exec(rango);
  if (!minimo) throw new Error(`engines.node («${rango}») no tiene la forma >=X.Y: hay que ampliar esta comprobación`);
  const [minMayor, minMenor] = [Number(minimo[1]), Number(minimo[2] ?? 0)];
  const pedida = /^(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(String(versionPedida).trim());
  if (!pedida) return false;
  const mayor = Number(pedida[1]);
  if (mayor !== minMayor) return mayor > minMayor;
  return pedida[2] === undefined || pedida[2] === 'x' || Number(pedida[2]) >= minMenor;
}
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
    // El grupo es por workflow Y por rama (head_ref en un pull request): sin la rama, un PR cancelaría las ejecuciones de otro.
    expect(concurrency.group).toContain('github.workflow');
    expect(concurrency.group).toContain('github.head_ref');
  });

  it('el job tiene un plazo razonable (entre 5 y 30 minutos) y corre dentro de services/ms-inventario, que existe', () => {
    const job = trabajo(leerWorkflow());
    expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(5);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
    expect(job.defaults.run['working-directory']).toBe(DIRECTORIO_SERVICIO);
    expect(fs.statSync(path.join(RAIZ_REPOSITORIO, DIRECTORIO_SERVICIO)).isDirectory()).toBe(true);
  });

  it('toda acción lleva una versión mayor fija (@vN) y la imagen de la base lleva etiqueta', () => {
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
    // El -h 127.0.0.1 obliga a comprobar por TCP: sin él pg_isready usa el socket Unix y el servidor temporal con que la imagen
    // arranca por primera vez (solo escucha ahí) daría la base por lista antes de aceptar las conexiones del puerto publicado.
    expect(options).toMatch(/--health-cmd\s+"pg_isready\s[^"]*-h\s+127\.0\.0\.1(\s|")/);
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
    const version = String(paso.with['node-version']);
    expect(version).toMatch(/^22(\.x|\.\d+(\.\d+)?)?$/);
    // La versión que pide el workflow debe cumplir engines.node de package.json (si no, `npm test` muere con «bad option: --env-file-if-exists»).
    expect(cumpleEngines(version, leerPaquete().engines.node)).toBe(true);
    expect(paso.with.cache).toBe('npm');
    const dependencias = paso.with['cache-dependency-path'];
    expect(dependencias).toBe(`${DIRECTORIO_SERVICIO}/package-lock.json`);
    expect(fs.existsSync(path.join(RAIZ_REPOSITORIO, dependencias))).toBe(true);
  });

  it.each([
    ['22', true], ['22.x', true], ['22.9', true], ['22.9.0', true], ['22.23.2', true], ['24', true],
    ['22.0', false], ['22.8', false], ['22.8.9', false], ['20', false], ['lts/*', false],
  ])('cumpleEngines: node-version %p frente a engines.node de package.json -> %p', (version, esperado) => {
    expect(cumpleEngines(version, '>=22.9')).toBe(esperado);
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

  it('no fija TZ en ningún `env:` (workflow, job ni pasos): la suite debe pasar en cualquier huso, también en el UTC del ejecutor', () => {
    // Una prueba (conteos: el día UTC) suponía el huso de Colombia y falló en la simulación en limpio con TZ=UTC; se hizo hermética
    // (proceso hijo con su propio TZ). Fijar TZ aquí volvería a esconder cualquier prueba que dependa del huso de la máquina.
    const bloques = bloquesDeEnv(leerWorkflow());
    expect(bloques.length).toBeGreaterThanOrEqual(5); // control: se revisan el raíz, el del job y los de los pasos
    for (const [donde, env] of bloques) expect({ donde, TZ: Object.keys(env).includes('TZ') }).toEqual({ donde, TZ: false });
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
