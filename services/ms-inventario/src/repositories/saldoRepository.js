// Acceso a datos de las tablas `saldos` y `umbrales_producto` en lo que toca a los saldos (RNF13): aquí vive todo el SQL de la
// lectura de saldos y del bloqueo y la escritura que usa el motor de movimientos, y nada de lógica de negocio. Todas las funciones reciben primero `dbOrTrx`, la instancia de Knex o
// una transacción, para poder componerse dentro de una transacción (el motor de movimientos, Tarea 7). Un Saldo es
// { id_saldo, id_producto, id_bodega, cantidad_disponible, fecha_actualizacion }.
//
// Toda función es `async` (Ruling 21): sin `async`, Knex devuelve su builder (un thenable, no una Promise): un fallo síncrono
// saldría como excepción y no como rechazo, y esperar dos veces el mismo valor ejecutaría la consulta dos veces. Quien añada
// una función a este repositorio debe declararla `async`; saldosCapas.test.js lo comprueba con la lista de las exportadas.
//
// Los números: COUNT y SUM de PostgreSQL son bigint y `pg` los entrega como texto salvo que se convierta (config/db.js instala
// el convertidor de int8); aun así cada cantidad pasa por Number() aquí, para que este módulo no dependa de ese ajuste global.

const TABLA = 'saldos';
const COLUMNAS = ['id_saldo', 'id_producto', 'id_bodega', 'cantidad_disponible', 'fecha_actualizacion'];

// Una consulta sobre `saldos` restringida por los filtros presentes; un filtro undefined no restringe.
function filtrar(consulta, { idProducto, idBodega }) {
  if (idProducto !== undefined) consulta.where({ id_producto: idProducto });
  if (idBodega !== undefined) consulta.where({ id_bodega: idBodega });
  return consulta;
}

/**
 * Una página de saldos ordenados por id_producto e id_bodega (orden estable: la paginación no repite ni salta filas), con el
 * total de filas y la suma de `cantidad_disponible` de TODAS las que cumplen el filtro, no solo las de la página. El conteo
 * y la suma salen de una misma consulta (mismo filtro, misma lectura); la página, de otra: con `count(*) over()` una página
 * fuera de rango devolvería total 0.
 * @param {{idProducto?: number, idBodega?: number, limit: number, offset: number}} opciones un filtro undefined no filtra
 * @returns {Promise<{filas: Saldo[], total: number, cantidadTotal: number}>} cantidadTotal es 0 si ninguna fila cumple el filtro
 */
async function list(dbOrTrx, { idProducto, idBodega, limit, offset }) {
  const filtro = { idProducto, idBodega };
  const [resumen] = await filtrar(dbOrTrx(TABLA), filtro).count({ total: '*' }).sum({ cantidad_total: 'cantidad_disponible' });
  const filas = await filtrar(dbOrTrx(TABLA).select(COLUMNAS), filtro).orderBy(['id_producto', 'id_bodega']).limit(limit).offset(offset);
  return { filas, total: Number(resumen.total), cantidadTotal: Number(resumen.cantidad_total ?? 0) };
}

/**
 * Suma de `cantidad_disponible` de un producto en todas las bodegas. La usa movimientoService.evaluarUmbral para comparar con
 * el umbral DESPUÉS del commit del movimiento, con la conexión normal (D13).
 * @returns {Promise<number>} 0 si el producto no tiene ninguna fila de saldos
 */
async function totalPorProducto(dbOrTrx, idProducto) {
  const [resumen] = await dbOrTrx(TABLA).where({ id_producto: idProducto }).sum({ total: 'cantidad_disponible' });
  return Number(resumen.total ?? 0);
}

/**
 * Productos cuyo total en todas las bodegas es ESTRICTAMENTE menor que su cantidad mínima (D13: con el total igual al mínimo no
 * hay alerta), ordenados por id_producto. Parte de los umbrales: un producto con umbral y sin ninguna fila de saldos cuenta como
 * total 0 (LEFT JOIN + COALESCE), y uno con umbral 0 nunca alerta (nada es menor que 0). No se pagina: la consumen
 * ms-notificaciones y ms-reportes, que necesitan la lista completa.
 * @returns {Promise<Array<{id_producto: number, cantidad_total: number, cantidad_minima: number}>>}
 */
async function bajoUmbral(dbOrTrx) {
  const total = 'COALESCE(SUM(s.cantidad_disponible), 0)';
  const filas = await dbOrTrx('umbrales_producto as u')
    .leftJoin('saldos as s', 's.id_producto', 'u.id_producto')
    .select('u.id_producto')
    .select(dbOrTrx.raw(`${total} AS cantidad_total`))
    .select('u.cantidad_minima')
    .groupBy('u.id_producto', 'u.cantidad_minima')
    .havingRaw(`${total} < u.cantidad_minima`)
    .orderBy('u.id_producto');
  return filas.map((fila) => ({ id_producto: fila.id_producto, cantidad_total: Number(fila.cantidad_total), cantidad_minima: fila.cantidad_minima }));
}

/**
 * Toma el saldo de (producto, bodega) con un bloqueo de fila hasta el fin de la transacción (motor de movimientos, Tarea 7).
 * Dos sentencias:
 * 1. `INSERT … ON CONFLICT (id_producto, id_bodega) DO NOTHING`: si el saldo no existe nace en 0. Con dos transacciones que
 *    crean el mismo saldo a la vez, la segunda espera a la primera en el índice único y no inserta nada (ni lanza 23505).
 * 2. `SELECT … FOR UPDATE`: bloquea la fila; otra transacción que pida el mismo saldo espera aquí hasta el commit o el rollback.
 * Debe llamarse con una TRANSACCIÓN: con la instancia de Knex cada sentencia se confirma sola y el bloqueo se soltaría en el
 * acto (stockService.aplicarMovimiento lo exige). Si la transacción se deshace, la fila creada en el paso 1 desaparece.
 * @returns {Promise<Saldo>} la fila bloqueada
 */
async function bloquear(trx, { idProducto, idBodega }) {
  await trx(TABLA)
    .insert({ id_producto: idProducto, id_bodega: idBodega, cantidad_disponible: 0 })
    .onConflict(['id_producto', 'id_bodega'])
    .ignore();
  return trx(TABLA).select(COLUMNAS).where({ id_producto: idProducto, id_bodega: idBodega }).forUpdate().first();
}

/**
 * Fija la cantidad de un saldo (el motor ya la calculó con la fila bloqueada) y su `fecha_actualizacion` con
 * `clock_timestamp()`: el instante de la escritura, no `now()`, que es el inicio de la transacción (D24). No valida: una
 * cantidad negativa la rechaza la base (23514) y quien llama debe impedirla antes.
 * @returns {Promise<Saldo|undefined>} el saldo actualizado, o undefined si no existe
 */
async function fijarCantidad(trx, idSaldo, cantidad) {
  const [saldo] = await trx(TABLA)
    .where({ id_saldo: idSaldo })
    .update({ cantidad_disponible: cantidad, fecha_actualizacion: trx.raw('clock_timestamp()') })
    .returning(COLUMNAS);
  return saldo;
}

module.exports = { list, totalPorProducto, bajoUmbral, bloquear, fijarCantidad };
