const fs = require('node:fs');
const path = require('node:path');
const { cargarConfig } = require('../src/config/env');

// Guarda estática de la imagen (RNF03): lee el Dockerfile y el .dockerignore como TEXTO y los contrasta con el propio servicio
// (package.json, src/config/env.js, el disco y los archivos que el código lee al arrancar). No necesita Docker: que la imagen
// construya y arranque de verdad se comprueba a mano (docker build / docker run), y aquí solo se vigila lo que no debe desfasarse.

const RAIZ = path.join(__dirname, '..');
const leer = (nombre) => fs.readFileSync(path.join(RAIZ, nombre), 'utf8');
const dockerfile = () => leer('Dockerfile');
const dockerignore = () => leer('.dockerignore');
const paquete = () => JSON.parse(leer('package.json'));

/**
 * Las instrucciones del Dockerfile, una por elemento: sin comentarios ni líneas en blanco y con las continuaciones (`\`) ya
 * unidas. `nombre` va en mayúsculas y `argumentos` es el resto de la línea tal cual.
 * @returns {{nombre: string, argumentos: string}[]}
 */
function instrucciones(texto) {
  const resultado = [];
  let acumulada = '';
  for (const cruda of texto.split('\n')) {
    const linea = cruda.replace(/\r$/, '').trim();
    if (linea === '' || linea.startsWith('#')) continue; // también dentro de una continuación, como hace Docker
    const sigue = linea.endsWith('\\');
    acumulada = `${acumulada} ${sigue ? linea.slice(0, -1) : linea}`.trim();
    if (sigue) continue;
    const [nombre, ...resto] = acumulada.split(/\s+/);
    resultado.push({ nombre: nombre.toUpperCase(), argumentos: resto.join(' ') });
    acumulada = '';
  }
  return resultado;
}

const deTipo = (nombre) => instrucciones(dockerfile()).filter((i) => i.nombre === nombre);

