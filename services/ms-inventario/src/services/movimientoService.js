const { TIPOS, TIPOS_PERMITIDOS_POR_API, evaluaUmbral } = require('../domain/tipos');
const { describirError, e } = require('../errors');
const { headersDe } = require('../clients/propagacion');
const { ENTERO_MAXIMO, cuerpoObjeto, entero, enumerado, texto, validarCampos } = require('../http/validate');
const { requireUser, scopeBodega } = require('../middleware/identity');
const movimientoRepository = require('../repositories/movimientoRepository');
const saldoRepository = require('../repositories/saldoRepository');
const umbralRepository = require('../repositories/umbralRepository');
const { OPERACIONES, claveAlmacenada, leerClaveIdempotencia } = require('./idempotencia');
const stockService = require('./stockService');

// Lógica de negocio de POST /movimientos (RF04, RF10, RNF17; RNF13): idempotencia por usuario y operación (idempotencia.js),
// validación del cuerpo, permisos, confirmación del producto en ms-catalogo y la transacción con el motor (stockService). No
// sabe nada de HTTP: recibe el cuerpo, el valor de la cabecera Idempotency-Key y la identidad como datos. El SQL vive en los
// repositorios.
//
// Las dependencias llegan en `deps` = { db, clients, logger } y se leen en cada llamada (no al construir), como en el resto de
// servicios: rutasDeclaradas() se puede llamar sin dependencias.

// Largos exactos de las columnas de `movimientos` (migración 20261103000100): un texto más largo sería un 22001 (un 500).
const LARGOS = { documento_referencia: 100, observacion: 500 };

// Texto opcional de una columna nullable: ausente o null → null; cualquier otro valor pasa por `texto` (422 si no cabe).
const textoOpcional = (valor, campo) => (valor === undefined || valor === null ? null : texto(valor, campo, { max: LARGOS[campo] }));

/** `cantidad` según el tipo (D2, D3): AJUSTE es un entero con signo distinto de 0; los demás, un entero ≥ 1. Techo: INTEGER. */
function leerCantidad(tipo, valor) {
  if (tipo !== 'AJUSTE') return entero(valor, 'cantidad');
  const cantidad = entero(valor, 'cantidad', { min: -ENTERO_MAXIMO });
  if (cantidad === 0) throw e.datosNoValidos([{ campo: 'cantidad', mensaje: 'un AJUSTE no puede ser de 0' }]);
  return cantidad;
}

/**
 * TODO(Tarea 8): los lotes (`id_lote`, `lote`) se habilitan en la Tarea 8, que BORRA esta función y su llamada. Hasta entonces
 * un cuerpo que los traiga es 422 (D26): ignorarlos en silencio dejaría un movimiento que no toca los lotes mientras el cliente
 * cree que sí. Cuenta la mera presencia del campo, también con null (que en la Tarea 8 significará «salida por FEFO»).
 */
function rechazarLotes(datos) {
  const presentes = ['id_lote', 'lote'].filter((campo) => datos[campo] !== undefined);
  if (presentes.length > 0) {
    throw e.datosNoValidos(presentes.map((campo) => ({ campo, mensaje: 'los lotes todavía no se admiten en los movimientos' })));
  }
}

/**
 * Cuerpo de POST /movimientos: {tipo, id_producto, id_bodega, cantidad, documento_referencia?, observacion?} (Tabla 9).
 * Orden: cuerpo que no es un objeto (422 «cuerpo») → tipo reservado (403, D4) → todos los campos a la vez (422). Un tipo
 * válido pero reservado es un permiso, no un dato inválido: se rechaza antes de mirar el resto del cuerpo. Cualquier otro
 * campo (`id_usuario`, `saldo_resultante`, `fecha`…) se descarta: los fija el servidor.
 */
