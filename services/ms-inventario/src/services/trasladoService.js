const { e } = require('../errors');
const { headersDe } = require('../clients/propagacion');
const { cuerpoObjeto, entero, recoger } = require('../http/validate');
const { requireUser, scopeBodega } = require('../middleware/identity');
const bodegaRepository = require('../repositories/bodegaRepository');
const loteRepository = require('../repositories/loteRepository');
const movimientoRepository = require('../repositories/movimientoRepository');
const saldoRepository = require('../repositories/saldoRepository');
const trasladoRepository = require('../repositories/trasladoRepository');
const { OPERACIONES, SUFIJOS_TRASLADO, claveAlmacenada, derivada, leerClaveIdempotencia, resolverFallo } = require('./idempotencia');
const stockService = require('./stockService');

// Lógica de negocio de los traslados entre bodegas (RF04; RNF13, RNF17). Un traslado cambia stock en DOS pasos, cada uno en su
// propia transacción y con su propia Idempotency-Key, y entre ambos la mercancía está EN TRÁNSITO (fuera de todo saldo):
// - crear (POST /traslados): saca la cantidad del ORIGEN con un movimiento TRASLADO_SALIDA y deja el traslado EN_TRANSITO;
// - recibir (POST /traslados/{id}/recepcion): la suma al DESTINO con un movimiento TRASLADO_ENTRADA y lo deja RECIBIDO.
// Invariante (D31(e)): para cada producto, Σ saldos + Σ cantidad de los traslados EN_TRANSITO es constante a lo largo de crear y
// recibir. Por eso el traslado y su movimiento se escriben SIEMPRE en la misma transacción: si cualquiera falla, se deshacen
// los dos y la mercancía ni desaparece ni se duplica.
//
// El stock lo mueve SOLO el motor (stockService.aplicarMovimiento), con sus reglas de lotes: TRASLADO_SALIDA nunca hace FEFO
// (D28(a)): con id_lote resta de ese lote y sin él mueve solo stock sin lote. El umbral NO se evalúa tras un traslado (D13).
// No sabe nada de HTTP: recibe el cuerpo, la cabecera Idempotency-Key y la identidad como datos. El SQL vive en los
// repositorios. Las dependencias llegan en `deps` = { db, clients, logger } y se leen en cada llamada.
//
// Claves (D25d, D31(a)): `base = claveAlmacenada(idUsuario, OPERACIONES.TRASLADO, clave)` de ESA petición; el movimiento
// TRASLADO_SALIDA lleva derivada(base, SUFIJOS_TRASLADO.SALIDA) y la repetición de la creación se detecta releyéndola.

/** Cuerpo de POST /traslados: {id_producto, id_bodega_origen, id_bodega_destino, cantidad, id_lote?} (Tabla 9). */
function leerCuerpoCreacion(cuerpo) {
  const datos = cuerpoObjeto(cuerpo);
  const detalles = [];
  const valores = {
    idProducto: recoger(detalles, () => entero(datos.id_producto, 'id_producto')),
    idBodegaOrigen: recoger(detalles, () => entero(datos.id_bodega_origen, 'id_bodega_origen')),
    idBodegaDestino: recoger(detalles, () => entero(datos.id_bodega_destino, 'id_bodega_destino')),
    cantidad: recoger(detalles, () => entero(datos.cantidad, 'cantidad')),
    idLote: recoger(detalles, () => (datos.id_lote === undefined || datos.id_lote === null ? null : entero(datos.id_lote, 'id_lote'))),
  };
  // «422 misma bodega» (contrato): se informa junto con los demás campos inválidos, y solo si las dos bodegas son válidas.
  if (valores.idBodegaOrigen !== undefined && valores.idBodegaOrigen === valores.idBodegaDestino) {
    detalles.push({ campo: 'id_bodega_destino', mensaje: 'debe ser distinta de id_bodega_origen' });
  }
  if (detalles.length > 0) throw e.datosNoValidos(detalles);
  return valores;
}

