const { delta } = require('../domain/tipos');
const { e } = require('../errors');
const bodegaRepository = require('../repositories/bodegaRepository');
const movimientoRepository = require('../repositories/movimientoRepository');
const saldoRepository = require('../repositories/saldoRepository');

// Motor de movimientos (RF04, RF10): la ÚNICA vía por la que cambia un saldo. Lo usan POST /movimientos (Tarea 7) y, dentro de
// sus propias transacciones, los lotes (Tarea 8), los traslados (Tarea 9), la aprobación de conteos (Tarea 11), la carga
// inicial (Tarea 12) y las recepciones y devoluciones de ms-compras (Tarea 13, por POST /movimientos).
//
// Qué hace y qué no:
// - Trabaja SOLO con la transacción que recibe: no consulta ms-catalogo, no avisa a ms-notificaciones y no revisa la
//   idempotencia (todo eso es de quien llama, antes o después de la transacción). Recibe la clave ya armada.
// - Bloquea el saldo con SELECT … FOR UPDATE (saldoRepository.bloquear): dos movimientos simultáneos sobre el mismo
//   (producto, bodega) se aplican uno detrás de otro y el segundo ve el saldo que dejó el primero, así que nunca queda negativo.
// - Escribe `saldos.fecha_actualizacion` y `movimientos.fecha` con clock_timestamp() DESPUÉS de tomar el bloqueo (D24).
//
// ORDEN DE BLOQUEO en operaciones con DOS saldos (traslados, Tarea 9): llamar a aplicarMovimiento (o a bloquear) primero
// sobre el saldo de MENOR id_bodega y después sobre el de mayor, sea cual sea el origen y el destino. Si un traslado A→B
// bloqueara A y luego B mientras otro B→A bloquea B y luego A, cada uno esperaría al otro (interbloqueo, 40P01).

const ENTERO_MAXIMO = 2147483647;
const LARGO_CLAVE = 255; // movimientos.clave_idempotencia es varchar(255)

const esId = (valor) => Number.isSafeInteger(valor) && valor >= 1 && valor <= ENTERO_MAXIMO;
const esIdOpcional = (valor) => valor === null || esId(valor);
const esTextoOpcional = (valor) => valor === null || typeof valor === 'string';

/**
 * Comprueba los argumentos del motor y los devuelve con los opcionales en null. Llegan ya validados por quien llama (422 o 400
 * al cliente): aquí un valor imposible es un error de programación y lanza TypeError (un 500), nunca un dato que se guarda a
 * medias. El tipo y la cantidad los comprueba tipos.delta.
 */
function comprobarArgumentos(trx, datos) {
  // Sin transacción el FOR UPDATE se soltaría al terminar cada sentencia y dos movimientos podrían dejar el saldo negativo.
  if (trx?.isTransaction !== true) throw new TypeError('aplicarMovimiento debe ejecutarse dentro de una transacción');
  // TODO(Tarea 8): los lotes llegan con la Tarea 8, que añadirá idLote y lote. Hasta entonces se rechazan: ignorarlos dejaría
  // un movimiento que no toca los lotes mientras quien llama cree que sí.
  if (datos.idLote !== undefined || datos.lote !== undefined) throw new TypeError('aplicarMovimiento todavía no admite lotes');
  const {
    tipo, idProducto, idBodega, cantidad, claveIdempotencia, idUsuario,
    idTraslado = null, idConteo = null, documentoReferencia = null, observacion = null,
  } = datos;
  if (!esId(idProducto) || !esId(idBodega) || !esId(idUsuario)) {
    throw new TypeError('idProducto, idBodega e idUsuario deben ser enteros positivos dentro del INTEGER');
  }
  if (typeof claveIdempotencia !== 'string' || claveIdempotencia.length < 1 || claveIdempotencia.length > LARGO_CLAVE) {
    throw new TypeError(`claveIdempotencia debe ser un texto de 1 a ${LARGO_CLAVE} caracteres`);
  }
  if (!esIdOpcional(idTraslado) || !esIdOpcional(idConteo)) throw new TypeError('idTraslado e idConteo deben ser null o enteros positivos');
  if (!esTextoOpcional(documentoReferencia) || !esTextoOpcional(observacion)) {
    throw new TypeError('documentoReferencia y observacion deben ser null o texto');
  }
  return { tipo, idProducto, idBodega, cantidad, claveIdempotencia, idUsuario, idTraslado, idConteo, documentoReferencia, observacion };
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
 * @param {number|null} [datos.idTraslado] movimientos de un traslado (Tarea 9)
 * @param {number|null} [datos.idConteo] ajustes de la aprobación de un conteo (Tarea 11)
 * @param {string|null} [datos.documentoReferencia] ya validado (≤ 100 caracteres)
 * @param {string|null} [datos.observacion] ya validada (≤ 500 caracteres)
 * @param {string} datos.claveIdempotencia la clave tal como se ALMACENA (idempotencia.claveAlmacenada, o idempotencia.derivada
 *   en las operaciones que generan varios movimientos, D5); única en la tabla
 * @param {number} datos.idUsuario autor del movimiento (RF10)
 * @returns {Promise<Movimiento>} el movimiento insertado (sin clave_idempotencia)
 * @throws 404 NO_EXISTE si la bodega no existe; 409 BODEGA_INACTIVA (D12); 409 STOCK_INSUFICIENTE si el saldo quedaría
 *   negativo; 422 DATOS_NO_VALIDOS (campo `cantidad`) si superaría el máximo del INTEGER; el 23505 de
 *   `movimientos_clave_idempotencia_key` si la clave ya existe (movimientoRepository.esClaveDuplicada);
 *   TypeError ante argumentos imposibles
 */
async function aplicarMovimiento(trx, datos) {
  const {
    tipo, idProducto, idBodega, cantidad, claveIdempotencia, idUsuario, idTraslado, idConteo, documentoReferencia, observacion,
  } = comprobarArgumentos(trx, datos);
  const cambio = delta(tipo, cantidad); // TypeError si el tipo o la cantidad son imposibles

  const bodega = await bodegaRepository.findById(trx, idBodega);
  if (!bodega) throw e.noExiste('La bodega no existe');
  if (!bodega.activa) throw e.conflicto('BODEGA_INACTIVA', 'La bodega está inactiva: no admite movimientos');

  const saldo = await saldoRepository.bloquear(trx, { idProducto, idBodega });
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

  await saldoRepository.fijarCantidad(trx, saldo.id_saldo, resultante);
  return movimientoRepository.insert(trx, {
    tipo, idProducto, idBodega, cantidad, saldoResultante: resultante, idUsuario, claveIdempotencia,
    idTraslado, idConteo, documentoReferencia, observacion,
  });
}

module.exports = { aplicarMovimiento };
