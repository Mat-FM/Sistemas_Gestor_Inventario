const { delta } = require('../domain/tipos');
const { e } = require('../errors');
const { esFechaValida } = require('../http/validate');
const bodegaRepository = require('../repositories/bodegaRepository');
const loteRepository = require('../repositories/loteRepository');
const movimientoRepository = require('../repositories/movimientoRepository');
const saldoRepository = require('../repositories/saldoRepository');

// Motor de movimientos (RF04, RF10): la ÚNICA vía por la que cambia un saldo. Lo usan POST /movimientos (Tarea 7) y, dentro de
// sus propias transacciones, los lotes (Tarea 8), los traslados (Tarea 11), la aprobación de conteos (Tarea 12), la carga
// inicial (Tarea 13) y las recepciones y devoluciones de ms-compras (por POST /movimientos).
//
// Qué hace y qué no:
// - Trabaja SOLO con la transacción que recibe: no consulta ms-catalogo, no avisa a ms-notificaciones y no revisa la
//   idempotencia (todo eso es de quien llama, antes o después de la transacción). Recibe la clave ya armada.
// - Bloquea el saldo con SELECT … FOR UPDATE (saldoRepository.bloquear): dos movimientos simultáneos sobre el mismo
//   (producto, bodega) se aplican uno detrás de otro y el segundo ve el saldo que dejó el primero, así que nunca queda negativo.
// - Escribe `saldos.fecha_actualizacion` y `movimientos.fecha` con clock_timestamp() DESPUÉS de tomar el bloqueo (D24).
// - Lotes (RF17, D27): las reglas van por el SIGNO del cambio, no por el tipo, así que los traslados, los conteos, la carga
//   inicial y las devoluciones las heredan sin reglas propias.
//   · Sube (delta > 0): sin lote → solo el saldo (stock «sin lote»); idLote → suma a ESE lote; lote {codigoLote,
//     fechaVencimiento} → loteRepository.upsertEntrada (lo crea o le suma; 409 CONFLICTO si ya existe con otra fecha).
//   · Baja (delta < 0): idLote → resta de ESE lote (409 STOCK_INSUFICIENTE con los datos del LOTE si no alcanza); sin idLote →
//     FEFO (D6: planificarFefo sobre loteRepository.listarParaFefo) y lo que los lotes no cubren sale del stock sin lote.
//   · EXCEPCIÓN, TRASLADO_SALIDA sin idLote (D28(a)): un traslado mueve 0 o 1 lote (traslados.id_lote), así que NO hace FEFO:
//     saca solo stock sin lote, sinLote = saldo − SUM(lotes del par), y si no alcanza es 409 STOCK_INSUFICIENTE con
//     disponible = sinLote (el mensaje pide indicar id_lote). No toca ningún lote y el movimiento lleva id_lote null.
//     La suma es una agregación SIN FOR UPDATE (PostgreSQL no lo admite con SUM) y es correcta porque se cumplen TRES
//     condiciones, que quien toque este código debe mantener:
//       (1) se calcula en una sentencia NUEVA ejecutada DESPUÉS de saldoRepository.bloquear: en READ COMMITTED cada sentencia
//           toma su instantánea al empezar, así que ve todo lo que confirmó quien tuvo antes el candado del saldo;
//       (2) todo escritor de lotes bloquea antes el saldo de su par (candado maestro, D27(c)): mientras tenemos el saldo,
//           nadie cambia los lotes del par;
//       (3) la transacción es READ COMMITTED: en REPEATABLE READ o SERIALIZABLE la instantánea sería la del inicio de la
//           transacción, ANTERIOR al bloqueo, y la suma podría estar vieja. No es solo una convención: sumarDelPar devuelve el
//           aislamiento real y el motor lanza TypeError si no es 'read committed' (también cubre un default_transaction_isolation
//           cambiado en la base).
//   · El movimiento lleva id_lote = el lote al que entra, del que sale o el PRIMERO consumido por FEFO (o null).
//   · Invariante (D27(c)): por (producto, bodega), la suma de los lotes nunca supera el saldo y ningún lote queda negativo. Se
//     mantiene porque saldo y lotes cambian en la misma transacción: con idLote o lote, ambos con el mismo delta; en FEFO, los
//     lotes se agotan ANTES de tocar el stock sin lote, así que si sobra algo (restante > 0) los lotes quedan en 0.
//
// ORDEN TOTAL DE BLOQUEO dentro de UN movimiento: bodega (lectura) → saldo (id_bodega, id_producto) con FOR UPDATE → lotes de
// ESE mismo par con FOR UPDATE, en orden FEFO (fecha ASC NULLS LAST, id_lote ASC; listarParaFefo) o solo el lote pedido (por id,
// filtrado por el par: nunca se bloquea un lote ajeno) o el del código (upsertEntrada). El saldo es el «candado maestro»: toda
// operación que toque los lotes de un par bloquea antes su saldo, así que dos operaciones del mismo par nunca se esperan en
// orden cruzado. Quien añada otra vía para tocar lotes debe respetar este orden.
//
// ORDEN DE BLOQUEO cuando una operación toma VARIOS saldos en una misma transacción (D25c): llamar a aplicarMovimiento (o a
// bloquear) en orden de id_bodega ascendente y, dentro de la misma bodega, de id_producto ascendente.
// - Traslados (Tarea 11, D31(d)): NO toman dos saldos. La creación toma solo el saldo de ORIGEN (y lo bloquea ANTES de insertar
//   el traslado, cuya clave foránea al lote toma FOR KEY SHARE de la fila del lote: ver trasladoService.crear) y la recepción,
//   en otra transacción, la fila del traslado y después solo el saldo de DESTINO. Sin dos saldos en una transacción no hay ciclo
//   entre un traslado A→B y otro B→A.
// - Aprobación de conteos (Tarea 12): los AJUSTE de una misma bodega, por id_producto ascendente; así dos aprobaciones
//   concurrentes de conteos de la misma bodega que comparten productos no se interbloquean.
// - Carga inicial (Tarea 13): sus filas, ordenadas igual antes de aplicarlas.

