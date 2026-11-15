// Esquema de ms-inventario: las ocho tablas de la Figura 5 de la Entrega 2 (p. 17) más dos columnas que el diagrama
// no dibuja: lotes.id_producto (D1) y conteos.clave_aprobacion (D5).
//
// - Sin claves foráneas hacia otros servicios: id_producto e id_usuario son identificadores sin restricción (RNF02).
// - Cantidades enteras (D2). Lo que tiene historia no se borra, así que solo detalles_conteo cae en cascada con su conteo.
// - Cada restricción y cada índice lleva nombre propio y estable: `<tabla>_<columnas>_key` (únicas), `_fkey`
//   (foráneas), `_pkey` e `_idx`. El servicio detecta una clave de idempotencia repetida por el nombre
//   `movimientos_clave_idempotencia_key` (Tarea 7): no se renombra.
// - Una migración es una instantánea: repite aquí los valores de las listas en lugar de importar el código del
//   servicio, para que cambiar el código no reescriba el pasado.

const TIPOS_MOVIMIENTO = [
  'ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION_CLIENTE', 'ENTRADA_COMPRA',
  'DEVOLUCION_PROVEEDOR', 'TRASLADO_SALIDA', 'TRASLADO_ENTRADA', 'CARGA_INICIAL',
];
const ESTADOS_TRASLADO = ['EN_TRANSITO', 'RECIBIDO'];
const ESTADOS_CONTEO = ['PROGRAMADO', 'EN_REVISION', 'APROBADO'];

// Predicado `columna IN ('A', 'B')`. Los valores son constantes de este archivo, nunca datos de entrada.
const enLista = (columna, valores) => `${columna} IN (${valores.map((valor) => `'${valor}'`).join(', ')})`;

// Las marcas de tiempo guardan el instante con zona horaria; por defecto, la hora del servidor de base de datos.
const marcaDeTiempo = (knex, tabla, nombre) => tabla.timestamp(nombre, { useTz: true }).notNullable().defaultTo(knex.fn.now());