function leerCuerpo(cuerpo) {
  const datos = cuerpoObjeto(cuerpo);
  if (TIPOS.includes(datos.tipo) && !TIPOS_PERMITIDOS_POR_API.includes(datos.tipo)) {
    throw e.sinPermiso(`El tipo ${datos.tipo} no se puede registrar por esta ruta`);
  }
  const valores = validarCampos({
    tipo: () => enumerado(datos.tipo, 'tipo', TIPOS_PERMITIDOS_POR_API),
    idProducto: () => entero(datos.id_producto, 'id_producto'),
    idBodega: () => entero(datos.id_bodega, 'id_bodega'),
    cantidad: () => leerCantidad(datos.tipo, datos.cantidad),
    documentoReferencia: () => textoOpcional(datos.documento_referencia, 'documento_referencia'),
    observacion: () => textoOpcional(datos.observacion, 'observacion'),
    lotes: () => rechazarLotes(datos), // TODO(Tarea 8): borrar esta línea junto con rechazarLotes
  });
  const { lotes: _sinUso, ...movimiento } = valores;
  return movimiento;
}

/**
 * Tras un fallo de la transacción, ¿ya hay un movimiento con esta clave? Puede haberlo aunque la búsqueda inicial no lo viera:
 * otra petición del mismo usuario con la misma clave confirmó entre medias. Esa carrera se manifiesta como el 23505 de la clave
 * (el INSERT chocó con la unicidad) o como cualquier otro rechazo del motor que dependa de lo que la otra ya escribió (p. ej.
 * un 409 STOCK_INSUFICIENTE porque la otra consumió el stock): en todos los casos la respuesta correcta es la original (D7).
 * Como la transacción ya se deshizo entera (saldo incluido), se vuelve a leer con la conexión normal.
 * @returns {Promise<Movimiento>} el movimiento original
 * @throws el error original si no hay ninguno; un Error interno (500) si era el 23505 de la clave y aun así no aparece
 */
async function resolverFallo(db, almacenada, error) {
  let original;
  try {
    original = await movimientoRepository.findByClave(db, almacenada);
  } catch {
    throw error; // la base falló también al releer: se informa el fallo original
  }
  if (original) return original;
  if (movimientoRepository.esClaveDuplicada(error)) {
    throw new Error('La clave de idempotencia ya existía pero no se encontró su movimiento al releerla', { cause: error });
  }
  throw error;
}

// Un logger roto no puede hacer que el aviso de stock bajo lance: nunca debe cambiar la respuesta del movimiento.
function registrarFallo(logger, registro) {
  try {
    logger.error(registro);
  } catch {
    // se ignora: registrar es secundario
  }
}

/**
 * Aviso de stock bajo (D13; llamada 3 de la Tabla 2, «aviso»). Se llama DESPUÉS del commit, con la conexión normal (nunca con
 * la transacción): lee el umbral del producto y el total de TODAS las bodegas y, si el total es ESTRICTAMENTE menor que la
 * cantidad mínima, avisa a ms-notificaciones SIN esperar respuesta (el contrato lo dice así; esperar añadiría hasta 3 s al
 * movimiento con ms-notificaciones colgado).
 * - No se evalúa tras TRASLADO_SALIDA, TRASLADO_ENTRADA ni CARGA_INICIAL (tipos.evaluaUmbral).
 * - NUNCA rechaza: un fallo de la lectura o del aviso (también síncrono, o una promesa que rechaza) solo se registra con
 *   logger.error; el movimiento ya está guardado y su respuesta no cambia. Las Tareas 9–13 la llaman igual tras su commit
 *   (p. ej. la aprobación de un conteo, una vez por AJUSTE).
 * @param {{db: object, clients: {notificaciones: object}, logger: object}} deps
 * @param {{tipo: string, idProducto: number, idBodega: number, identity: object}} movimiento la bodega es la del movimiento
 *   (va en el aviso); el total es el de todas
 * @returns {Promise<void>} se resuelve tras las lecturas, sin esperar el aviso
 */
