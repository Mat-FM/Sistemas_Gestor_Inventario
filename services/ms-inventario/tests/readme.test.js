const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { VARIABLES_OBLIGATORIAS, PLAZO_MIN_MS, PLAZO_MAX_MS, cargarConfig } = require('../src/config/env');
const { ROLES } = require('../src/middleware/identity');
const { TIPOS } = require('../src/domain/tipos');
const { rutasDeclaradas } = require('../src/routes');
const { MAX_FILAS_CARGA_INICIAL } = require('../src/services/cargaInicialService');
const { MAX_LINEAS_CONTEO } = require('../src/services/conteoService');
const { leerClaveIdempotencia } = require('../src/services/idempotencia');

// Guarda estática del README: lo que el documento afirma sobre rutas, variables, scripts y archivos se contrasta con el propio
// servicio (rutasDeclaradas, .env.example, package.json, openapi.yaml, el disco), de modo que un README desfasado hace fallar la
// prueba. Lee las TABLAS, no el texto entero: el README nombra casi todo también en prosa y una búsqueda de texto no notaría que
// falta una fila.

const RAIZ = path.join(__dirname, '..');
const leerTexto = (nombre) => fs.readFileSync(path.join(RAIZ, nombre), 'utf8');
const readme = () => leerTexto('README.md');
const paquete = () => JSON.parse(leerTexto('package.json'));
const openapi = () => yaml.load(leerTexto('openapi.yaml'));

/** Las variables de `.env.example` con su valor de ejemplo. */
function leerEnvEjemplo() {
  const variables = {};
  for (const linea of leerTexto('.env.example').split('\n')) {
    const coincide = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(linea.trim());
    if (coincide) variables[coincide[1]] = coincide[2];
  }
  return variables;
}