const ENTERO_MAXIMO = 2147483647;
const LARGO_CLAVE = 255; // movimientos.clave_idempotencia es varchar(255)
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/; // fechas `date` como texto (Ruling 15)

const esId = (valor) => Number.isSafeInteger(valor) && valor >= 1 && valor <= ENTERO_MAXIMO;
const esIdOpcional = (valor) => valor === null || esId(valor);
const esTextoOpcional = (valor) => valor === null || typeof valor === 'string';
const LARGO_CODIGO_LOTE = 50; // lotes.codigo_lote es varchar(50)

// `lote` del motor: { codigoLote, fechaVencimiento? }, ya validado por quien llama (texto recortado de 1 a 50 caracteres y una
// fecha YYYY-MM-DD que EXISTA, o null). Devuelve el lote normalizado (fechaVencimiento null si falta) o lanza TypeError. La fecha
// se comprueba con la misma regla de calendario que el 422 de la API (validate.esFechaValida): una fecha imposible (2027-02-30)
// que llegara a la base sería un 22008, un 500 sin causa clara.
function comprobarLote(lote) {
  if (lote === null) return null;
  const esObjeto = typeof lote === 'object' && !Array.isArray(lote);
  const codigo = esObjeto ? lote.codigoLote : undefined;
  const fecha = esObjeto ? (lote.fechaVencimiento ?? null) : undefined;
  // Un código sin recortar («L1 ») o con NUL crearía en silencio otro lote distinto de «L1» (o un 22021): quien llama debe
  // pasarlo por http/validate.texto, como POST /movimientos.
  const codigoValido = typeof codigo === 'string' && codigo.length >= 1 && codigo === codigo.trim() && !codigo.includes('\u0000')
    && [...codigo].length <= LARGO_CODIGO_LOTE;
  if (!codigoValido || !(fecha === null || esFechaValida(fecha))) {
    throw new TypeError(`lote debe ser { codigoLote: texto recortado de 1 a ${LARGO_CODIGO_LOTE} caracteres, fechaVencimiento?: fecha real YYYY-MM-DD o null }`);
  }
  return { codigoLote: codigo, fechaVencimiento: fecha };
}

