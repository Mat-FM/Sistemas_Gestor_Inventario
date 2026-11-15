const { TIPOS, TIPOS_PERMITIDOS_POR_API, delta, evaluaUmbral } = require('../domain/tipos');
const { describirError, e } = require('../errors');
const { headersDe } = require('../clients/propagacion');
const { ENTERO_MAXIMO, cuerpoObjeto, entero, enumerado, fecha, recoger, texto, validarCampos } = require('../http/validate');
const { requireUser, scopeBodega } = require('../middleware/identity');
const movimientoRepository = require('../repositories/movimientoRepository');
const saldoRepository = require('../repositories/saldoRepository');
const umbralRepository = require('../repositories/umbralRepository');
const { OPERACIONES, claveAlmacenada, leerClaveIdempotencia, resolverFallo } = require('./idempotencia');
const stockService = require('./stockService');

// Lógica de negocio de los movimientos (RF04, RF10, RF15, RNF17; RNF13): el registro (POST /movimientos: idempotencia por usuario
// y operación en idempotencia.js, validación del cuerpo, permisos, confirmación del producto en ms-catalogo y la transacción con
// el motor, stockService) y las dos lecturas del kardex (listarMovimientos y obtenerMovimiento). No
// sabe nada de HTTP: recibe el cuerpo, el valor de la cabecera Idempotency-Key y la identidad como datos. El SQL vive en los
// repositorios.
//
// Las dependencias llegan en `deps` = { db, clients, logger } y se leen en cada llamada (no al construir), como en el resto de
// servicios: rutasDeclaradas() se puede llamar sin dependencias.

// Largos exactos de las columnas de `movimientos` (migración 20261103000100): un texto más largo sería un 22001 (un 500).
// lotes.codigo_lote es varchar(50).
const LARGOS = { documento_referencia: 100, observacion: 500, codigo_lote: 50 };

// Texto opcional de una columna nullable: ausente o null → null; cualquier otro valor pasa por `texto` (422 si no cabe).
const textoOpcional = (valor, campo) => (valor === undefined || valor === null ? null : texto(valor, campo, { max: LARGOS[campo] }));

/** `cantidad` según el tipo (D2, D3): AJUSTE es un entero con signo distinto de 0; los demás, un entero ≥ 1. Techo: INTEGER. */
function leerCantidad(tipo, valor) {
  if (tipo !== 'AJUSTE') return entero(valor, 'cantidad');
  const cantidad = entero(valor, 'cantidad', { min: -ENTERO_MAXIMO });
  if (cantidad === 0) throw e.datosNoValidos([{ campo: 'cantidad', mensaje: 'un AJUSTE no puede ser de 0' }]);
  return cantidad;
}

const ausente = (valor) => valor === undefined || valor === null;
const rechazoLote = (mensaje) => e.datosNoValidos([{ campo: 'lote', mensaje }]);

/** `id_lote` (D27): ausente o null → null; si no, un entero positivo dentro del INTEGER. */
const leerIdLote = (valor) => (ausente(valor) ? null : entero(valor, 'id_lote'));

// ¿El movimiento BAJA el saldo? Solo se sabe con un tipo de la API y una cantidad entera ≠ 0; si no, ya hay un 422 sobre esos
// campos y no se añade otro aquí. AJUSTE baja con cantidad negativa; SALIDA y DEVOLUCION_PROVEEDOR siempre (D3).
function bajaElSaldo(tipo, cantidad) {
  if (!TIPOS_PERMITIDOS_POR_API.includes(tipo) || !Number.isSafeInteger(cantidad) || cantidad === 0) return false;
  if (Math.abs(cantidad) > ENTERO_MAXIMO) return false;
  if (tipo === 'AJUSTE') return cantidad < 0;
  return cantidad > 0 && delta(tipo, cantidad) < 0;
}

/**
 * `lote` (D27): ausente o null → null. Si viene, debe ser un objeto { codigo_lote, fecha_vencimiento } (los demás campos del
 * objeto se descartan), no puede ir junto con un `id_lote` y solo vale en un movimiento que SUBE el saldo (al retirar no se crea
 * un lote). `codigo_lote`: texto recortado de 1 a 50 caracteres; `fecha_vencimiento`: fecha real YYYY-MM-DD, OBLIGATORIA
 * (D28(b): en el contrato solo `lote` lleva «?»; ausente o null es 422). El motor sí admite la fecha nula, porque la carga
 * inicial (Tarea 13) la deja opcional. Informa a la vez el código y la fecha inválidos.
 * @returns {{codigoLote: string, fechaVencimiento: string|null}|null} la forma que recibe el motor
 */
function leerLote(datos) {
  const { lote } = datos;
  if (ausente(lote)) return null;
  if (!ausente(datos.id_lote)) throw rechazoLote('no se puede enviar junto con id_lote');
  if (typeof lote !== 'object' || Array.isArray(lote)) throw rechazoLote('debe ser un objeto { codigo_lote, fecha_vencimiento }, ambos obligatorios');
  if (bajaElSaldo(datos.tipo, datos.cantidad)) throw rechazoLote('solo se admite en un movimiento que sube el saldo');
  const detalles = [];
  const codigoLote = recoger(detalles, () => texto(lote.codigo_lote, 'lote.codigo_lote', { max: LARGOS.codigo_lote }));
  const fechaVencimiento = recoger(detalles, () => {
    if (ausente(lote.fecha_vencimiento)) {
      throw e.datosNoValidos([{ campo: 'lote.fecha_vencimiento', mensaje: 'es obligatoria cuando se envía un lote' }]);
    }
    return fecha(lote.fecha_vencimiento, 'lote.fecha_vencimiento');
  });
  if (detalles.length > 0) throw e.datosNoValidos(detalles);
  return { codigoLote, fechaVencimiento };
}