const loteNoExiste = () => e.noExiste('El lote no existe en esa bodega para ese producto');

/**
 * Comprobaciones previas de la creación, SIN bloquear nada y antes de abrir la transacción (no cambian nada):
 * - las dos bodegas existen (404): la clave foránea del INSERT del traslado lo exige (un 23503 sería un 500). Las bodegas no se
 *   borran, así que lo comprobado sigue valiendo dentro de la transacción. Que el ORIGEN esté activo lo decide el motor dentro
 *   de la transacción (409 BODEGA_INACTIVA); que lo esté el DESTINO, aquí (D12);
 * - con `idLote`, el lote es de la bodega de ORIGEN y del producto (404 si no; el motor lo vuelve a exigir con el lote
 *   bloqueado) y, D28(a), el destino no tiene ya un lote con el mismo código y OTRA fecha de vencimiento (incluida una nula
 *   frente a una fecha): si lo tuviera, la recepción fallaría después con la mercancía ya en tránsito. Por eso es 409 CONFLICTO
 *   aquí, antes de sacar nada del origen. Si el destino crea ese lote con otra fecha DESPUÉS de esta comprobación, la recepción
 *   responde 409 CONFLICTO y el traslado sigue EN_TRANSITO (limitación documentada).
 */
async function precomprobarCreacion(db, { idProducto, idBodegaOrigen, idBodegaDestino, idLote }) {
  const origen = await bodegaRepository.findById(db, idBodegaOrigen);
  if (!origen) throw e.noExiste('La bodega de origen no existe');
  const destino = await bodegaRepository.findById(db, idBodegaDestino);
  if (!destino) throw e.noExiste('La bodega de destino no existe');
  if (!destino.activa) throw e.conflicto('BODEGA_INACTIVA', 'La bodega de destino está inactiva: no admite traslados');
  if (idLote === null) return;

  const lote = await loteRepository.findById(db, idLote);
  if (!lote || lote.id_bodega !== idBodegaOrigen || lote.id_producto !== idProducto) throw loteNoExiste();
  const enDestino = await loteRepository.buscarPorCodigo(db, { idBodega: idBodegaDestino, idProducto, codigoLote: lote.codigo_lote });
  if (enDestino && enDestino.fecha_vencimiento !== lote.fecha_vencimiento) {
    throw e.conflicto('CONFLICTO', 'La bodega de destino ya tiene ese lote con otra fecha de vencimiento', [{
      campo: 'id_lote',
      mensaje: `En la bodega de destino el lote ${lote.codigo_lote} vence ${enDestino.fecha_vencimiento ?? 'sin fecha'}; en el origen, ${lote.fecha_vencimiento ?? 'sin fecha'}`,
    }]);
  }
}

/** El traslado de un movimiento de traslado. Un movimiento de traslado sin traslado es un estado imposible: 500. */
async function trasladoDe(db, movimiento) {
  const traslado = movimiento.id_traslado === null ? undefined : await trasladoRepository.findById(db, movimiento.id_traslado);
  if (!traslado) throw new Error(`El movimiento ${movimiento.id_movimiento} de un traslado no tiene traslado`);
  return traslado;
}