/**
 * Comprueba los argumentos del motor y los devuelve con los opcionales en null. Llegan ya validados por quien llama (422 o 400
 * al cliente): aquí un valor imposible es un error de programación y lanza TypeError (un 500), nunca un dato que se guarda a
 * medias. El tipo y la cantidad los comprueba tipos.delta.
 */
function comprobarArgumentos(trx, datos) {
  // Sin transacción el FOR UPDATE se soltaría al terminar cada sentencia y dos movimientos podrían dejar el saldo negativo.
  if (trx?.isTransaction !== true) throw new TypeError('aplicarMovimiento debe ejecutarse dentro de una transacción');
  const {
    tipo, idProducto, idBodega, cantidad, claveIdempotencia, idUsuario,
    idLote = null, lote = null, idTraslado = null, idConteo = null, documentoReferencia = null, observacion = null,
  } = datos;
  if (!esId(idProducto) || !esId(idBodega) || !esId(idUsuario)) {
    throw new TypeError('idProducto, idBodega e idUsuario deben ser enteros positivos dentro del INTEGER');
  }
  if (typeof claveIdempotencia !== 'string' || claveIdempotencia.length < 1 || claveIdempotencia.length > LARGO_CLAVE) {
    throw new TypeError(`claveIdempotencia debe ser un texto de 1 a ${LARGO_CLAVE} caracteres`);
  }
  if (!esIdOpcional(idTraslado) || !esIdOpcional(idConteo) || !esIdOpcional(idLote)) {
    throw new TypeError('idLote, idTraslado e idConteo deben ser null o enteros positivos');
  }
  const loteNormalizado = comprobarLote(lote);
  if (idLote !== null && loteNormalizado !== null) throw new TypeError('idLote y lote no pueden ir juntos (D27)');
  if (!esTextoOpcional(documentoReferencia) || !esTextoOpcional(observacion)) {
    throw new TypeError('documentoReferencia y observacion deben ser null o texto');
  }
  return {
    tipo, idProducto, idBodega, cantidad, claveIdempotencia, idUsuario, idLote, lote: loteNormalizado, idTraslado, idConteo,
    documentoReferencia, observacion,
  };
}

const loteNoExiste = () => e.noExiste('El lote no existe en esa bodega para ese producto');

/** Toma el lote pedido por id SOLO si es del mismo par (bloqueado). 404 si no existe o es de otra bodega o producto. */
async function bloquearLoteDelPar(trx, idLote, { idBodega, idProducto }) {
  const lote = await loteRepository.bloquearPorId(trx, idLote, { idBodega, idProducto });
  if (!lote) throw loteNoExiste();
  return lote;
}

// Una resta o suma a un lote que ya se comprobó con la fila bloqueada no puede fallar; si falla, el invariante está roto y se
// aborta TODO (un Error que no es AppError: 500, y la transacción se deshace con saldo y lotes).
async function ajustarLote(trx, idLote, cambio) {
  const lote = await loteRepository.ajustar(trx, idLote, cambio);
  if (!lote) throw new Error(`No se pudo ajustar el lote ${idLote} en ${cambio}: el invariante de lotes está roto`);
  return lote;
}

/** Entrada por código (D27(a)): crea o suma; 409 CONFLICTO si el lote ya existe con otra fecha de vencimiento (D27(d)). */
async function entrarPorCodigo(trx, { idBodega, idProducto, cambio, lote }) {
  const datosLote = { idBodega, idProducto, codigoLote: lote.codigoLote, fechaVencimiento: lote.fechaVencimiento, cantidad: cambio };
  const resultado = await loteRepository.upsertEntrada(trx, datosLote);
  if (resultado) return resultado;
  const existente = await loteRepository.buscarPorCodigo(trx, datosLote);
  const guardada = existente?.fecha_vencimiento ?? null;
  throw e.conflicto('CONFLICTO', 'El lote ya existe con otra fecha de vencimiento', [{
    campo: 'lote.fecha_vencimiento',
    mensaje: guardada === null ? 'El lote ya existe sin fecha de vencimiento' : `El lote ya existe con fecha de vencimiento ${guardada}`,
  }]);
}

