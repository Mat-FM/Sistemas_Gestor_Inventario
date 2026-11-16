// Acceso a datos de la tabla `bodegas` (RNF13): aquí vive todo el SQL de las bodegas y nada de lógica de negocio.
// Todas las funciones reciben primero `dbOrTrx`, la instancia de Knex o una transacción, para poder componerse dentro de
// una transacción más adelante. Una Bodega es { id_bodega, codigo, nombre, ciudad, direccion, activa }.
//
// Toda función que toca la base es `async` (Ruling 21): sin `async`, Knex devuelve su builder (un thenable, no una Promise):
// un fallo síncrono (p. ej. un `db` nulo) saldría como excepción y no como rechazo, y esperar dos veces el mismo valor
// ejecutaría la consulta dos veces. Quien añada una función a este repositorio debe declararla `async`;
// bodegasCapas.test.js lo comprueba con la lista de las exportadas.

const TABLA = 'bodegas';
const COLUMNAS = ['id_bodega', 'codigo', 'nombre', 'ciudad', 'direccion', 'activa'];

// Las dos unicidades del código, tal como las nombra la migración: `bodegas_codigo_key` (código exacto) y el índice funcional
// `bodegas_codigo_lower_key` (sobre lower(codigo): el código es único sin distinguir mayúsculas, Ruling 18). Un código
// repetido viola una u otra, así que se detecta por cualquiera de los dos nombres y no por el texto del mensaje de PostgreSQL
// (que depende del idioma del servidor y de su versión). `pg` informa en `constraint` el nombre del índice también para un
// índice funcional.
const RESTRICCIONES_CODIGO = Object.freeze(['bodegas_codigo_key', 'bodegas_codigo_lower_key']);
const VIOLACION_UNICA = '23505';

/** @returns {Promise<Bodega|undefined>} */
async function findById(dbOrTrx, id) {
  return dbOrTrx(TABLA).select(COLUMNAS).where({ id_bodega: id }).first();
}

/**
 * Busca por código SIN distinguir mayúsculas, con el mismo criterio que la unicidad (lower(codigo)). No recorta: el código
 * se guarda ya recortado y quien busque debe pasarlo recortado. Encuentra también las inactivas.
 */
async function findByCodigo(dbOrTrx, codigo) {
  return dbOrTrx(TABLA).select(COLUMNAS).whereRaw('lower(codigo) = lower(?)', [codigo]).first();
}

/**
 * Una página de bodegas ordenadas por id_bodega (orden estable: la paginación no repite ni salta filas) y el total de las
 * que cumplen el filtro, no el de la página. Son dos consultas: con `count(*) over()` una página fuera de rango devolvería
 * total 0.
 * @param {{activa?: boolean, limit: number, offset: number}} opciones `activa` undefined no filtra
 * @returns {Promise<{filas: Bodega[], total: number}>}
 */
async function list(dbOrTrx, { activa, limit, offset }) {
  const filtrar = (consulta) => (activa === undefined ? consulta : consulta.where({ activa }));
  const [{ total }] = await filtrar(dbOrTrx(TABLA)).count({ total: '*' });
  const filas = await filtrar(dbOrTrx(TABLA).select(COLUMNAS)).orderBy('id_bodega').limit(limit).offset(offset);
  return { filas, total: Number(total) };
}

/**
 * Inserta una bodega activa. Solo toma las cuatro columnas que fija el cliente: `id_bodega` lo genera la base y `activa`
 * arranca en true. Con un código repetido (también si solo difiere en mayúsculas) lanza el 23505 de PostgreSQL (ver
 * esCodigoDuplicado).
 * @returns {Promise<Bodega>}
 */
async function insert(dbOrTrx, { codigo, nombre, ciudad, direccion }) {
  const [bodega] = await dbOrTrx(TABLA).insert({ codigo, nombre, ciudad, direccion }).returning(COLUMNAS);
  return bodega;
}

/**
 * Cambia nombre, ciudad y direccion. El código y el estado no se editan aquí, aunque el objeto traiga más campos.
 * @returns {Promise<Bodega|undefined>} la bodega ya actualizada, o undefined si no existe
 */
async function update(dbOrTrx, id, { nombre, ciudad, direccion }) {
  const [bodega] = await dbOrTrx(TABLA).where({ id_bodega: id }).update({ nombre, ciudad, direccion }).returning(COLUMNAS);
  return bodega;
}

/**
 * Fija el estado con un solo UPDATE … RETURNING: el resultado (existe o no, estado final) sale de la misma sentencia, sin una
 * lectura previa que pueda quedar vieja. Repetirlo con el mismo valor es válido.
 * @returns {Promise<Bodega|undefined>} undefined si la bodega no existe
 */
async function setActiva(dbOrTrx, id, activa) {
  const [bodega] = await dbOrTrx(TABLA).where({ id_bodega: id }).update({ activa }).returning(COLUMNAS);
  return bodega;
}

/** ¿Es este error el 23505 de una de las unicidades del código? Cualquier otro 23505 (u otro error) no lo es. */
function esCodigoDuplicado(error) {
  return error?.code === VIOLACION_UNICA && RESTRICCIONES_CODIGO.includes(error?.constraint);
}

module.exports = { RESTRICCIONES_CODIGO, findById, findByCodigo, list, insert, update, setActiva, esCodigoDuplicado };