/** Los fragmentos en código (`así`) de un texto. Los bloques ``` se quitan antes: sus comillas desalinearían el emparejado. */
const fragmentos = (texto) => [...texto.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/**
 * Las filas de la tabla de Markdown cuya cabecera empieza por `primeraCelda`: una lista de filas, cada una con sus celdas ya
 * recortadas. Ninguna celda de las tablas del README lleva el carácter `|`.
 */
function filasDeTabla(texto, primeraCelda) {
  const lineas = texto.split('\n');
  const inicio = lineas.findIndex((linea) => linea.startsWith(`| ${primeraCelda} |`));
  if (inicio < 0) throw new Error(`El README no tiene una tabla que empiece por «${primeraCelda}»`);
  const filas = [];
  for (let i = inicio + 2; i < lineas.length && lineas[i].startsWith('|'); i += 1) {
    filas.push(lineas[i].replace(/^\||\|$/g, '').split('|').map((celda) => celda.trim()));
  }
  return filas;
}

/** Quita los separadores de miles («1 000», «60 000», «102 400», con espacio o con espacio fino) para comparar con números. */
const sinMiles = (texto) => texto.replace(/(\d)[   ](?=\d{3}(?!\d))/g, '$1');

describe('la tabla de rutas', () => {
  const operaciones = () => rutasDeclaradas({}).map(({ metodo, ruta }) => `${metodo.toUpperCase()} ${ruta.replace(/:(\w+)/g, '{$1}')}`);
  // Las filas de la tabla: cada fila nombra un método y una o varias rutas.
  const rutasDelReadme = () => filasDeTabla(readme(), 'Método').flatMap(([metodo, ruta]) => fragmentos(ruta).map((r) => `${fragmentos(metodo)[0]} ${r}`));
  const DEL_SERVICIO = ['GET /health', 'GET /docs', 'GET /docs/openapi.yaml'];

  it('tiene una fila por cada operación declarada (método y ruta con {parámetro}) y por GET /health', () => {
    const tabla = rutasDelReadme();
    expect(operaciones()).toHaveLength(24);
    for (const operacion of [...operaciones(), 'GET /health']) expect(tabla).toContain(operacion);
  });

  it('no tiene filas de más: solo las operaciones declaradas, /health y las dos rutas de /docs, sin repetir', () => {
    const tabla = rutasDelReadme();
    expect([...tabla].sort()).toEqual([...operaciones(), ...DEL_SERVICIO].sort());
  });

  it('el operationId de cada fila es el de esa operación en openapi.yaml', () => {
    const documento = openapi();
    for (const [metodo, ruta, , , operationId] of filasDeTabla(readme(), 'Método')) {
      const rutaYaml = fragmentos(ruta)[0];
      if (rutaYaml === '/docs') continue; // /docs no está en el OpenAPI: lo sirve el servicio aparte
      const operacion = documento.paths[rutaYaml]?.[fragmentos(metodo)[0].toLowerCase()];
      expect(operacion).toBeDefined();
      expect(fragmentos(operationId)).toEqual([operacion.operationId]);
    }
  });

  it('cada ruta de la tabla lleva a quién la llama (la celda no está vacía)', () => {
    for (const fila of filasDeTabla(readme(), 'Método')) {
      expect(fila).toHaveLength(5);
      expect(fila[3]).not.toBe('');
    }
  });
});

describe('la tabla de variables de entorno', () => {
  const filas = () => filasDeTabla(readme(), 'Variable');
  const nombres = () => filas().map(([variable]) => fragmentos(variable)[0]);

  it('tiene exactamente las variables de .env.example, una fila por variable', () => {
    expect([...nombres()].sort()).toEqual(Object.keys(leerEnvEjemplo()).sort());
  });

  it('marca como obligatorias exactamente las que exige el servicio (validarEntorno), más ninguna', () => {
    const obligatorias = filas().filter(([, obligatoria]) => obligatoria === 'Sí').map(([variable]) => fragmentos(variable)[0]);
    expect([...obligatorias].sort()).toEqual([...VARIABLES_OBLIGATORIAS].sort());
  });

  it('PORT y CALL_TIMEOUT_MS declaran el valor por defecto que usa cargarConfig', () => {
    const porDefecto = Object.fromEntries(filas().map(([variable, , valor]) => [fragmentos(variable)[0], valor]));
    const config = cargarConfig({});
    expect(config.puerto).toBe(3000);
    expect(config.callTimeoutMs).toBe(3000);
    expect(fragmentos(porDefecto.PORT)).toEqual([String(config.puerto)]);
    expect(fragmentos(porDefecto.CALL_TIMEOUT_MS)).toEqual([String(config.callTimeoutMs)]);
  });

  it('el rango de CALL_TIMEOUT_MS es el que acepta el servicio (PLAZO_MIN_MS y PLAZO_MAX_MS)', () => {
    const [, , , uso] = filas().find(([variable]) => fragmentos(variable)[0] === 'CALL_TIMEOUT_MS');
    expect(sinMiles(uso)).toContain(`de ${PLAZO_MIN_MS} a ${PLAZO_MAX_MS} `);
  });
});

describe('los comandos y los archivos que cita', () => {
  it('cada `npm run <script>`, `npm test` y `npm start` que cita existe en los scripts de package.json', () => {
    const { scripts } = paquete();
    const citados = [...readme().matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    if (/\bnpm test\b/.test(readme())) citados.push('test');
    if (/\bnpm start\b/.test(readme())) citados.push('start');
    expect(citados).toEqual(expect.arrayContaining(['test', 'test:cov', 'start']));
    for (const script of citados) expect(Object.keys(scripts)).toContain(script);
  });

  // Rutas que el README escribe: carpetas y archivos del servicio, el workflow (con ../../) y los destinos de los enlaces.
  const rutasCitadas = () => {
    const texto = readme();
    const enlaces = [...texto.matchAll(/\]\(([^)\s#]+)\)/g)].map((m) => m[1]);
    const candidatas = [...fragmentos(texto), ...enlaces];
    return candidatas.filter((c) => !/[\s{}*<>:=]/.test(c) && (
      /^(\.\.\/)*(src|migrations|tests|\.github)\//.test(c)
      || /^\.env\.example$/.test(c)
      || /^[\w.-]+\.(js|yaml|yml|json|html)$/.test(c)
    ));
  };

  const existeEnElServicio = (ruta) => {
    // `.github/…` es una ruta del repositorio (el README la enlaza con ../../), no de la carpeta del servicio.
    if (ruta.startsWith('.github/')) return fs.existsSync(path.join(RAIZ, '..', '..', ruta));
    if (ruta.includes('/') || ruta === '.env.example') return fs.existsSync(path.join(RAIZ, ruta));
    // Un nombre suelto (index.js, env.js): debe existir en algún sitio del servicio, sin contar node_modules ni coverage.
    const pendientes = [RAIZ];
    while (pendientes.length > 0) {
      const carpeta = pendientes.pop();
      for (const entrada of fs.readdirSync(carpeta, { withFileTypes: true })) {
        if (['node_modules', 'coverage'].includes(entrada.name)) continue;
        if (entrada.isDirectory()) pendientes.push(path.join(carpeta, entrada.name));
        else if (entrada.name === ruta) return true;
      }
    }
    return false;
  };

  it('cada archivo o carpeta que nombra (src/…, migrations/…, tests/…, openapi.yaml, el workflow…) existe', () => {
    const citadas = rutasCitadas();
    // Control: el README sí nombra rutas de los tres tipos; si la extracción dejara de verlas, la comprobación no probaría nada.
    for (const esperada of ['src/services/', 'migrations/', 'tests/helpers/', 'openapi.yaml', 'knexfile.js', '../../.github/workflows/ci-ms-inventario.yml']) {
      expect(citadas).toContain(esperada);
    }
    const inexistentes = citadas.filter((ruta) => !existeEnElServicio(ruta));
    expect(inexistentes).toEqual([]);
  });

  it('la migración que aplica el README (knex migrate:latest) tiene un knexfile.js y knex como dependencia', () => {
    expect(readme()).toContain('./node_modules/.bin/knex migrate:latest');
    expect(fs.existsSync(path.join(RAIZ, 'knexfile.js'))).toBe(true);
    expect(Object.keys(paquete().dependencies)).toContain('knex');
  });

  it('el puerto de PostgreSQL que escribe el README es el de .env.example', () => {
    const puertos = [...readme().matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]).filter((p) => p !== '3000' && p !== '3055');
    expect(puertos.length).toBeGreaterThan(0);
    for (const puerto of puertos) expect(puerto).toBe(leerEnvEjemplo().DB_PORT);
  });
});

describe('lo que el README dice del servicio coincide con el servicio', () => {
  it('nombra los cuatro roles y los nueve tipos de movimiento', () => {
    for (const rol of ROLES) expect(readme()).toContain(`\`${rol}\``);
    for (const tipo of TIPOS) expect(readme()).toContain(`\`${tipo}\``);
  });

  it('nombra las ocho tablas que crea la migración y los índices (`…_idx`) que cita existen en las migraciones', () => {
    const migraciones = fs.readdirSync(path.join(RAIZ, 'migrations')).map((n) => leerTexto(path.join('migrations', n))).join('\n');
    const tablas = [...migraciones.matchAll(/createTable\('(\w+)'/g)].map((m) => m[1]);
    expect(tablas).toHaveLength(8);
    for (const tabla of tablas) expect(readme()).toContain(`\`${tabla}\``);
    const indices = fragmentos(readme()).filter((f) => /^\w+_idx$/.test(f));
    expect(indices).toContain('movimientos_fecha_id_idx');
    for (const indice of indices) expect(migraciones).toContain(indice);
  });

  it('los límites que cita son los del servicio: 1 000 filas y líneas, 1 MB de la carga inicial y 100 kB (OpenAPI)', () => {
    const texto = sinMiles(readme().replace(/\s+/g, ' ')); // el README parte las líneas: «como máximo\n  1 000 líneas»
    expect(texto).toContain(`como máximo ${MAX_FILAS_CARGA_INICIAL} filas`);
    expect(texto).toContain(`como máximo ${MAX_LINEAS_CONTEO} líneas`);
    expect(texto).toContain(`${openapi().info['x-tamano-maximo-cuerpo-bytes']} bytes`);
    expect(texto).toContain('1048576 bytes');
  });
});

describe('las guías para quien consume el servicio y los límites que reconocen', () => {
  // Un trozo del README entre dos marcas, con los saltos de línea y las sangrías convertidos en un espacio.
  function trozo(inicio, fin) {
    const texto = readme();
    const desde = texto.indexOf(inicio);
    const hasta = texto.indexOf(fin, desde + 1);
    if (desde < 0 || hasta < 0) throw new Error(`El README no tiene el trozo entre «${inicio}» y «${fin}»`);
    return texto.slice(desde, hasta).replace(/\s+/g, ' ');
  }
  const compras = () => trozo('**ms-compras**', '**ms-notificaciones**');

  it('ms-compras: pide una Idempotency-Key POR LÍNEA, con ejemplos que el servicio acepta, y no promete una clave por recepción', () => {
    const guia = compras();
    expect(guia).toContain('un movimiento por cada línea');
    expect(guia).toContain('su propia `Idempotency-Key`');
    expect(guia).toContain('rec-<id_recepcion>-<n>');
    expect(guia).toContain('No use una sola clave para toda la recepción');
    expect(guia).not.toMatch(/la misma recepción, la misma clave/);
    // Los ejemplos de clave del README son válidos tal cual y distintos entre sí (una clave por línea).
    const ejemplos = [...guia.matchAll(/`(rec-\d+-\d+)`/g)].map((m) => m[1]);
    expect(ejemplos.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ejemplos).size).toBe(ejemplos.length);
    for (const ejemplo of ejemplos) expect(leerClaveIdempotencia(ejemplo)).toBe(ejemplo);
    expect(leerClaveIdempotencia('rec-<id_recepcion>-<n>'.replace('<id_recepcion>', '77').replace('<n>', '3'))).toBe('rec-77-3');
  });

  it('ms-compras: distingue 201 de 200, trata un 200 con otro producto o cantidad como error y avisa de que las líneas no son atómicas', () => {
    const guia = compras();
    expect(guia).toMatch(/Distinga el 201 \(movimiento nuevo\) del 200 \(repetición\)/);
    expect(guia).toMatch(/200 cuyo `id_producto` o `cantidad` no son los de la línea enviada/);
    expect(guia).toContain('no son atómicas entre sí');
    expect(guia).toContain('**mismas claves**');
  });

  it('Idempotencia: dice que una clave identifica un solo movimiento (el segundo no se registra y no hay error)', () => {
    const texto = trozo('## Idempotencia (RNF17)', '## Resiliencia');
    expect(texto).toContain('Una clave identifica un solo movimiento.');
    expect(texto).toContain('sin ningún error');
  });

  it('Límites: la recepción de un traslado NO promete «regularizar» un lote; dice que exige intervenir en la base y qué caso sí se resuelve', () => {
    const limites = trozo('## Límites y limitaciones conocidas', '## Seguridad de red');
    expect(limites).not.toMatch(/regulari[cz]/i);
    expect(limites).toMatch(/BODEGA_INACTIVA`, si la bodega de destino está inactiva: se resuelve reactivándola y repitiendo la recepción con la misma clave/);
    expect(limites).toContain('Ninguna operación de la API lo resuelve');
    expect(limites).toContain('intervenga directamente en la base de datos');
    expect(limites).toContain('no creando en la bodega de destino un lote con el mismo código y otra fecha');
  });

  it('Límites: no hay devolución al origen (POST /traslados/{id}/devolucion, pendiente) y la bodega puede inactivarse entre la comprobación y el movimiento (D12)', () => {
    const limites = trozo('## Límites y limitaciones conocidas', '## Seguridad de red');
    expect(limites).toContain('`POST /traslados/{id}/devolucion`, pendiente de decisión');
    expect(limites).toContain('puede inactivarse entre la comprobación y el movimiento');
    expect(limites).toContain('`FOR SHARE`');
    expect(limites).toContain('`D12` en [`DECISIONES.md`](DECISIONES.md)');
  });

  it('el OpenAPI tampoco promete regularizar nada: ni en la recepción ni en ninguna otra descripción', () => {
    expect(leerTexto('openapi.yaml')).not.toMatch(/regulari[cz]/i);
  });

  it('ms-notificaciones: avisa tras CADA movimiento mientras siga bajo el mínimo (también una entrada que no lo alcanza) y debe deduplicar (D13)', () => {
    const guia = trozo('**ms-notificaciones**', '## Pendiente');
    expect(guia).toContain('POST /internas/notificaciones');
    expect(guia).toContain('tras cada movimiento mientras el total del producto siga por debajo del mínimo');
    expect(guia).toContain('una `ENTRADA` que sube el stock sin alcanzar el mínimo');
    expect(guia).toContain('Debe deduplicar');
  });
});

describe('contraseñas', () => {
  it('el único valor de contraseña que aparece es el marcador de .env.example (change_me), ni claves en una URL', () => {
    const marcador = leerEnvEjemplo().DB_PASSWORD;
    expect(marcador).toBe('change_me');
    const texto = readme();
    const asignaciones = [...texto.matchAll(/(?:PASSWORD|PASSWD|SECRET|TOKEN)\w*\s*[=:]\s*([^\s`'",;)]+)/gi)].map((m) => m[1]);
    for (const valor of asignaciones) expect(valor).toBe(marcador);
    const urlsConClave = [...texto.matchAll(/:\/\/[^\s/:@]+:([^\s@]+)@/g)].map((m) => m[1]);
    expect(urlsConClave).toEqual([]);
  });
});

describe('la sección «Docker (RNF03)»: lo que los comandos no deben fijar', () => {
  const seccion = () => {
    const texto = readme();
    const inicio = texto.indexOf('## Docker (RNF03)');
    expect(inicio).toBeGreaterThan(-1);
    return texto.slice(inicio, texto.indexOf('\n## ', inicio + 1));
  };
  // Los `docker run` de los bloques de código: cada orden con sus líneas de continuación (`\`) unidas.
  const ordenesDockerRun = () => [...seccion().matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((bloque) => bloque[1].replace(/\\\n\s*/g, ' ').split('\n'))
    .filter((linea) => linea.startsWith('docker run'));

  it('tiene los dos `docker run` (migrar y arrancar) y ninguno fija la contraseña de la base: `-e DB_PASSWORD` sin valor', () => {
    const ordenes = ordenesDockerRun();
    expect(ordenes).toHaveLength(2);
    for (const orden of ordenes) {
      expect(orden).toMatch(/-e DB_PASSWORD(\s|$)/);
      expect(orden).not.toMatch(/DB_PASSWORD=/);
    }
  });

  it('no publica el 3000 del equipo (otro proyecto puede tenerlo): el puerto sale de PUERTO_LIBRE y solo en 127.0.0.1', () => {
    const arranque = ordenesDockerRun().find((orden) => orden.includes('-p '));
    expect(arranque).toContain('-p 127.0.0.1:$PUERTO_LIBRE:3000');
    expect(seccion()).not.toMatch(/127\.0\.0\.1:3000:|-p 3000:|-p \d+:\d+(\s|$)/); // ni el 3000 del equipo ni «todas las interfaces»
  });

  it('avisa del puerto ocupado y de la contraseña ANTES de los comandos', () => {
    const texto = seccion();
    const primeraOrden = texto.indexOf('```bash\ndocker run');
    expect(primeraOrden).toBeGreaterThan(-1);
    const antes = texto.slice(0, primeraOrden);
    expect(antes).toContain('PUERTO_LIBRE');
    expect(antes).toMatch(/puede estar ocupado/);
    expect(antes).toContain('docker rm ms-inventario');
    expect(antes).toContain('read -rs DB_PASSWORD');
  });
});