/** Salida de un lote concreto (D27(b)): 409 STOCK_INSUFICIENTE con lo disponible y lo solicitado DEL LOTE si no alcanza. */
async function salirDeLote(trx, lote, solicitado) {
  const disponible = lote.cantidad_disponible;
  if (disponible < solicitado) {
    throw e.conflicto('STOCK_INSUFICIENTE', 'No hay stock suficiente en el lote para este movimiento', [
      { campo: 'id_lote', mensaje: `Disponible en el lote: ${disponible}; solicitado: ${solicitado}`, disponible, solicitado },
    ]);
  }
  await ajustarLote(trx, lote.id_lote, -solicitado);
}

/**
 * Salida de un traslado SIN idLote (D28(a)): solo stock sin lote. Debe llamarse con el saldo YA bloqueado (ver las tres
 * condiciones en la cabecera del módulo).
 */
async function salirSinLote(trx, { idBodega, idProducto, saldo, solicitado }) {
  const { enLotes, aislamiento } = await loteRepository.sumarDelPar(trx, { idBodega, idProducto });
  if (aislamiento !== 'read committed') {
    throw new TypeError(`La salida de un traslado sin lote exige una transacción READ COMMITTED (es ${aislamiento})`);
  }
  const sinLote = saldo - enLotes;
  if (sinLote < solicitado) {
    // Con sinLote negativo (suma de lotes > saldo: un estado imposible por el invariante, sembrado a mano) nada cabe, pero el
    // cliente nunca debe ver un disponible negativo: se informa 0.
    const disponible = Math.max(0, sinLote);
    throw e.conflicto('STOCK_INSUFICIENTE', 'El stock sin lote no alcanza para el traslado: indique id_lote para trasladar un lote', [
      { campo: 'cantidad', mensaje: `Disponible sin lote: ${disponible}; solicitado: ${solicitado}`, disponible, solicitado },
    ]);
  }
}

/**
 * Salida por FEFO (D6): bloquea los lotes del par con existencia en orden FEFO, los consume con planificarFefo y deja el
 * `restante` al stock sin lote (que alcanza: el saldo ya se comprobó y la suma de los lotes no lo supera).
 * @returns {Promise<number|null>} el id del PRIMER lote consumido, o null si no se consumió ninguno
 */
async function salirPorFefo(trx, { idBodega, idProducto, solicitado }) {
  const lotes = await loteRepository.listarParaFefo(trx, { idBodega, idProducto });
  const { asignaciones } = planificarFefo(lotes, solicitado);
  for (const { id_lote: id, cantidad } of asignaciones) await ajustarLote(trx, id, -cantidad);
  return asignaciones.length > 0 ? asignaciones[0].id_lote : null;
}

