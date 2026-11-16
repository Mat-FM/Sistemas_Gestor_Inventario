// Datos y dobles de prueba compartidos por las suites. `db` puede ser la instancia de Knex o una transacción.
const { e } = require('../../src/errors');

/** Inserta una bodega y devuelve la fila. `codigo` es único: dos bodegas en una misma prueba necesitan códigos distintos. */
async function crearBodega(db, { codigo = 'B1', activa = true } = {}) {
  const [bodega] = await db('bodegas')
    .insert({ codigo, nombre: `Bodega ${codigo}`, ciudad: 'Manizales', direccion: `Calle ${codigo}`, activa })
    .returning('*');
  return bodega;
}

/** Inserta el saldo de un producto en una bodega y devuelve la fila. */
async function crearSaldo(db, { idProducto, idBodega, cantidad = 0 }) {
  const [saldo] = await db('saldos')
    .insert({ id_producto: idProducto, id_bodega: idBodega, cantidad_disponible: cantidad })
    .returning('*');
  return saldo;
}

/**
 * Inserta el umbral de stock mínimo de un producto y devuelve la fila. Es una siembra directa con Knex: las pruebas de saldos
 * no dependen del código de umbrales. `id_producto` es la clave primaria, así que un producto solo tiene un umbral.
 */
async function crearUmbral(db, { idProducto, cantidadMinima }) {
  const [umbral] = await db('umbrales_producto')
    .insert({ id_producto: idProducto, cantidad_minima: cantidadMinima })
    .returning('*');
  return umbral;
}

/** Inserta un lote y devuelve la fila. `fecha_vencimiento` vuelve como texto YYYY-MM-DD o null (Ruling 15, config/db.js). */
async function crearLote(db, { idBodega, idProducto, codigoLote, fechaVencimiento = null, cantidad }) {
  const [lote] = await db('lotes')
    .insert({
      id_bodega: idBodega,
      id_producto: idProducto,
      codigo_lote: codigoLote,
      fecha_vencimiento: fechaVencimiento,
      cantidad_disponible: cantidad,
    })
    .returning('*');
  return lote;
}

// Contador de las claves de idempotencia que `crearMovimiento` inventa: nunca repite una (la columna es única). Sigue creciendo
// aunque `truncateAll` vacíe la tabla; los números no se reutilizan dentro de un proceso de Jest y no importa.
let siguienteClave = 0;

/**
 * Inserta un movimiento DIRECTAMENTE con Knex (una siembra, no el motor: no toca el saldo ni los lotes) y devuelve la fila tal
 * como está en la tabla, también `clave_idempotencia`. Sirve para sembrar el kardex con la `fecha` que pida la prueba.
 * - `idBodega` es obligatoria (la clave foránea exige que la bodega exista); `idLote`, `idTraslado` e `idConteo` también
 *   referencian filas reales y por defecto son null.
 * - `fecha`: un `Date` o un texto ISO 8601 CON zona (`2026-11-01T00:00:00Z`; un texto sin zona dependería del huso de la sesión).
 *   Sin ella, la base pone `now()`.
 * - `cantidad` y `saldoResultante` valen 1 por defecto (la restricción pide `cantidad > 0` salvo en AJUSTE, que no admite 0).
 * - `claveIdempotencia`: si falta, una única por llamada.
 */
async function crearMovimiento(db, {
  idBodega, tipo = 'ENTRADA', idProducto = 5, cantidad = 1, saldoResultante = 1, fecha, idUsuario = 7,
  idLote = null, idTraslado = null, idConteo = null, documentoReferencia = null, observacion = null, claveIdempotencia,
}) {
  const [movimiento] = await db('movimientos')
    .insert({
      tipo,
      id_producto: idProducto,
      id_bodega: idBodega,
      id_lote: idLote,
      id_traslado: idTraslado,
      id_conteo: idConteo,
      cantidad,
      saldo_resultante: saldoResultante,
      fecha,
      id_usuario: idUsuario,
      clave_idempotencia: claveIdempotencia ?? `fixture-${(siguienteClave += 1)}`,
      documento_referencia: documentoReferencia,
      observacion,
    })
    .returning('*');
  return movimiento;
}

/**
 * Cabeceras que el Gateway añade a cada petición. Van como texto (así viajan por HTTP) y `X-User-Bodega` se omite
 * si no hay bodega: un `undefined` llegaría como "undefined" y daría 401 por la validación de identidad (D20).
 */
function headers(rol, { idUsuario = 7, idBodega } = {}) {
  const cabeceras = { 'X-User-Id': String(idUsuario), 'X-User-Rol': rol };
  if (idBodega !== undefined && idBodega !== null) cabeceras['X-User-Bodega'] = String(idBodega);
  return cabeceras;
}

/**
 * Doble de `clients.catalogo` con el contrato del cliente real (Tarea 5): un producto, `null` si no existe y, con
 * el servicio caído, `AppError` 503 (nunca un `Error` genérico, que el manejador convertiría en 500).
 */
function fakeCatalogo({ inexistentes = [999], caido = false } = {}) {
  return {
    obtenerProducto: jest.fn(async (idProducto) => {
      if (caido) throw e.noDisponible('ms-catalogo no responde');
      const id = Number(idProducto);
      if (inexistentes.includes(id)) return null;
      return { id_producto: id, codigo: `P${id}`, nombre: `Producto ${id}` };
    }),
  };
}

/** Doble de `clients.notificaciones`: el cliente real nunca lanza y no devuelve nada. */
function fakeNotificaciones() {
  return { notificarStockBajo: jest.fn().mockResolvedValue(undefined) };
}

module.exports = { crearBodega, crearSaldo, crearUmbral, crearLote, crearMovimiento, headers, fakeCatalogo, fakeNotificaciones };
