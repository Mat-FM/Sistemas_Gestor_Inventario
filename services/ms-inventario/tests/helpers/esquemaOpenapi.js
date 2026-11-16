// Validador mínimo de valores JSON contra los esquemas de un documento OpenAPI 3.0 (RNF08). Es propio y de pruebas: no se añadió ajv ni
// ningún validador de OpenAPI (RNF15, librerías solo con permiso del usuario). Sirve para que openapi.yaml no se desfase del código:
// las pruebas ejecutan la API de verdad y comprueban que cada respuesta cumple el esquema que el documento promete.
//
// Solo entiende el subconjunto de OpenAPI que usa el documento. Una palabra clave que NO implementa lanza un Error y nunca se
// ignora en silencio: un esquema con una restricción que nadie aplica daría una garantía falsa. Lo que entiende:
//   $ref, type (string, integer, number, boolean, object, array), nullable, enum, format (date, date-time —solo como lo escribe
//   Date#toISOString()—, int32, int64),
//   minimum, maximum, minLength, maxLength, properties, required, additionalProperties (false, true o un esquema), items,
//   minItems, maxItems, uniqueItems.
// Las anotaciones (description, example, title, default…) y las extensiones x-* no restringen nada y se ignoran.
// No hay allOf/oneOf/anyOf: en OpenAPI 3.0 combinarlos con additionalProperties:false falla (se evalúa por subesquema), así que
// el documento usa esquemas planos.

const ANOTACIONES = new Set(['description', 'example', 'examples', 'title', 'default', 'externalDocs', 'deprecated', 'readOnly', 'writeOnly', 'xml']);
const RESTRICCIONES = new Set([
  'type', 'nullable', 'enum', 'format', 'minimum', 'maximum', 'minLength', 'maxLength', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
]);
const TIPOS = new Set(['string', 'integer', 'number', 'boolean', 'object', 'array']);
const FORMATOS_POR_TIPO = { string: new Set(['date', 'date-time']), integer: new Set(['int32', 'int64']), number: new Set([]) };

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const esObjeto = (valor) => typeof valor === 'object' && valor !== null && !Array.isArray(valor);
const esExtension = (clave) => clave.startsWith('x-');

/**
 * Resuelve una referencia local `#/a/b/c` dentro del documento. Lanza si no resuelve (una referencia rota es un defecto del
 * documento, no un valor inválido).
 */
function resolverRef(documento, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`esquemaOpenapi: la referencia "${ref}" no es local (#/...)`);
  let nodo = documento;
  for (const parte of ref.slice(2).split('/')) {
    const clave = parte.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!esObjeto(nodo) || !(clave in nodo)) throw new Error(`esquemaOpenapi: la referencia "${ref}" no resuelve (falta "${clave}")`);
    nodo = nodo[clave];
  }
  return nodo;
}

const esFechaReal = (texto) => {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!partes) return false;
  const [anio, mes, dia] = partes.slice(1).map(Number);
  // Date.UTC(anio, ...) lleva los años 0 a 99 a 1900 a 1999: los años 0001 a 0099 se fijan con setUTCFullYear.
  const fecha = new Date(0);
  fecha.setUTCFullYear(anio, mes - 1, dia);
  // Date corrige las fechas imposibles (30 de febrero): se exige que el día vuelva igual.
  return anio >= 1 && fecha.getUTCFullYear() === anio && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia;
};

// En ESTE documento `format: date-time` significa lo que escribe Date#toISOString(): UTC con la Z y exactamente tres decimales
// (2026-11-15T10:00:00.000Z). No es el date-time más amplio de la RFC 3339 (con otro huso o sin milisegundos): el documento promete
// ese formato y un desfase del servidor (p. ej. un replacer que escriba ...05-00:00) tiene que ponerse en rojo.
const esFechaHora = (texto) => {
  const partes = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\.\d{3}Z$/.exec(texto);
  return partes !== null && esFechaReal(partes[1]);
};