/**
 * Aplica un movimiento: valida la bodega, bloquea el saldo, calcula el nuevo (D3), lo escribe e inserta el movimiento con su
 * `saldo_resultante`. Todo en la transacción `trx`: si algo falla después de escribir (p. ej. el INSERT del movimiento con una
 * clave repetida), quien abrió la transacción la deshace entera, saldo incluido.
 *
 * @param {object} trx transacción de Knex (obligatoria)
 * @param {object} datos
 * @param {string} datos.tipo uno de tipos.TIPOS
 * @param {number} datos.idProducto ya confirmado en ms-catalogo por quien llama
 * @param {number} datos.idBodega
 * @param {number} datos.cantidad entero > 0; en AJUSTE, ≠ 0 con su signo
 * @param {number|null} [datos.idLote] lote al que entra o del que sale (D27); debe ser de la misma bodega y producto (404 si no)
 * @param {{codigoLote: string, fechaVencimiento?: string|null}|null} [datos.lote] entrada a un lote por código (solo si el
 *   movimiento SUBE el saldo); se crea si no existe. No va junto con idLote
 * @param {number|null} [datos.idTraslado] movimientos de un traslado (Tarea 11)
 * @param {number|null} [datos.idConteo] ajustes de la aprobación de un conteo (Tarea 12)
 * @param {string|null} [datos.documentoReferencia] ya validado (≤ 100 caracteres)
 * @param {string|null} [datos.observacion] ya validada (≤ 500 caracteres)
 * @param {string} datos.claveIdempotencia la clave tal como se ALMACENA (idempotencia.claveAlmacenada, o idempotencia.derivada
 *   en las operaciones que generan varios movimientos, D5); única en la tabla
 * @param {number} datos.idUsuario autor del movimiento (RF10)
 * @returns {Promise<Movimiento>} el movimiento insertado (sin clave_idempotencia). Solo lleva `id_lote`: NO devuelve el código ni
 *   la fecha del lote. Para la Tarea 11: un traslado que saca un lote (idLote) debe leer ese lote de origen SIN bloqueo (por
 *   ejemplo con una lectura simple por id) para recrearlo en el destino con `lote: { codigoLote, fechaVencimiento }`. Es seguro
 *   porque `codigo_lote` y `fecha_vencimiento` de un lote existente son INMUTABLES: ninguna sentencia los actualiza (una fecha
 *   distinta es 409 CONFLICTO, D27(d), nunca una actualización) y la pertenencia a su par tampoco cambia.
 * @throws 404 NO_EXISTE si la bodega no existe o si idLote no es un lote de esa bodega y producto; 409 BODEGA_INACTIVA (D12);
 *   409 STOCK_INSUFICIENTE si el saldo quedaría negativo (campo `cantidad`) o si el lote pedido no alcanza (campo `id_lote`,
 *   con lo disponible y lo solicitado del lote); 409 CONFLICTO si `lote` ya existe con otra fecha de vencimiento;
 *   422 DATOS_NO_VALIDOS (campo `cantidad`) si superaría el máximo del INTEGER; el 23505 de
 *   `movimientos_clave_idempotencia_key` si la clave ya existe (quien llama relee con idempotencia.resolverFallo);
 *   TypeError ante argumentos imposibles (también idLote y lote juntos, o lote en un movimiento que baja el saldo)
 */
async function aplicarMovimiento(trx, datos) {
  const {
    tipo, idProducto, idBodega, cantidad, claveIdempotencia, idUsuario, idLote, lote, idTraslado, idConteo, documentoReferencia,
    observacion,
  } = comprobarArgumentos(trx, datos);
  const cambio = delta(tipo, cantidad); // TypeError si el tipo o la cantidad son imposibles
  if (lote !== null && cambio < 0) throw new TypeError('lote solo se admite en un movimiento que sube el saldo (D27(b))');
  const par = { idBodega, idProducto };

  const bodega = await bodegaRepository.findById(trx, idBodega);
  if (!bodega) throw e.noExiste('La bodega no existe');
  if (!bodega.activa) throw e.conflicto('BODEGA_INACTIVA', 'La bodega está inactiva: no admite movimientos');

  // Candado maestro: el saldo SIEMPRE antes que cualquier lote (ver ORDEN TOTAL DE BLOQUEO arriba).
  const saldo = await saldoRepository.bloquear(trx, par);
  // El lote pedido por id se toma (y se valida, 404) antes de mirar el stock: una referencia inválida se informa primero.
  const lotePedido = idLote === null ? null : await bloquearLoteDelPar(trx, idLote, par);
  const disponible = saldo.cantidad_disponible;
  const resultante = disponible + cambio;
  if (resultante < 0) {
    const solicitado = -cambio;
    throw e.conflicto('STOCK_INSUFICIENTE', 'No hay stock suficiente en la bodega para este movimiento', [
      { campo: 'cantidad', mensaje: `Disponible: ${disponible}; solicitado: ${solicitado}`, disponible, solicitado },
    ]);
  }
  // Se comprueba aquí y no se deja a la base: el 22003 de PostgreSQL acabaría en un 500.
  if (resultante > ENTERO_MAXIMO) {
    throw e.datosNoValidos([{ campo: 'cantidad', mensaje: `el saldo resultante superaría el máximo permitido (${ENTERO_MAXIMO})` }]);
  }

  let idLoteMovimiento = null;
  if (cambio > 0) {
    if (lotePedido) idLoteMovimiento = (await ajustarLote(trx, lotePedido.id_lote, cambio)).id_lote;
    else if (lote) idLoteMovimiento = (await entrarPorCodigo(trx, { ...par, cambio, lote })).id_lote;
  } else if (lotePedido) {
    await salirDeLote(trx, lotePedido, -cambio);
    idLoteMovimiento = lotePedido.id_lote;
  } else if (tipo === 'TRASLADO_SALIDA') {
    await salirSinLote(trx, { ...par, saldo: disponible, solicitado: -cambio }); // D28(a): nunca FEFO; id_lote null
  } else {
    idLoteMovimiento = await salirPorFefo(trx, { ...par, solicitado: -cambio });
  }

  await saldoRepository.fijarCantidad(trx, saldo.id_saldo, resultante);
  return movimientoRepository.insert(trx, {
    tipo, idProducto, idBodega, cantidad, saldoResultante: resultante, idUsuario, claveIdempotencia,
    idLote: idLoteMovimiento, idTraslado, idConteo, documentoReferencia, observacion,
  });
}