/** Las variables que declara un ENV o un ARG: admite `A=1 B=2` y `A 1`. */
function variablesDe(argumentos) {
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argumentos)) {
    return Object.fromEntries([...argumentos.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
  }
  const [nombre, ...valor] = argumentos.split(/\s+/);
  return { [nombre]: valor.join(' ') };
}

/** Un CMD/HEALTHCHECK en forma exec (JSON): devuelve la lista, o null si está en forma shell. */
function formaExec(argumentos) {
  try {
    const lista = JSON.parse(argumentos);
    return Array.isArray(lista) && lista.every((x) => typeof x === 'string') ? lista : null;
  } catch {
    return null;
  }
}

/** Los orígenes de cada COPY (todo menos el último argumento, que es el destino); se ignoran las opciones `--...`. */
function origenesDeCopy() {
  return deTipo('COPY').flatMap(({ argumentos }) => {
    const partes = argumentos.split(/\s+/).filter((p) => !p.startsWith('--'));
    return partes.slice(0, -1);
  });
}

/** Los patrones de .dockerignore, en orden, sin comentarios ni líneas en blanco. */
const patronesDeIgnore = () => dockerignore().split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

// Un patrón de .dockerignore como expresión regular. Imita a Docker: los patrones se anclan a la raíz del contexto, `*` y `?` no
// cruzan `/` y `**` sí cruza directorios.
function patronARegex(patron) {
  let expresion = '';
  for (let i = 0; i < patron.length; i += 1) {
    const c = patron[i];
    if (c === '*' && patron[i + 1] === '*') {
      i += 1;
      if (patron[i + 1] === '/') {
        i += 1;
        expresion += '(?:.*/)?';
      } else {
        expresion += '.*';
      }
    } else if (c === '*') {
      expresion += '[^/]*';
    } else if (c === '?') {
      expresion += '[^/]';
    } else {
      expresion += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${expresion}$`);
}

/**
 * ¿Deja .dockerignore fuera del contexto a `ruta` (relativa a la raíz del servicio)? Un patrón excluye la ruta si coincide con
 * ella o con CUALQUIERA de sus directorios padre (`src` excluye `src/docs/swagger-ui.html`; `docs` NO excluye `src/docs`); una
 * línea con `!` la vuelve a incluir. Manda la última que coincide.
 */
function estaIgnorada(ruta, patrones) {
  const partes = ruta.split('/');
  const ancestros = partes.map((_, i) => partes.slice(0, i + 1).join('/'));
  let ignorada = false;
  for (const linea of patrones) {
    const negada = linea.startsWith('!');
    const patron = path.posix.normalize((negada ? linea.slice(1) : linea).replace(/^\//, '')).replace(/\/$/, '');
    if (ancestros.some((ancestro) => patronARegex(patron).test(ancestro))) ignorada = !negada;
  }
  return ignorada;
}

/** Todos los archivos (rutas relativas a la raíz del servicio, con `/`) que un COPY de `origen` mete en la imagen. */
function archivosDe(origen) {
  const absoluta = path.join(RAIZ, origen);
  if (!fs.statSync(absoluta).isDirectory()) return [origen];
  return fs.readdirSync(absoluta, { recursive: true, withFileTypes: true })
    .filter((entrada) => entrada.isFile())
    .map((entrada) => path.relative(RAIZ, path.join(entrada.parentPath, entrada.name)).split(path.sep).join('/'));
}

/** ¿La ruta queda dentro de la imagen? Cubierta por algún COPY (igual o dentro de un directorio copiado) y no ignorada. */
function entraEnLaImagen(ruta) {
  const cubierta = origenesDeCopy().some((origen) => ruta === origen || ruta.startsWith(`${origen}/`));
  return cubierta && !estaIgnorada(ruta, patronesDeIgnore());
}

// Los archivos que el código lee en tiempo de ejecución, derivados de `path.join(__dirname, '..', 'x')` en src/: se resuelven
// desde la carpeta del archivo que los nombra. createApp LANZA si falta openapi.yaml o src/docs/swagger-ui.html (routes/docs.js),
// y Knex busca las migraciones en migrations/ (config/db.js): sin ellos el contenedor entraría en un bucle de reinicios.
function archivosDeEjecucion() {
  const rutas = new Set();
  const recorrer = (directorio) => {
    for (const entrada of fs.readdirSync(directorio, { withFileTypes: true })) {
      const completa = path.join(directorio, entrada.name);
      if (entrada.isDirectory()) recorrer(completa);
      else if (entrada.name.endsWith('.js')) {
        for (const m of fs.readFileSync(completa, 'utf8').matchAll(/path\.join\(\s*__dirname((?:\s*,\s*'[^']*')*)\s*\)/g)) {
          const segmentos = [...m[1].matchAll(/'([^']*)'/g)].map((s) => s[1]);
          rutas.add(path.relative(RAIZ, path.resolve(directorio, ...segmentos)).split(path.sep).join('/'));
        }
      }
    }
  };
  recorrer(path.join(RAIZ, 'src'));
  return [...rutas].sort();
}

describe('el Dockerfile', () => {
  it('parte de la imagen de Node de la versión mayor que exige package.json (engines.node), sin etiqueta flotante', () => {
    const mayor = /(\d+)/.exec(paquete().engines.node)[1];
    const desdes = deTipo('FROM');
    expect(desdes).toHaveLength(1); // una sola etapa: no hay nada que copiar de otra
    const imagen = desdes[0].argumentos;
    expect(imagen).toMatch(new RegExp(`^node:${mayor}([.-][A-Za-z0-9.-]+)?$`));
    expect(imagen).not.toMatch(/latest/);
  });

  it('instala solo las dependencias de producción con npm ci, en una capa propia anterior al código', () => {
    const todas = instrucciones(dockerfile());
    const indiceInstalacion = todas.findIndex((i) => i.nombre === 'RUN' && /\bnpm ci\b/.test(i.argumentos));
    expect(indiceInstalacion).toBeGreaterThan(-1);
    for (const i of todas.filter((x) => x.nombre === 'RUN')) {
      if (/\bnpm ci\b/.test(i.argumentos)) expect(i.argumentos).toMatch(/\bnpm ci\b.*--omit=dev/);
      expect(i.argumentos).not.toMatch(/\bnpm (install|i)\b/); // npm install ignora el package-lock.json
    }
    // Capa de dependencias: antes del npm ci, SOLO package.json y package-lock.json; el código llega después.
    const antes = todas.slice(0, indiceInstalacion).filter((i) => i.nombre === 'COPY');
    expect(antes.map((i) => i.argumentos.split(/\s+/).slice(0, -1)).flat().sort()).toEqual(['package-lock.json', 'package.json']);
    const copiasDeCodigo = todas.slice(indiceInstalacion + 1).filter((i) => i.nombre === 'COPY');
    expect(copiasDeCodigo.length).toBeGreaterThan(0);
  });

  it('no corre como root: crea un usuario con UID 10001 y lo deja activo para el proceso del servicio', () => {
    const todas = instrucciones(dockerfile());
    const crear = todas.find((i) => i.nombre === 'RUN' && /\buseradd\b/.test(i.argumentos));
    expect(crear).toBeDefined();
    const orden = /\buseradd\b([^&;|]*)/.exec(crear.argumentos)[1].trim().split(/\s+/);
    expect(orden[orden.indexOf('--uid') + 1]).toBe('10001');
    const usuario = orden[orden.length - 1]; // useradd [opciones] LOGIN
    const usuarios = todas.filter((i) => i.nombre === 'USER');
    expect(usuarios.length).toBeGreaterThan(0);
    // Por NÚMERO, no por nombre: con `runAsNonRoot: true` el kubelet rechaza una imagen cuyo USER no es numérico.
    expect(usuarios[usuarios.length - 1].argumentos).toBe('10001');
    // el USER va antes del CMD y del HEALTHCHECK (ambos corren con él) y no se vuelve a root después
    const indiceUsuario = todas.map((i) => i.nombre).lastIndexOf('USER');
    expect(indiceUsuario).toBeLessThan(todas.findIndex((i) => i.nombre === 'CMD'));
    expect(indiceUsuario).toBeLessThan(todas.findIndex((i) => i.nombre === 'HEALTHCHECK'));
    expect(usuario).not.toMatch(/^(root|0)$/);
    expect(usuarios.map((i) => i.argumentos)).not.toContain('root');
  });

  it('fija NODE_ENV=production y expone el mismo puerto que usa el servicio por defecto (PORT)', () => {
    const entorno = Object.assign({}, ...deTipo('ENV').map((i) => variablesDe(i.argumentos)));
    const puertoPorDefecto = String(cargarConfig({}).puerto);
    expect(entorno.NODE_ENV).toBe('production');
    expect(entorno.PORT).toBe(puertoPorDefecto);
    const expuestos = deTipo('EXPOSE').flatMap((i) => i.argumentos.split(/\s+/).map((p) => p.replace(/\/tcp$/, '')));
    expect(expuestos).toEqual([puertoPorDefecto]);
  });

  it('arranca con `node <main de package.json>` en forma exec: el proceso Node es el principal y recibe SIGTERM', () => {
    const comandos = deTipo('CMD');
    expect(comandos).toHaveLength(1);
    expect(formaExec(comandos[0].argumentos)).toEqual(['node', paquete().main]); // no ['sh', '-c', ...], no `npm start`
    expect(deTipo('ENTRYPOINT')).toHaveLength(0);
    expect(deTipo('STOPSIGNAL').every((i) => i.argumentos === 'SIGTERM')).toBe(true); // server.js atiende SIGTERM y SIGINT
  });

  it('tiene un HEALTHCHECK con node (la imagen slim no trae curl) que pide /health, falla con un 503 y no espera sin plazo', () => {
    const comprobaciones = deTipo('HEALTHCHECK');
    expect(comprobaciones).toHaveLength(1);
    const { argumentos } = comprobaciones[0];
    for (const opcion of ['--interval=', '--timeout=', '--start-period=', '--retries=']) expect(argumentos).toContain(opcion);
    const orden = formaExec(argumentos.slice(argumentos.indexOf('CMD') + 3));
    expect(orden).not.toBeNull();
    expect(orden.slice(0, 2)).toEqual(['node', '-e']);
    const guion = orden[2];
    expect(guion).toContain('/health');
    expect(guion).toContain('process.env.PORT'); // sigue al PORT con el que se ejecute el contenedor
    expect(guion).toMatch(/\.ok\b/); // fetch NO lanza con un 503: sin mirar r.ok una sonda con 503 saldría «sana»
    expect(guion).toContain('AbortSignal.timeout'); // sin plazo propio, una sonda colgada dependería solo de --timeout
    expect(argumentos).not.toMatch(/\b(curl|wget)\b/);
  });

  it('copia solo lo necesario: cada origen existe y están el código, las migraciones, knexfile.js, openapi.yaml y package*.json', () => {
    const origenes = origenesDeCopy();
    for (const origen of origenes) expect(fs.existsSync(path.join(RAIZ, origen))).toBe(true);
    for (const necesario of ['package.json', 'package-lock.json', 'src', 'migrations', 'knexfile.js', 'openapi.yaml']) expect(origenes).toContain(necesario);
    // lo que NO va en la imagen
    for (const sobrante of ['tests', 'coverage', 'node_modules', 'README.md', 'jest.config.js', '.env', '.env.example']) expect(origenes).not.toContain(sobrante);
    for (const origen of origenes) {
      expect(origen).not.toMatch(/^(\.|\.\/|\/|\*+|\.\/\*+)$/); // ni `COPY . .` ni `COPY * .`: copiar a ciegas metería el .env
      expect(origen).not.toMatch(/(^|\/)\.env/);
    }
    expect(deTipo('ADD')).toHaveLength(0);
    expect(deTipo('COPY').every((i) => !/--from\b/.test(i.argumentos))).toBe(true); // una sola etapa
  });

  it('no lleva contraseñas, credenciales ni direcciones de otros servicios: la configuración llega por el entorno (RNF14)', () => {
    const variables = [...deTipo('ENV'), ...deTipo('ARG')].flatMap((i) => Object.keys(variablesDe(i.argumentos)));
    for (const nombre of variables) {
      expect(nombre).not.toMatch(/PASS|SECRET|TOKEN|KEY|CREDENTIAL/i);
      expect(nombre).not.toMatch(/^(DB_|MS_|TEST_)/);
    }
    expect(variables.sort()).toEqual(['NODE_ENV', 'PORT']); // lo único que fija la imagen; el resto lo pone quien la ejecute
    const texto = dockerfile();
    expect(leer('.env.example')).toContain('change_me'); // control: el valor centinela de la contraseña de ejemplo existe
    expect(texto).not.toContain('change_me');
    expect(texto).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // ninguna URL de otro servicio (la sonda usa 127.0.0.1)
    // Ninguna instrucción copia o lee un .env (los comentarios sí pueden nombrarlo para explicar que la imagen no lo lleva).
    const sinComentarios = instrucciones(texto).map((i) => `${i.nombre} ${i.argumentos}`).join('\n');
    expect(sinComentarios).not.toMatch(/--env-file|(^|[\s/'"=])\.env\b/); // `process.env` de la sonda no cuenta: el punto va pegado a una palabra
  });
});

describe('.dockerignore', () => {
  it('deja fuera el .env (y sus variantes), node_modules, las pruebas y la cobertura', () => {
    const patrones = patronesDeIgnore();
    for (const ruta of ['.env', '.env.local', '.env.production', 'node_modules', 'node_modules/express/package.json', 'tests', 'tests/dockerfile.test.js', 'coverage', 'coverage/lcov.info']) {
      expect({ ruta, ignorada: estaIgnorada(ruta, patrones) }).toEqual({ ruta, ignorada: true });
    }
  });

  it('no deja fuera nada de lo que el Dockerfile copia (src entero, migraciones, knexfile.js, openapi.yaml, package*.json)', () => {
    const patrones = patronesDeIgnore();
    const archivos = origenesDeCopy().flatMap(archivosDe);
    for (const imprescindible of ['src/server.js', 'src/docs/swagger-ui.html', 'migrations/20261103000100_esquema_inventario.js', 'knexfile.js', 'openapi.yaml', 'package.json', 'package-lock.json']) {
      expect(archivos).toContain(imprescindible); // control: la lista de archivos que se miran no está vacía por error
    }
    const excluidos = archivos.filter((archivo) => estaIgnorada(archivo, patrones));
    expect(excluidos).toEqual([]);
  });
});

describe('los archivos que el servicio lee al arrancar están dentro de la imagen', () => {
  it('se derivan de path.join(__dirname, …) en src/: openapi.yaml, la página de Swagger UI y las migraciones', () => {
    // control de la derivación: si el patrón no encontrara nada, la comprobación de abajo pasaría en vacío
    expect(archivosDeEjecucion()).toEqual(expect.arrayContaining(['openapi.yaml', 'src/docs/swagger-ui.html', 'migrations']));
  });

  it('cada uno existe, está cubierto por un COPY y no lo excluye .dockerignore: si faltara, createApp lanzaría y el contenedor se reiniciaría sin parar', () => {
    for (const ruta of archivosDeEjecucion()) {
      expect({ ruta, existe: fs.existsSync(path.join(RAIZ, ruta)) }).toEqual({ ruta, existe: true });
      const archivos = archivosDe(ruta);
      expect(archivos.length).toBeGreaterThan(0);
      for (const archivo of archivos) expect({ archivo, dentro: entraEnLaImagen(archivo) }).toEqual({ archivo, dentro: true });
    }
  });
});

describe('auxiliares de esta guarda (para que no mientan)', () => {
  it('estaIgnorada imita a Docker: patrones anclados a la raíz, padre que excluye a sus hijos, `**` y `!`', () => {
    expect(estaIgnorada('src/docs/swagger-ui.html', ['docs'])).toBe(false); // `docs` solo es el de la raíz
    expect(estaIgnorada('docs/a.md', ['docs'])).toBe(true);
    expect(estaIgnorada('src/docs/swagger-ui.html', ['src'])).toBe(true); // el directorio padre arrastra a sus archivos
    expect(estaIgnorada('src/docs/swagger-ui.html', ['src/'])).toBe(true);
    expect(estaIgnorada('src/docs/swagger-ui.html', ['*.html'])).toBe(false); // `*` no cruza `/`
    expect(estaIgnorada('src/docs/swagger-ui.html', ['**/*.html'])).toBe(true);
    expect(estaIgnorada('swagger-ui.html', ['**/*.html'])).toBe(true);
    expect(estaIgnorada('openapi.yaml', ['*.yaml'])).toBe(true);
    expect(estaIgnorada('.env.local', ['.env.*'])).toBe(true);
    expect(estaIgnorada('.env', ['.env.*'])).toBe(false);
    expect(estaIgnorada('.env.example', ['.env.*', '!.env.example'])).toBe(false); // la excepción manda si va después
    expect(estaIgnorada('.env.example', ['!.env.example', '.env.*'])).toBe(true); // …y no si va antes
    expect(estaIgnorada('a.b', ['a?b'])).toBe(true); // `?` es un carácter cualquiera…
    expect(estaIgnorada('a/b', ['a?b'])).toBe(false); // …menos la `/`
    expect(estaIgnorada('axb', ['a.b'])).toBe(false); // y el `.` del patrón es un punto literal, no «cualquier carácter»
  });

  it('instrucciones une las continuaciones, descarta comentarios y distingue la forma exec de la shell', () => {
    const texto = '# comentario\nFROM node:22\n\nRUN a \\\n    # otro comentario\n    && b\nCMD ["node", "x.js"]\nCMD node x.js\n';
    expect(instrucciones(texto)).toEqual([
      { nombre: 'FROM', argumentos: 'node:22' },
      { nombre: 'RUN', argumentos: 'a && b' },
      { nombre: 'CMD', argumentos: '["node", "x.js"]' },
      { nombre: 'CMD', argumentos: 'node x.js' },
    ]);
    expect(formaExec('["node", "x.js"]')).toEqual(['node', 'x.js']);
    expect(formaExec('node x.js')).toBeNull();
    expect(variablesDe('A=1 B=dos')).toEqual({ A: '1', B: 'dos' });
    expect(variablesDe('A uno')).toEqual({ A: 'uno' });
  });
});