const largoEnCaracteres = (texto) => [...texto].length;

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function describirTipo(valor) {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return 'arreglo';
  return typeof valor;
}

// Revisión ESTRUCTURAL de un esquema (sin valor): palabras clave soportadas, `$ref` sin hermanos, `required` ⊆ `properties` y
// referencias que resuelven. La comparten `validar` (que lanza el primer problema) y `revisarEsquema` (que los lista todos).
function problemasDelNodo(documento, esquema, ruta) {
  if (!esObjeto(esquema)) return [`${ruta}: un esquema debe ser un objeto`];
  const problemas = [];
  if ('$ref' in esquema) {
    const hermanos = Object.keys(esquema).filter((clave) => clave !== '$ref');
    if (hermanos.length > 0) problemas.push(`${ruta}: en OpenAPI 3.0 los hermanos de $ref se ignoran (${hermanos.join(', ')}): use un esquema en línea`);
    try {
      resolverRef(documento, esquema.$ref);
    } catch (error) {
      problemas.push(`${ruta}: ${error.message}`);
    }
    return problemas;
  }
  for (const clave of Object.keys(esquema)) {
    if (!RESTRICCIONES.has(clave) && !ANOTACIONES.has(clave) && !esExtension(clave)) {
      problemas.push(`${ruta}: la palabra clave "${clave}" no está soportada por el validador`);
    }
  }
  if (esquema.type !== undefined && !TIPOS.has(esquema.type)) problemas.push(`${ruta}: type "${esquema.type}" no es válido`);
  if (esquema.format !== undefined) {
    const permitidos = FORMATOS_POR_TIPO[esquema.type];
    if (!permitidos || !permitidos.has(esquema.format)) problemas.push(`${ruta}: el formato "${esquema.format}" no está soportado para el tipo "${esquema.type}"`);
  }
  if (esquema.required !== undefined) {
    const declaradas = esObjeto(esquema.properties) ? Object.keys(esquema.properties) : [];
    if (!Array.isArray(esquema.required)) problemas.push(`${ruta}: required debe ser un arreglo`);
    else for (const nombre of esquema.required) if (!declaradas.includes(nombre)) problemas.push(`${ruta}: required nombra "${nombre}", que no está en properties`);
  }
  if (esquema.items !== undefined && esquema.type !== 'array') problemas.push(`${ruta}: items solo vale con type: array`);
  if (esquema.type === 'array' && esquema.items === undefined) problemas.push(`${ruta}: un arreglo debe declarar items`);
  if (esquema.nullable !== undefined && typeof esquema.nullable !== 'boolean') problemas.push(`${ruta}: nullable debe ser true o false`);
  if (esquema.enum !== undefined && (!Array.isArray(esquema.enum) || esquema.enum.length === 0)) problemas.push(`${ruta}: enum debe ser un arreglo no vacío`);
  return problemas;
}

/**
 * Lista TODOS los problemas estructurales de un esquema y de los que contiene (propiedades, items, additionalProperties), sin mirar
 * ningún valor: palabras clave que el validador no soporta, `$ref` con hermanos o rotos, `required` que nombra propiedades que no
 * existen… No sigue las referencias (cada esquema referenciado se revisa en su sitio).
 * @returns {string[]} vacío si el esquema está bien
 */
function revisarEsquema(documento, esquema, ruta = '$') {
  const problemas = problemasDelNodo(documento, esquema, ruta);
  if (!esObjeto(esquema) || '$ref' in esquema) return problemas;
  // Un esquema sin type admite cualquier valor en silencio: el documento debe declararlo siempre. validar() sí lo admite (el validador
  // no impone esta regla al documento: la impone esta revisión).
  if (esquema.type === undefined) problemas.push(`${ruta}: debe declarar type`);
  for (const [nombre, propiedad] of Object.entries(esObjeto(esquema.properties) ? esquema.properties : {})) {
    problemas.push(...revisarEsquema(documento, propiedad, `${ruta}.${nombre}`));
  }
  if (esquema.items !== undefined) problemas.push(...revisarEsquema(documento, esquema.items, `${ruta}[]`));
  if (esObjeto(esquema.additionalProperties)) problemas.push(...revisarEsquema(documento, esquema.additionalProperties, `${ruta}{}`));
  return problemas;
}

