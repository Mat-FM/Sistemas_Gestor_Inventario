const fs = require('node:fs');
const path = require('node:path');

// Guarda estática del libro de decisiones (DECISIONES.md). El código, las migraciones, el README y el OpenAPI citan decisiones de
// diseño por su identificador (`D27`, `D25b`, `D31(f)`, `Ruling 21`): quien los lee tiene que poder resolverlas en el libro. La
// comprobación se DERIVA del texto (no hay una lista copiada de identificadores): extrae las referencias de los archivos del
// servicio y exige que cada una tenga su entrada, y que el libro no cite nada que no exista ni tenga huecos en la numeración.
//
// Alcance: `src/`, `migrations/`, `README.md` y `openapi.yaml`, que son lo que lee quien revisa el servicio. `tests/` queda fuera:
// esta misma prueba lleva identificadores inventados para sus controles, y una prueba nueva con una etiqueta provisional no debe
// romper una guarda de documentación. (Hoy las pruebas citan solo decisiones que el libro ya recoge.)

const RAIZ = path.join(__dirname, '..');
const leer = (ruta) => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');

/** Los archivos `.js` de una carpeta del servicio, recursivamente, como rutas relativas a la raíz del servicio. */
function archivosJs(carpeta) {
  return fs.readdirSync(path.join(RAIZ, carpeta), { withFileTypes: true }).flatMap((entrada) => {
    const ruta = `${carpeta}/${entrada.name}`;
    if (entrada.isDirectory()) return archivosJs(ruta);
    return entrada.name.endsWith('.js') ? [ruta] : [];
  });
}

/** Los textos que citan decisiones: { ruta: texto }. */
function fuentesDelServicio() {
  const rutas = [...archivosJs('src'), ...archivosJs('migrations'), 'README.md', 'openapi.yaml'];
  return Object.fromEntries(rutas.map((ruta) => [ruta, leer(ruta)]));
}

// `D27`, `D25b` (con letra pegada) y `D31(f)` o `D32(a)(b)` (letras entre paréntesis): el lookahead impide leer `D1D1D1`, `D25bc`
// o un identificador que solo contiene un `D3`; no lleva `\b` final porque tras `)` no hay frontera de palabra.
const PATRON_DECISION = /\bD(\d+)([a-z])?(?![A-Za-z0-9])((?:\([a-z]\))*)/g;
const PATRON_RULING = /\bRuling (\d+)\b/g;

/** Las referencias de un texto: `D27`, `D27(c)`, `D25b`, `Ruling 15`. Una `D32(a)(b)` cuenta como `D32`, `D32(a)` y `D32(b)`. */
function referenciasDe(texto) {
  const referencias = new Set();
  for (const [, numero, letra = '', subletras] of texto.matchAll(PATRON_DECISION)) {
    const base = `D${numero}${letra}`;
    referencias.add(base);
    for (const [, subletra] of subletras.matchAll(/\(([a-z])\)/g)) referencias.add(`${base}(${subletra})`);
  }
  for (const [, numero] of texto.matchAll(PATRON_RULING)) referencias.add(`Ruling ${numero}`);
  return referencias;
}

/**
 * Las entradas del libro. Cada una empieza con un encabezado `## D27. Título` o `## Ruling 15. Título`; sus apartados con
 * letra son viñetas `- **(a)** …`, que son lo que cita `D27(a)`. Devuelve las entradas con sus letras y los encabezados repetidos.
 */
function entradasDelLibro(libro) {
  const entradas = new Map();
  const repetidas = [];
  let actual = null;
  for (const linea of libro.split('\n')) {
    const encabezado = /^##\s+(D\d+[a-z]?|Ruling \d+)\.\s/.exec(linea);
    if (encabezado) {
      if (entradas.has(encabezado[1])) repetidas.push(encabezado[1]);
      actual = entradas.get(encabezado[1]) ?? new Set();
      entradas.set(encabezado[1], actual);
      continue;
    }
    const apartado = actual && /^- \*\*\(([a-z])\)\*\*/.exec(linea);
    if (apartado) actual.add(apartado[1]);
  }
  return { entradas, repetidas };
}

/** ¿Tiene el libro entrada para esa referencia (y, si es `D27(c)`, el apartado `(c)` de la entrada `D27`)? */
function tieneEntrada(referencia, entradas) {
  const subreferencia = /^(D\d+[a-z]?)\(([a-z])\)$/.exec(referencia);
  if (subreferencia) return entradas.get(subreferencia[1])?.has(subreferencia[2]) ?? false;
  return entradas.has(referencia);
}