async function evaluarUmbral({ db, clients, logger }, { tipo, idProducto, idBodega, identity }) {
  const fallo = (mensaje) => (error) => registrarFallo(logger, { mensaje, id_producto: idProducto, id_bodega: idBodega, error: describirError(error) });
  try {
    if (!evaluaUmbral(tipo)) return;
    const umbral = await umbralRepository.findByProducto(db, idProducto);
    if (!umbral) return;
    const cantidadTotal = await saldoRepository.totalPorProducto(db, idProducto);
    if (!(cantidadTotal < umbral.cantidad_minima)) return;
    const aviso = clients.notificaciones.notificarStockBajo(
      { idProducto, idBodega, cantidadTotal, cantidadMinima: umbral.cantidad_minima },
      headersDe(identity),
    );
    // Sin await. El cliente real nunca rechaza, pero un rechazo sin manejar tumbaría el proceso: el catch no sobra.
    Promise.resolve(aviso).catch(fallo('No se pudo avisar el stock bajo a ms-notificaciones'));
  } catch (error) {
    fallo('No se pudo evaluar el umbral de stock tras el movimiento')(error);
  }
}

/**
 * Registra un movimiento por POST /movimientos. Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401 (D8, D22).
 * 2. Idempotency-Key: falta, vacía, más de 200 caracteres o con «#» → 400. Se guarda con la operación `mov` (D25b).
 * 3. Repetición: si este usuario ya usó la clave se devuelve el movimiento original (replayed) SIN validar el cuerpo, sin
 *    permisos y sin catálogo: un reintento tras un éxito debe dar 200 aunque ms-catalogo esté caído (D7, D25).
 * 4. Cuerpo: 422 (y 403 para los tipos reservados, D4).
 * 5. Alcance de bodega: un operador fuera de la suya (o sin bodega) → 403.
 * 6. Catálogo: GET /productos/{id} (llamada 1); null → 404, sin respuesta → 503. Se llama SIN ninguna conexión tomada.
 * 7. Transacción con el motor (bloqueo, saldo, movimiento). Los errores no se guardan: no dejan clave y un reintento con la
 *    misma clave se vuelve a ejecutar.
 * 8. Tras el commit, el umbral (evaluarUmbral), que nunca cambia el 201. Una repetición no vuelve a avisar.
 * @param {{db: object, clients: {catalogo: object}, logger: object}} deps
 * @param {{body: unknown, claveIdempotencia: string|undefined, identity: object}} peticion
 * @returns {Promise<{movimiento: Movimiento, replayed: boolean}>}
 */
async function registrarMovimiento(deps, { body, claveIdempotencia, identity }) {
  const { db, clients } = deps;
  requireUser(identity);
  const almacenada = claveAlmacenada(identity.idUsuario, OPERACIONES.MOVIMIENTO, leerClaveIdempotencia(claveIdempotencia));

  const repetido = await movimientoRepository.findByClave(db, almacenada);
  if (repetido) return { movimiento: repetido, replayed: true };

  const datos = leerCuerpo(body);
  scopeBodega(identity, datos.idBodega);

  const producto = await clients.catalogo.obtenerProducto(datos.idProducto, headersDe(identity));
  // El cliente devuelve el producto o null; cualquier resultado vacío se trata como inexistente (falla cerrado). Un producto
  // INACTIVO en el catálogo se acepta: el contrato solo exige que exista.
  if (!producto) throw e.noExiste('El producto no existe');

  let movimiento;
  try {
    movimiento = await db.transaction((trx) => stockService.aplicarMovimiento(trx, {
      ...datos, claveIdempotencia: almacenada, idUsuario: identity.idUsuario,
    }));
  } catch (error) {
    return { movimiento: await resolverFallo(db, almacenada, error), replayed: true };
  }
  await evaluarUmbral(deps, { tipo: movimiento.tipo, idProducto: movimiento.id_producto, idBodega: movimiento.id_bodega, identity });
  return { movimiento, replayed: false };
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearMovimientoService(deps = {}) {
  return {
    registrar: (peticion) => registrarMovimiento(deps, peticion),
  };
}

module.exports = { registrarMovimiento, evaluarUmbral, crearMovimientoService };