exports.up = async (knex) => {
  await knex.schema.createTable('bodegas', (tabla) => {
    tabla.increments('id_bodega');
    tabla.string('codigo', 30).notNullable();
    tabla.string('nombre', 100).notNullable();
    tabla.string('ciudad', 100).notNullable();
    tabla.string('direccion', 255).notNullable();
    tabla.boolean('activa').notNullable().defaultTo(true);
    tabla.unique(['codigo'], { indexName: 'bodegas_codigo_key' });
  });

  await knex.schema.createTable('saldos', (tabla) => {
    tabla.increments('id_saldo');
    tabla.integer('id_producto').notNullable();
    tabla.integer('id_bodega').notNullable();
    tabla.integer('cantidad_disponible').notNullable().defaultTo(0);
    marcaDeTiempo(knex, tabla, 'fecha_actualizacion');
    tabla.unique(['id_producto', 'id_bodega'], { indexName: 'saldos_id_producto_id_bodega_key' });
    tabla.foreign('id_bodega', 'saldos_id_bodega_fkey').references('id_bodega').inTable('bodegas');
    tabla.check('cantidad_disponible >= 0', [], 'saldos_cantidad_no_negativa');
  });

  await knex.schema.createTable('lotes', (tabla) => {
    tabla.increments('id_lote');
    tabla.integer('id_bodega').notNullable();
    tabla.integer('id_producto').notNullable();
    tabla.string('codigo_lote', 50).notNullable();
    tabla.date('fecha_vencimiento');
    tabla.integer('cantidad_disponible').notNullable();
    tabla.unique(['id_bodega', 'id_producto', 'codigo_lote'], { indexName: 'lotes_id_bodega_id_producto_codigo_lote_key' });
    tabla.foreign('id_bodega', 'lotes_id_bodega_fkey').references('id_bodega').inTable('bodegas');
    tabla.check('cantidad_disponible >= 0', [], 'lotes_cantidad_no_negativa');
  });

  await knex.schema.createTable('traslados', (tabla) => {
    tabla.increments('id_traslado');
    tabla.integer('id_producto').notNullable();
    tabla.integer('id_bodega_origen').notNullable();
    tabla.integer('id_bodega_destino').notNullable();
    tabla.integer('id_lote');
    tabla.integer('cantidad').notNullable();
    tabla.string('estado', 20).notNullable();
    marcaDeTiempo(knex, tabla, 'fecha_envio');
    tabla.timestamp('fecha_recepcion', { useTz: true });
    tabla.integer('id_usuario_envia').notNullable();
    tabla.integer('id_usuario_recibe');
    tabla.foreign('id_bodega_origen', 'traslados_id_bodega_origen_fkey').references('id_bodega').inTable('bodegas');
    tabla.foreign('id_bodega_destino', 'traslados_id_bodega_destino_fkey').references('id_bodega').inTable('bodegas');
    tabla.foreign('id_lote', 'traslados_id_lote_fkey').references('id_lote').inTable('lotes');
    tabla.check('cantidad > 0', [], 'traslados_cantidad_positiva');
    tabla.check(enLista('estado', ESTADOS_TRASLADO), [], 'traslados_estado_valido');
    tabla.check('id_bodega_origen <> id_bodega_destino', [], 'traslados_bodegas_distintas');
  });

  await knex.schema.createTable('conteos', (tabla) => {
    tabla.increments('id_conteo');
    tabla.integer('id_bodega').notNullable();
    tabla.string('estado', 20).notNullable();
    tabla.date('fecha_programada').notNullable();
    tabla.timestamp('fecha_aprobacion', { useTz: true });
    tabla.integer('id_usuario_aprueba');
    // D5: detecta la repetición de una aprobación aunque no haya generado ningún ajuste. No aparece en la API.
    tabla.string('clave_aprobacion', 255);
    tabla.unique(['clave_aprobacion'], { indexName: 'conteos_clave_aprobacion_key' });
    tabla.foreign('id_bodega', 'conteos_id_bodega_fkey').references('id_bodega').inTable('bodegas');
    tabla.check(enLista('estado', ESTADOS_CONTEO), [], 'conteos_estado_valido');
  });

  await knex.schema.createTable('detalles_conteo', (tabla) => {
    tabla.increments('id_detalle_conteo');
    tabla.integer('id_conteo').notNullable();
    tabla.integer('id_producto').notNullable();
    tabla.integer('cantidad_sistema').notNullable();
    tabla.integer('cantidad_contada');
    tabla.integer('diferencia');
    tabla.unique(['id_conteo', 'id_producto'], { indexName: 'detalles_conteo_id_conteo_id_producto_key' });
    tabla.foreign('id_conteo', 'detalles_conteo_id_conteo_fkey').references('id_conteo').inTable('conteos').onDelete('CASCADE');
  });

  await knex.schema.createTable('movimientos', (tabla) => {
    tabla.increments('id_movimiento');
    tabla.string('tipo', 30).notNullable();
    tabla.integer('id_producto').notNullable();
    tabla.integer('id_bodega').notNullable();
    tabla.integer('id_lote');
    tabla.integer('id_traslado');
    tabla.integer('id_conteo');
    // Con signo solo en AJUSTE (D3); nunca 0. En los demás tipos el signo lo pone el tipo, no la cantidad.
    tabla.integer('cantidad').notNullable();
    // Saldo de ese producto en esa bodega después del movimiento: nunca negativo (saldos.cantidad_disponible >= 0).
    tabla.integer('saldo_resultante').notNullable();
    marcaDeTiempo(knex, tabla, 'fecha');
    tabla.integer('id_usuario').notNullable();
    tabla.string('clave_idempotencia', 255).notNullable();
    tabla.string('documento_referencia', 100);
    tabla.string('observacion', 500);
    tabla.unique(['clave_idempotencia'], { indexName: 'movimientos_clave_idempotencia_key' });
    tabla.foreign('id_bodega', 'movimientos_id_bodega_fkey').references('id_bodega').inTable('bodegas');
    tabla.foreign('id_lote', 'movimientos_id_lote_fkey').references('id_lote').inTable('lotes');
    tabla.foreign('id_traslado', 'movimientos_id_traslado_fkey').references('id_traslado').inTable('traslados');
    tabla.foreign('id_conteo', 'movimientos_id_conteo_fkey').references('id_conteo').inTable('conteos');
    tabla.check(enLista('tipo', TIPOS_MOVIMIENTO), [], 'movimientos_tipo_valido');
    tabla.check('cantidad <> 0', [], 'movimientos_cantidad_no_cero');
    tabla.check("tipo = 'AJUSTE' OR cantidad > 0", [], 'movimientos_cantidad_con_signo_solo_ajuste');
    tabla.check('saldo_resultante >= 0', [], 'movimientos_saldo_resultante_no_negativo');
  });
  // Kardex de un producto y de una bodega, del más reciente al más antiguo. Knex no expresa DESC en un índice.
  await knex.raw('CREATE INDEX movimientos_id_producto_fecha_idx ON movimientos (id_producto, fecha DESC)');
  await knex.raw('CREATE INDEX movimientos_id_bodega_fecha_idx ON movimientos (id_bodega, fecha DESC)');

  await knex.schema.createTable('umbrales_producto', (tabla) => {
    // La clave es el identificador del producto en ms-catalogo: no se genera aquí.
    tabla.integer('id_producto').notNullable();
    tabla.integer('cantidad_minima').notNullable();
    marcaDeTiempo(knex, tabla, 'fecha_actualizacion');
    tabla.primary(['id_producto'], { constraintName: 'umbrales_producto_pkey' });
    tabla.check('cantidad_minima >= 0', [], 'umbrales_producto_cantidad_minima_no_negativa');
  });
};

// Orden inverso al de creación: primero las tablas que apuntan a otras.
exports.down = async (knex) => {
  for (const tabla of ['umbrales_producto', 'movimientos', 'detalles_conteo', 'conteos', 'traslados', 'lotes', 'saldos', 'bodegas']) {
    await knex.schema.dropTableIfExists(tabla);
  }
};
