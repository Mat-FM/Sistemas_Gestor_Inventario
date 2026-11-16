// Acceso a datos de la tabla `umbrales_producto` (RNF13): aquí vive todo el SQL de los umbrales y nada de lógica de negocio.
// Todas las funciones reciben primero `dbOrTrx`, la instancia de Knex o una transacción, para poder componerse dentro de una
// transacción (el motor de movimientos, Tarea 7). Un Umbral es { id_producto, cantidad_minima, fecha_actualizacion }; la clave
// primaria es el id del producto en ms-catalogo, así que un producto tiene a lo sumo un umbral.
//
// Toda función es `async` (Ruling 21): sin `async`, Knex devuelve su builder (un thenable, no una Promise): un fallo síncrono
// saldría como excepción y no como rechazo, y esperar dos veces el mismo valor ejecutaría la consulta dos veces. Quien añada
// una función a este repositorio debe declararla `async`; umbralesCapas.test.js lo comprueba con la lista de las exportadas.

const TABLA = 'umbrales_producto';
const COLUMNAS = ['id_producto', 'cantidad_minima', 'fecha_actualizacion'];

/** @returns {Promise<Umbral|undefined>} undefined si el producto no tiene umbral */
async function findByProducto(dbOrTrx, idProducto) {
  return dbOrTrx(TABLA).select(COLUMNAS).where({ id_producto: idProducto }).first();
}

/**
 * Una página de umbrales ordenados por id_producto (orden estable: la paginación no repite ni salta filas) y el total de los
 * que cumplen el filtro, no el de la página. Son dos consultas: con `count(*) over()` una página fuera de rango devolvería
 * total 0.
 * @param {{idProducto?: number, limit: number, offset: number}} opciones `idProducto` undefined no filtra
 * @returns {Promise<{filas: Umbral[], total: number}>}
 */
async function list(dbOrTrx, { idProducto, limit, offset }) {
  const filtrar = (consulta) => (idProducto === undefined ? consulta : consulta.where({ id_producto: idProducto }));
  const [{ total }] = await filtrar(dbOrTrx(TABLA)).count({ total: '*' });
  const filas = await filtrar(dbOrTrx(TABLA).select(COLUMNAS)).orderBy('id_producto').limit(limit).offset(offset);
  return { filas, total: Number(total) };
}

/**
 * Crea el umbral del producto o, si ya tenía uno, le cambia la cantidad mínima y refresca `fecha_actualizacion` (también si
 * el valor no cambia). Es una sola sentencia INSERT … ON CONFLICT (id_producto) DO UPDATE … RETURNING: sin lectura previa no
 * hay carrera entre dos PUT del mismo producto, que dejan una sola fila.
 * No valida `cantidadMinima`: una cantidad negativa la rechaza la base (23514) y la valida quien llama.
 * @returns {Promise<Umbral>} la fila resultante, creada o actualizada
 */
async function upsert(dbOrTrx, idProducto, cantidadMinima) {
  const [umbral] = await dbOrTrx(TABLA)
    .insert({ id_producto: idProducto, cantidad_minima: cantidadMinima })
    .onConflict('id_producto')
    .merge({ cantidad_minima: dbOrTrx.raw('EXCLUDED.cantidad_minima'), fecha_actualizacion: dbOrTrx.fn.now() })
    .returning(COLUMNAS);
  return umbral;
}

module.exports = { findByProducto, list, upsert };