/**
 * Contrasta el libro con los textos que lo citan.
 * - `sinEntrada`: referencias de las fuentes (`D99 (src/a.js)`) que el libro no define.
 * - `citasRotas`: referencias que el propio libro hace a algo que no define.
 * - `numeracion`: problemas de numeración (encabezados repetidos, huecos entre D1 y la última, una `D25b` sin su `D25`).
 * @param {string} libro texto de DECISIONES.md
 * @param {Record<string, string>} fuentes ruta → texto
 */
function comprobarLibro(libro, fuentes) {
  const { entradas, repetidas } = entradasDelLibro(libro);
  const sinEntrada = [];
  for (const [ruta, texto] of Object.entries(fuentes)) {
    for (const referencia of referenciasDe(texto)) if (!tieneEntrada(referencia, entradas)) sinEntrada.push(`${referencia} (${ruta})`);
  }
  const citasRotas = [...referenciasDe(libro)].filter((referencia) => !tieneEntrada(referencia, entradas));

  const numeracion = repetidas.map((id) => `encabezado repetido: ${id}`);
  const numeros = new Set([...entradas.keys()].map((id) => /^D(\d+)$/.exec(id)?.[1]).filter(Boolean).map(Number));
  for (let n = 1; n <= Math.max(0, ...numeros); n += 1) if (!numeros.has(n)) numeracion.push(`falta la entrada D${n}`);
  for (const id of entradas.keys()) {
    const conLetra = /^(D\d+)[a-z]$/.exec(id);
    if (conLetra && !entradas.has(conLetra[1])) numeracion.push(`${id} no tiene su entrada ${conLetra[1]}`);
  }
  return { sinEntrada, citasRotas, numeracion };
}

const libro = () => leer('DECISIONES.md');

/** El libro sin la sección de `id` (desde su encabezado hasta el siguiente `## `). */
function sinSeccion(texto, id) {
  const lineas = texto.split('\n');
  const inicio = lineas.findIndex((linea) => linea.startsWith(`## ${id}. `));
  if (inicio < 0) throw new Error(`El libro no tiene la entrada ${id}`);
  let fin = lineas.findIndex((linea, i) => i > inicio && linea.startsWith('## '));
  if (fin < 0) fin = lineas.length;
  return [...lineas.slice(0, inicio), ...lineas.slice(fin)].join('\n');
}

describe('cómo se extraen las referencias (para que la guarda no mienta)', () => {
  it('lee D<n>, D<n><letra>, D<n>(letra) y varias letras seguidas, y Ruling <n>', () => {
    expect([...referenciasDe('(D3, D25b) y D31(f); D32(a)(b), Ruling 15.')].sort()).toEqual(
      ['D3', 'D25b', 'D31', 'D31(f)', 'D32', 'D32(a)', 'D32(b)', 'Ruling 15'].sort(),
    );
  });

  it('no lee lo que solo se parece: ID3, D1D1D1, D25bc, la palabra «Dos», «Rulings 5» ni «Ruling» sin número', () => {
    expect([...referenciasDe('ID3 #D1D1D1 D25bc Dos D Rulings 5 y 11, Ruling uno, xD7')]).toEqual([]);
  });

  it('control: en el servicio real hay referencias de todos los tipos (si no, la comprobación de abajo pasaría en vacío)', () => {
    const todas = new Set(Object.values(fuentesDelServicio()).flatMap((texto) => [...referenciasDe(texto)]));
    expect(todas.size).toBeGreaterThan(60);
    for (const esperada of ['D1', 'D8', 'D25b', 'D25c', 'D25d', 'D27(c)', 'D31(f)', 'D32(a)', 'D34', 'Ruling 21']) expect(todas).toContain(esperada);
    expect(Object.keys(fuentesDelServicio())).toEqual(expect.arrayContaining(['src/services/stockService.js', 'migrations/20261103000100_esquema_inventario.js', 'README.md', 'openapi.yaml']));
  });
});