/**
 * Crea un traslado (POST /traslados). Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401 (D8, D22).
 * 2. Idempotency-Key: falta, vacía, más de 200 caracteres o con «#» → 400.
 * 3. Repetición (RNF17, D7, D31(c)): si este usuario ya creó un traslado con esa clave (se relee la clave de SALIDA), se devuelve
 *    ese traslado en su estado ACTUAL (p. ej. RECIBIDO) con su movimiento original, sin validar el cuerpo, sin permisos y sin
 *    catálogo: un reintento tras un éxito da 200 aunque ms-catalogo esté caído.
 * 4. Cuerpo: 422 (también «misma bodega»).
 * 5. Alcance: el operador solo envía desde SU bodega (scopeBodega sobre el ORIGEN, D31(g)) → 403.
 * 6. Catálogo (llamada 1): null → 404, sin respuesta → 503. Sin ninguna conexión tomada.
 * 7. Comprobaciones previas sin bloquear (precomprobarCreacion): bodegas, lote de origen y conflicto de fecha en el destino.
 * 8. Transacción (READ COMMITTED, la de por defecto: el motor la exige para la salida sin lote, D28(a)). ORDEN DE BLOQUEO:
 *    saldo de origen → (lote de origen) → fila nueva del traslado. El saldo se bloquea ANTES de insertar el traslado porque la
 *    clave foránea `traslados.id_lote` toma FOR KEY SHARE sobre la fila del lote: si el traslado se insertara primero, una
 *    salida FEFO del mismo par que ya tuviera el saldo y pidiera ese lote FOR UPDATE esperaría al traslado, y el traslado al
 *    saldo (interbloqueo, 40P01). Con el saldo primero se respeta el candado maestro de D27(c). Luego el motor aplica
 *    TRASLADO_SALIDA (vuelve a pedir el mismo saldo, que ya es suyo). Ninguna creación toma otro saldo: no hay ciclos.
 *    Los errores no se guardan (un 409 o 422 no deja clave). Si la transacción falla, resolverFallo relee la clave de salida:
 *    si otra petición idéntica la confirmó entre medias, 200 con su traslado; si no, el error ORIGINAL.
 * @param {{db: object, clients: {catalogo: object}, logger: object}} deps
 * @param {{body: unknown, claveIdempotencia: string|undefined, identity: object}} peticion
 * @returns {Promise<{traslado: Traslado, movimiento: Movimiento, replayed: boolean}>}
 */
async function crear({ db, clients }, { body, claveIdempotencia, identity }) {
  requireUser(identity);
  const base = claveAlmacenada(identity.idUsuario, OPERACIONES.TRASLADO, leerClaveIdempotencia(claveIdempotencia));
  const claveSalida = derivada(base, SUFIJOS_TRASLADO.SALIDA);

  const repetido = await movimientoRepository.findByClave(db, claveSalida);
  if (repetido) return { traslado: await trasladoDe(db, repetido), movimiento: repetido, replayed: true };

  const datos = leerCuerpoCreacion(body);
  scopeBodega(identity, datos.idBodegaOrigen);

  const producto = await clients.catalogo.obtenerProducto(datos.idProducto, headersDe(identity));
  if (!producto) throw e.noExiste('El producto no existe');

  await precomprobarCreacion(db, datos);

  const { idProducto, idBodegaOrigen, idBodegaDestino, idLote, cantidad } = datos;
  try {
    const resultado = await db.transaction(async (trx) => {
      await saldoRepository.bloquear(trx, { idProducto, idBodega: idBodegaOrigen }); // candado maestro ANTES del INSERT
      const traslado = await trasladoRepository.insert(trx, {
        idProducto, idBodegaOrigen, idBodegaDestino, idLote, cantidad, idUsuarioEnvia: identity.idUsuario,
      });
      const movimiento = await stockService.aplicarMovimiento(trx, {
        tipo: 'TRASLADO_SALIDA', idProducto, idBodega: idBodegaOrigen, cantidad, idLote, idTraslado: traslado.id_traslado,
        claveIdempotencia: claveSalida, idUsuario: identity.idUsuario,
      });
      return { traslado, movimiento };
    });
    return { ...resultado, replayed: false };
  } catch (error) {
    const movimiento = await resolverFallo(db, claveSalida, error);
    return { traslado: await trasladoDe(db, movimiento), movimiento, replayed: true };
  }
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearTrasladoService(deps = {}) {
  return {
    crear: (peticion) => crear(deps, peticion),
  };
}

module.exports = { crear, crearTrasladoService };