/**
 * Cuerpo de POST /movimientos: {tipo, id_producto, id_bodega, cantidad, id_lote?, lote?: {codigo_lote, fecha_vencimiento},
 * documento_referencia?, observacion?} (Tabla 9).
 * Orden: cuerpo que no es un objeto (422 «cuerpo») → tipo reservado (403, D4) → todos los campos a la vez (422). Un tipo
 * válido pero reservado es un permiso, no un dato inválido: se rechaza antes de mirar el resto del cuerpo. Cualquier otro
 * campo (`id_usuario`, `saldo_resultante`, `fecha`…) se descarta: los fija el servidor.
 */
function leerCuerpo(cuerpo) {
  const datos = cuerpoObjeto(cuerpo);
  if (TIPOS.includes(datos.tipo) && !TIPOS_PERMITIDOS_POR_API.includes(datos.tipo)) {
    throw e.sinPermiso(`El tipo ${datos.tipo} no se puede registrar por esta ruta`);
  }
  return validarCampos({
    tipo: () => enumerado(datos.tipo, 'tipo', TIPOS_PERMITIDOS_POR_API),
    idProducto: () => entero(datos.id_producto, 'id_producto'),
    idBodega: () => entero(datos.id_bodega, 'id_bodega'),
    cantidad: () => leerCantidad(datos.tipo, datos.cantidad),
    idLote: () => leerIdLote(datos.id_lote),
    lote: () => leerLote(datos),
    documentoReferencia: () => textoOpcional(datos.documento_referencia, 'documento_referencia'),
    observacion: () => textoOpcional(datos.observacion, 'observacion'),
  });
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
 *   logger.error; el movimiento ya está guardado y su respuesta no cambia. Las Tareas 11–13 la llaman igual tras su commit
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
 *    misma clave se vuelve a ejecutar. Si la transacción falla, resolverFallo relee por la clave: si otra petición del mismo
 *    usuario la confirmó entre medias, se responde con ese movimiento (200).
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

/**
 * Una página del kardex (RF10, RF15). Un operador de bodega solo ve la suya (scopeBodega): sin `idBodega` se usa la suya y con
 * otra es 403; los demás roles y las llamadas internas (sin X-User-Id, D8) ven cualquier bodega. `total` es el de las filas del
 * filtro EFECTIVO (el de un operador, su bodega): no revela cuántos movimientos hay en otras bodegas. Una lectura: no llama al
 * catálogo ni a notificaciones.
 * @param {{db: object}} deps
 * @param {{identity: object, idProducto?: number, idBodega?: number, idUsuario?: number, tipo?: string, fechaDesde?: string,
 *   fechaHasta?: string, limit: number, offset: number}} consulta fechaDesde y fechaHasta son días UTC `YYYY-MM-DD` (D29)
 * @returns {Promise<{filas: Movimiento[], total: number}>}
 * @throws 403 SIN_PERMISO
 */
async function listarMovimientos({ db }, { identity, idProducto, idBodega, idUsuario, tipo, fechaDesde, fechaHasta, limit, offset }) {
  const bodegaEfectiva = scopeBodega(identity, idBodega);
  return movimientoRepository.listar(db, { idProducto, idBodega: bodegaEfectiva, idUsuario, tipo, fechaDesde, fechaHasta, limit, offset });
}

/**
 * Un movimiento del kardex por su id. Un operador de bodega solo puede ver los de su bodega: uno de otra bodega es 403 (no 404:
 * el contrato dice que el operador consulta «el kardex de su bodega»). Un operador SIN bodega asignada recibe 403 antes de tocar
 * la base, exista o no el movimiento. Los demás roles y las llamadas internas lo ven siempre.
 * @param {{db: object}} deps
 * @param {{identity: object, id: number}} peticion `id` ya validado por el controlador (entero positivo dentro del INTEGER)
 * @returns {Promise<Movimiento>}
 * @throws 403 SIN_PERMISO, 404 NO_EXISTE
 */
async function obtenerMovimiento({ db }, { identity, id }) {
  scopeBodega(identity); // un operador sin bodega asignada no consulta nada
  const movimiento = await movimientoRepository.findById(db, id);
  if (!movimiento) throw e.noExiste('El movimiento no existe');
  scopeBodega(identity, movimiento.id_bodega);
  return movimiento;
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearMovimientoService(deps = {}) {
  return {
    registrar: (peticion) => registrarMovimiento(deps, peticion),
    listar: (consulta) => listarMovimientos(deps, consulta),
    obtener: (peticion) => obtenerMovimiento(deps, peticion),
  };
}

module.exports = { registrarMovimiento, listarMovimientos, obtenerMovimiento, evaluarUmbral, crearMovimientoService };