describe('DECISIONES.md', () => {
  it('define cada decisión y cada Ruling que citan el código, las migraciones, el README y el OpenAPI', () => {
    const { sinEntrada } = comprobarLibro(libro(), fuentesDelServicio());
    expect(sinEntrada).toEqual([]);
  });

  it('no cita nada que no defina, y su numeración no tiene huecos, repetidos ni letras sin su base', () => {
    const { citasRotas, numeracion } = comprobarLibro(libro(), {});
    expect(citasRotas).toEqual([]);
    expect(numeracion).toEqual([]);
  });

  it('control: el libro tiene entradas de decisiones, de decisiones con letra, de Rulings y apartados con letra', () => {
    const { entradas } = entradasDelLibro(libro());
    const claves = [...entradas.keys()];
    expect(claves.filter((id) => /^D\d+$/.test(id)).length).toBeGreaterThanOrEqual(30);
    expect(claves).toEqual(expect.arrayContaining(['D25b', 'D25c', 'D25d']));
    expect(claves.filter((id) => id.startsWith('Ruling ')).length).toBeGreaterThanOrEqual(9);
    expect([...entradas.get('D32')]).toEqual(expect.arrayContaining(['a', 'e', 'j']));
  });

  it('cada entrada dice QUÉ se decidió y POR QUÉ, con algo más que el título', () => {
    const cuerpos = libro().split(/^## /m).slice(1);
    for (const cuerpo of cuerpos) {
      const [titulo, ...resto] = cuerpo.split('\n');
      expect({ titulo, lineas: resto.filter((linea) => linea.trim() !== '').length >= 2 }).toEqual({ titulo, lineas: true });
    }
  });

  it('no arrastra el vocabulario del proceso interno (números de tarea, implementador, revisor)', () => {
    expect(libro()).not.toMatch(/\bTareas? \d+|\bimplementador|\brevisor\b|\bronda\b/i);
  });

  it('el README lo enlaza desde la sección «Estructura»', () => {
    const readme = leer('README.md');
    const inicio = readme.indexOf('## Estructura');
    const fin = readme.indexOf('\n## ', inicio + 1);
    expect(inicio).toBeGreaterThan(-1);
    expect(readme.slice(inicio, fin)).toContain('[`DECISIONES.md`](DECISIONES.md)');
  });
});

describe('mutaciones de la comprobación (sobre copias en memoria: nada se escribe en disco)', () => {
  it('borrar una entrada que el código cita (D5, D27, Ruling 21) la delata, con la fuente que la cita', () => {
    for (const id of ['D5', 'D27', 'Ruling 21']) {
      const { sinEntrada } = comprobarLibro(sinSeccion(libro(), id), fuentesDelServicio());
      expect(sinEntrada.length).toBeGreaterThan(0);
      expect(sinEntrada.every((linea) => linea.startsWith(`${id} (`) || linea.startsWith(`${id}(`))).toBe(true);
    }
  });

  it('una referencia que no existe en un comentario de una copia de un archivo real es lo único que se delata', () => {
    const fuentes = fuentesDelServicio();
    const copia = { ...fuentes, 'src/services/stockService.js': `${fuentes['src/services/stockService.js']}\n// D99, Ruling 999 y D27(z)\n` };
    expect(comprobarLibro(libro(), copia).sinEntrada.sort()).toEqual([
      'D27(z) (src/services/stockService.js)', 'D99 (src/services/stockService.js)', 'Ruling 999 (src/services/stockService.js)',
    ]);
  });

  it('lo mismo en el README y en el OpenAPI', () => {
    const fuentes = fuentesDelServicio();
    for (const ruta of ['README.md', 'openapi.yaml']) {
      const { sinEntrada } = comprobarLibro(libro(), { ...fuentes, [ruta]: `${fuentes[ruta]}\nVer D98.\n` });
      expect(sinEntrada).toEqual([`D98 (${ruta})`]);
    }
  });

  it('un apartado con letra que el libro no tiene (D27(z)) se delata aunque exista D27', () => {
    expect(comprobarLibro(libro(), { 'x.js': '// D27(c) sí y D27(z) no' }).sinEntrada).toEqual(['D27(z) (x.js)']);
  });

  it('una cita rota DENTRO del libro, un hueco en la numeración y un encabezado repetido se delatan', () => {
    const conCitaRota = `${libro()}\nVéase D77.\n`;
    expect(comprobarLibro(conCitaRota, {}).citasRotas).toEqual(['D77']);
    const sinEncabezado = libro().replace(/^## D9\. .*$/m, 'Sin encabezado.');
    expect(comprobarLibro(sinEncabezado, {}).numeracion).toEqual(['falta la entrada D9']);
    const repetido = `${libro()}\n## D3. Otra vez\n\nUna línea.\nOtra línea.\n`;
    expect(comprobarLibro(repetido, {}).numeracion).toEqual(['encabezado repetido: D3']);
    const sinBase = sinSeccion(libro(), 'D25');
    expect(comprobarLibro(sinBase, {}).numeracion).toEqual([
      'falta la entrada D25', 'D25b no tiene su entrada D25', 'D25c no tiene su entrada D25', 'D25d no tiene su entrada D25',
    ]);
  });
});
