// Índice del kardex por fecha (RF10, RF15; D30): `GET /movimientos` sin filtros ordena por `fecha DESC, id_movimiento DESC` y lo
// recorre entero `ms-reportes`, de 100 en 100. Los índices de la migración original solo sirven con `id_producto` o `id_bodega`;
// sin este, cada página era un Seq Scan + Sort de toda la tabla (con 60 000 movimientos, ~30 s el recorrido completo).
//
// Es una migración NUEVA y no una edición de `20261103000100_esquema_inventario.js`: las migraciones ya aplicadas son
// inmutables (las bases de los compañeros y de la CI la tienen aplicada y Knex no la reaplica). El orden de las columnas y su
// sentido (`DESC`, `DESC`) son los de la consulta, para que el plan recorra el índice de principio a fin sin ordenar. Nombre
// propio y estable, como el resto: `<tabla>_<columnas>_idx`.

const INDICE = 'movimientos_fecha_id_idx';

exports.up = async (knex) => {
  // Knex no expresa DESC en un índice (como en la migración original).
  await knex.raw(`CREATE INDEX ${INDICE} ON movimientos (fecha DESC, id_movimiento DESC)`);
};

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS ${INDICE}`);
};