function validarTipo(esquema, valor, ruta) {
  const { type: tipo } = esquema;
  if (tipo === undefined) return [];
  const coincide = {
    string: typeof valor === 'string',
    integer: Number.isInteger(valor),
    number: typeof valor === 'number' && Number.isFinite(valor),
    boolean: typeof valor === 'boolean',
    object: esObjeto(valor),
    array: Array.isArray(valor),
  }[tipo];
  return coincide ? [] : [`${ruta}: debe ser ${tipo} y es ${describirTipo(valor)}`];
}

function validarFormato(esquema, valor, ruta) {
  if (esquema.format === 'date' && !esFechaReal(valor)) return [`${ruta}: debe ser una fecha YYYY-MM-DD real (es ${JSON.stringify(valor)})`];
  if (esquema.format === 'date-time' && !esFechaHora(valor)) return [`${ruta}: debe ser una fecha y hora como la escribe toISOString(), p. ej. 2026-11-15T10:00:00.000Z (es ${JSON.stringify(valor)})`];
  if (esquema.format === 'int32' && (valor < INT32_MIN || valor > INT32_MAX)) return [`${ruta}: fuera del rango int32 (es ${valor})`];
  if (esquema.format === 'int64' && !Number.isSafeInteger(valor)) return [`${ruta}: fuera del rango entero seguro (es ${valor})`];
  return [];
}

function validarNumero(esquema, valor, ruta) {
  const errores = [];
  if (esquema.minimum !== undefined && valor < esquema.minimum) errores.push(`${ruta}: ${valor} es menor que el mínimo ${esquema.minimum}`);
  if (esquema.maximum !== undefined && valor > esquema.maximum) errores.push(`${ruta}: ${valor} es mayor que el máximo ${esquema.maximum}`);
  return errores;
}

function validarTexto(esquema, valor, ruta) {
  const errores = [];
  const largo = largoEnCaracteres(valor);
  if (esquema.minLength !== undefined && largo < esquema.minLength) errores.push(`${ruta}: tiene ${largo} caracteres y el mínimo es ${esquema.minLength}`);
  if (esquema.maxLength !== undefined && largo > esquema.maxLength) errores.push(`${ruta}: tiene ${largo} caracteres y el máximo es ${esquema.maxLength}`);
  return errores;
}

function validarArreglo(contexto, esquema, valor, ruta) {
  const errores = [];
  if (esquema.minItems !== undefined && valor.length < esquema.minItems) errores.push(`${ruta}: tiene ${valor.length} elementos y el mínimo es ${esquema.minItems}`);
  if (esquema.maxItems !== undefined && valor.length > esquema.maxItems) errores.push(`${ruta}: tiene ${valor.length} elementos y el máximo es ${esquema.maxItems}`);
  if (esquema.uniqueItems === true) {
    const vistos = new Set();
    valor.forEach((elemento, posicion) => {
      const huella = JSON.stringify(elemento);
      if (vistos.has(huella)) errores.push(`${ruta}[${posicion}]: elemento repetido`);
      vistos.add(huella);
    });
  }
  // Sin `items` (un esquema sin type que recibe un arreglo) cualquier elemento vale; un type: array sin items ya lo rechazó la revisión.
  if (esquema.items !== undefined) valor.forEach((elemento, posicion) => errores.push(...validarNodo(contexto, esquema.items, elemento, `${ruta}[${posicion}]`)));
  return errores;
}