// Orden FEFO (D6): fecha de vencimiento ascendente, los lotes sin fecha al final y, a igual fecha, id_lote ascendente. Las fechas
// son texto YYYY-MM-DD (Ruling 15), cuyo orden lexicográfico es el cronológico. Es el mismo orden que el ORDER BY de
// loteRepository.listarParaFefo.
function compararFefo(a, b) {
  if (a.fecha_vencimiento !== b.fecha_vencimiento) {
    if (a.fecha_vencimiento === null) return 1;
    if (b.fecha_vencimiento === null) return -1;
    return a.fecha_vencimiento < b.fecha_vencimiento ? -1 : 1;
  }
  return a.id_lote - b.id_lote;
}

function comprobarLotes(lotes) {
  if (!Array.isArray(lotes)) throw new TypeError('planificarFefo: `lotes` debe ser un arreglo');
  const vistos = new Set();
  for (const lote of lotes) {
    const fecha = lote?.fecha_vencimiento;
    if (!esId(lote?.id_lote) || !Number.isSafeInteger(lote.cantidad_disponible) || lote.cantidad_disponible < 0
      || !(fecha === null || (typeof fecha === 'string' && FORMATO_FECHA.test(fecha)))) {
      // Un Date en fecha_vencimiento (sin el parser de Ruling 15) compararía objetos, no días: mejor un 500 que un plan inventado.
      throw new TypeError('planificarFefo: cada lote necesita id_lote, cantidad_disponible entera ≥ 0 y fecha_vencimiento YYYY-MM-DD o null');
    }
    if (vistos.has(lote.id_lote)) throw new TypeError('planificarFefo: un lote aparece dos veces (se asignaría dos veces su existencia)');
    vistos.add(lote.id_lote);
  }
}

/**
 * Plan de una salida por FEFO (RF17, D6): de qué lotes sale `cantidad`, del primero en vencer al último. Función PURA: no toca la
 * base ni muta su entrada (el motor la llama con los lotes que leyó y bloqueó loteRepository.listarParaFefo).
 * - Ignora los lotes sin existencia (cantidad_disponible 0).
 * - Agota cada lote antes de pasar al siguiente; solo la última asignación puede ser parcial.
 * - Lo que los lotes no cubren queda en `restante` y, en el motor, sale del stock sin lote.
 * @param {Array<{id_lote: number, fecha_vencimiento: string|null, cantidad_disponible: number}>} lotes en cualquier orden
 * @param {number} cantidad entero positivo
 * @returns {{asignaciones: Array<{id_lote: number, cantidad: number}>, restante: number}} asignaciones en orden FEFO, todas > 0
 * @throws {TypeError} error de programación si la cantidad no es un entero positivo o algún lote no tiene la forma de un Lote
 */
function planificarFefo(lotes, cantidad) {
  if (!Number.isSafeInteger(cantidad) || cantidad < 1) throw new TypeError('planificarFefo: `cantidad` debe ser un entero positivo');
  comprobarLotes(lotes);
  const ordenados = lotes.filter((lote) => lote.cantidad_disponible > 0).sort(compararFefo); // filter copia: no muta la entrada
  const asignaciones = [];
  let restante = cantidad;
  for (const lote of ordenados) {
    if (restante === 0) break;
    const toma = Math.min(restante, lote.cantidad_disponible);
    asignaciones.push({ id_lote: lote.id_lote, cantidad: toma });
    restante -= toma;
  }
  return { asignaciones, restante };
}

module.exports = { aplicarMovimiento, planificarFefo };