function validarObjeto(contexto, esquema, valor, ruta) {
  const errores = [];
  const propiedades = esObjeto(esquema.properties) ? esquema.properties : {};
  contexto.observador?.objeto?.(esquema, valor);
  for (const nombre of esquema.required ?? []) {
    if (!(nombre in valor) || valor[nombre] === undefined) errores.push(`${ruta}: falta la propiedad obligatoria "${nombre}"`);
  }
  for (const [nombre, contenido] of Object.entries(valor)) {
    if (nombre in propiedades) errores.push(...validarNodo(contexto, propiedades[nombre], contenido, `${ruta}.${nombre}`));
    else if (esquema.additionalProperties === false) errores.push(`${ruta}: la propiedad "${nombre}" no está declarada (additionalProperties: false)`);
    else if (esObjeto(esquema.additionalProperties)) errores.push(...validarNodo(contexto, esquema.additionalProperties, contenido, `${ruta}.${nombre}`));
  }
  return errores;
}

function validarNodo(contexto, esquema, valor, ruta) {
  const { documento } = contexto;
  const problemas = problemasDelNodo(documento, esquema, ruta);
  if (problemas.length > 0) throw new Error(`esquemaOpenapi: ${problemas.join('; ')}`);
  if ('$ref' in esquema) return validarNodo(contexto, resolverRef(documento, esquema.$ref), valor, ruta);

  if (valor === undefined) return [`${ruta}: falta el valor`];
  contexto.observador?.valor?.(esquema, valor);
  // null solo vale con `nullable: true` (en OpenAPI 3.0 un esquema sin nullable no admite null).
  if (valor === null) return esquema.nullable === true ? [] : [`${ruta}: no puede ser null`];

  const errores = validarTipo(esquema, valor, ruta);
  if (errores.length > 0) return errores; // con el tipo equivocado el resto de las reglas no tiene sentido
  if (esquema.enum !== undefined && !esquema.enum.some((permitido) => igual(permitido, valor))) {
    errores.push(`${ruta}: ${JSON.stringify(valor)} no está entre los valores permitidos (${esquema.enum.map((v) => JSON.stringify(v)).join(', ')})`);
  }
  errores.push(...validarFormato(esquema, valor, ruta));
  if (typeof valor === 'number') errores.push(...validarNumero(esquema, valor, ruta));
  if (typeof valor === 'string') errores.push(...validarTexto(esquema, valor, ruta));
  if (Array.isArray(valor)) errores.push(...validarArreglo(contexto, esquema, valor, ruta));
  if (esObjeto(valor)) errores.push(...validarObjeto(contexto, esquema, valor, ruta));
  return errores;
}

/**
 * Valida un valor JSON contra un esquema del documento.
 * @param {object} documento el documento OpenAPI ya leído (para resolver `$ref`)
 * @param {object} esquema el esquema, con o sin `$ref`
 * @param {unknown} valor lo que se comprueba (un cuerpo de respuesta ya leído como JSON)
 * @param {string} [ruta] prefijo de los mensajes (por defecto `$`)
 * @param {{valor?: (esquema: object, valor: unknown) => void, objeto?: (esquema: object, valor: object) => void}} [observador]
 *   para medir QUÉ se ejercitó (no cambia el resultado): `valor` se llama con cada esquema ya resuelto y el valor que recibió (también
 *   null) y `objeto`, con cada esquema de objeto y el objeto. Las pruebas de conformidad lo usan para exigir que cada campo anulable
 *   se haya visto en sus dos estados y cada campo opcional, presente y ausente.
 * @returns {string[]} los incumplimientos, todos y no solo el primero; vacío si el valor cumple el esquema
 * @throws {Error} si el ESQUEMA usa algo que el validador no soporta o tiene una referencia rota (no es un valor inválido)
 */
function validar(documento, esquema, valor, ruta = '$', observador = undefined) {
  return validarNodo({ documento, observador }, esquema, valor, ruta);
}

module.exports = { validar, revisarEsquema, resolverRef };
