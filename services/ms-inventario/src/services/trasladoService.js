const { AppError, e } = require('../errors');
const { headersDe } = require('../clients/propagacion');
const { cuerpoObjeto, entero, idRuta, recoger, texto } = require('../http/validate');
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
// TRASLADO_SALIDA lleva derivada(base, SUFIJOS_TRASLADO.SALIDA) y el TRASLADO_ENTRADA derivada(base, SUFIJOS_TRASLADO.ENTRADA). La
// repetición de la creación se detecta releyendo la de salida y la de la recepción, la de entrada; por eso crear y recibir con
// la MISMA clave literal son operaciones distintas y las dos se ejecutan.
//
// Limitaciones documentadas (D31(f), D28(a)): con la bodega de destino inactiva, o si el destino creó después de la creación el
// mismo lote con otra fecha de vencimiento, la recepción responde 409 y el traslado sigue EN_TRANSITO: la mercancía queda en
// tránsito (contada en el invariante) hasta reactivar la bodega o corregir el lote.

// Largo exacto de movimientos.observacion (migración 20261103000100): un texto más largo sería un 22001 (un 500).
const LARGO_OBSERVACION = 500;

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

const describirFecha = (fecha) => fecha ?? 'sin fecha de vencimiento';

/**
 * El 409 CONFLICTO de un lote que ya existe en la bodega de destino con OTRA fecha de vencimiento (D28(a)): ÚNICO formato para
 * la creación (precomprobarCreacion) y la recepción (el conflicto que detecta el motor y comprobarLoteDeDestino). Siempre sobre
 * `id_lote`, el campo que el cliente envió al CREAR (en la recepción no envía ninguno de lote). El mensaje nombra el lote y las
 * dos fechas (`null` es «sin fecha de vencimiento») y dice qué pasa con el traslado: al crear, no se crea; al recibir
 * (`enTransito`), sigue EN_TRANSITO hasta regularizar el lote del destino y volver a recibirlo.
 * @param {string} codigoLote
 * @param {string|null} fechaDestino la del lote que ya está en el destino
 * @param {string|null} fechaOrigen la del lote de origen del traslado
 * @param {{enTransito?: boolean}} [opciones]
 * @returns {AppError} 409 CONFLICTO (no lo lanza)
 */
function conflictoDeFecha(codigoLote, fechaDestino, fechaOrigen, { enTransito = false } = {}) {
  const diferencia = `El lote ${codigoLote} de la bodega de destino (${describirFecha(fechaDestino)}) tiene otra fecha de vencimiento que el de la bodega de origen (${describirFecha(fechaOrigen)}).`;
  const consecuencia = enTransito
    ? 'El traslado sigue EN_TRANSITO: regularice el lote en la bodega de destino y vuelva a enviar la recepción.'
    : 'El traslado no se creó: su recepción fallaría con la mercancía en tránsito.';
  const mensaje = `${diferencia} ${consecuencia}`;
  return e.conflicto('CONFLICTO', mensaje, [{ campo: 'id_lote', mensaje }]);
}

/**
 * ¿Es el 409 CONFLICTO del motor por un lote que ya existe con otra fecha (stockService.entrarPorCodigo)? Se reconoce por el
 * código y el CAMPO de su detalle, nunca por el texto. Ningún otro error lo es: ni BODEGA_INACTIVA, ni STOCK_INSUFICIENTE, ni
 * el 422 de desborde, ni el CONFLICTO de clave de D31(b).
 */
const esConflictoDeFechaDelMotor = (error) => error instanceof AppError && error.codigo === 'CONFLICTO'
  && error.detalles?.[0]?.campo === 'lote.fecha_vencimiento';

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
    throw conflictoDeFecha(lote.codigo_lote, enDestino.fecha_vencimiento, lote.fecha_vencimiento);
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
 *    Por eso el saldo de origen se bloquea (y, si no existía, se crea en 0) ANTES de que el motor compruebe que la bodega de
 *    origen está activa: es inocuo, porque con el origen inactivo el motor lanza 409 BODEGA_INACTIVA y la transacción se deshace
 *    entera (el saldo creado, el traslado y el bloqueo incluidos).
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

/** Cuerpo de POST /traslados/{id}/recepcion: {observacion?}. Ausente o null → null; si viene, texto de 1 a 500 caracteres. */
function leerCuerpoRecepcion(cuerpo) {
  const { observacion } = cuerpoObjeto(cuerpo);
  if (observacion === undefined || observacion === null) return null;
  return texto(observacion, 'observacion', { max: LARGO_OBSERVACION });
}

// El {id} de la ruta: lo que no sea un entero positivo canónico dentro del INTEGER es 404 NO_EXISTE (idRuta). Admite el número
// ya convertido para quien llame al servicio sin HTTP.
const leerIdTraslado = (valor) => idRuta(typeof valor === 'number' ? String(valor) : valor);

/**
 * Respuesta de una recepción ya hecha con esta clave (RNF17, D31(b), D31(c)): el movimiento TRASLADO_ENTRADA hallado por la clave
 * de entrada solo es una repetición si es de ESTE traslado; si es de OTRO, la clave ya se usó en otra operación y devolver la
 * recepción de otro traslado sería un error silencioso → 409 CONFLICTO. Devuelve el traslado en su estado ACTUAL.
 */
async function repeticionDeRecepcion(db, movimiento, idTraslado) {
  if (movimiento.id_traslado !== idTraslado) {
    throw e.conflicto('CONFLICTO', 'La Idempotency-Key ya se usó en otra operación: la recepción de otro traslado');
  }
  return { traslado: await trasladoDe(db, movimiento), movimiento, replayed: true };
}

/**
 * El lote que entra al destino: el MISMO código y la MISMA fecha que el lote de origen del traslado (D28(a)). El lote de origen
 * se lee SIN bloqueo: su código y su fecha son inmutables (loteRepository.findById).
 */
async function loteDeEntrada(trx, idLote) {
  const origen = await loteRepository.findById(trx, idLote);
  if (!origen) throw new Error(`El lote ${idLote} del traslado no existe`); // los lotes no se borran: estado imposible, 500
  return { codigoLote: origen.codigo_lote, fechaVencimiento: origen.fecha_vencimiento };
}

/**
 * Tras la entrada, el lote del destino debe tener la fecha del de origen. El motor ya rechaza (409 CONFLICTO) una fecha
 * DISTINTA de la guardada, pero con una fecha de origen NULA suma sin mirar la guardada (D27(d), lo necesita la carga inicial):
 * mercancía sin vencimiento quedaría mezclada con mercancía que vence. La creación lo precomprueba; esto cubre el caso en que el
 * destino creó ese lote con fecha después de la creación. Se lee con el saldo del destino ya bloqueado (nadie más cambia el lote).
 */
async function comprobarLoteDeDestino(trx, idLoteDestino, lote) {
  const destino = await loteRepository.findById(trx, idLoteDestino);
  if (destino?.fecha_vencimiento !== lote.fechaVencimiento) {
    throw conflictoDeFecha(lote.codigoLote, destino?.fecha_vencimiento ?? null, lote.fechaVencimiento, { enTransito: true });
  }
}

/**
 * El 409 CONFLICTO del motor por un lote del destino con otra fecha NO NULA habla de `lote.fecha_vencimiento`, un campo que el
 * cliente de la recepción nunca envió, y no dice que el traslado sigue en tránsito: se traduce a conflictoDeFecha con la fecha
 * guardada en el destino (la transacción sigue sana: el motor no ejecutó ninguna sentencia fallida, solo lanzó un AppError).
 * Cualquier otro error se relanza TAL CUAL (captura estrecha).
 */
async function traducirConflictoDeLote(trx, error, { idProducto, idBodega, lote }) {
  if (lote === null || !esConflictoDeFechaDelMotor(error)) throw error;
  const destino = await loteRepository.buscarPorCodigo(trx, { idBodega, idProducto, codigoLote: lote.codigoLote });
  throw conflictoDeFecha(lote.codigoLote, destino?.fecha_vencimiento ?? null, lote.fechaVencimiento, { enTransito: true });
}

/**
 * Recibe un traslado (POST /traslados/{id}/recepcion). Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401.
 * 2. Idempotency-Key: falta, vacía, más de 200 caracteres o con «#» → 400.
 * 3. {id} de la ruta: si no es un entero positivo dentro del INTEGER → 404.
 * 4. Repetición: si este usuario ya usó la clave en una recepción (clave de ENTRADA): de ESTE traslado → 200 con el traslado
 *    actual y el movimiento original; de OTRO traslado → 409 CONFLICTO (D31(b)).
 * 5. Traslado inexistente → 404. 6. Alcance: el operador solo recibe en SU bodega (scopeBodega sobre el DESTINO) → 403.
 * 7. Cuerpo: `observacion` (422).
 * 8. Transacción. ORDEN DE BLOQUEO (D31(d)): fila del traslado (FOR UPDATE) → saldo del destino → lote del destino. El estado se
 *    comprueba DESPUÉS de bloquear la fila: dos recepciones simultáneas se ponen en fila y la segunda ve RECIBIDO → 409
 *    TRASLADO_YA_RECIBIDO (con la MISMA clave, resolverFallo encuentra el movimiento de la primera y responde 200). Con lote, el
 *    destino recrea el código y la fecha del de origen (D28(a)); `traslados.id_lote` conserva el de origen y el movimiento lleva
 *    el del destino. El motor aplica TRASLADO_ENTRADA (409 BODEGA_INACTIVA con el destino inactivo, D31(f)) y el traslado pasa a
 *    RECIBIDO. Un lote del destino con otra fecha es 409 CONFLICTO con el formato de conflictoDeFecha (el del motor se traduce
 *    con traducirConflictoDeLote, solo ese). Si algo falla, se deshace todo y el traslado sigue EN_TRANSITO. No llama al catálogo (el producto se confirmó al
 *    crear) ni evalúa el umbral (D13).
 * @param {{db: object}} deps
 * @param {{idTraslado: string|number, body: unknown, claveIdempotencia: string|undefined, identity: object}} peticion
 * @returns {Promise<{traslado: Traslado, movimiento: Movimiento, replayed: boolean}>}
 */
async function recibir({ db }, { idTraslado, body, claveIdempotencia, identity }) {
  requireUser(identity);
  const clave = leerClaveIdempotencia(claveIdempotencia);
  const id = leerIdTraslado(idTraslado);
  const claveEntrada = derivada(claveAlmacenada(identity.idUsuario, OPERACIONES.TRASLADO, clave), SUFIJOS_TRASLADO.ENTRADA);

  const repetido = await movimientoRepository.findByClave(db, claveEntrada);
  if (repetido) return repeticionDeRecepcion(db, repetido, id);

  const actual = await trasladoRepository.findById(db, id);
  if (!actual) throw e.noExiste('El traslado no existe');
  scopeBodega(identity, actual.id_bodega_destino);
  const observacion = leerCuerpoRecepcion(body);

  try {
    const resultado = await db.transaction(async (trx) => {
      const traslado = await trasladoRepository.bloquearPorId(trx, id); // PRIMER bloqueo; el estado se mira después
      if (traslado.estado !== 'EN_TRANSITO') throw e.conflicto('TRASLADO_YA_RECIBIDO', 'El traslado ya fue recibido');
      const lote = traslado.id_lote === null ? null : await loteDeEntrada(trx, traslado.id_lote);
      const destino = { idProducto: traslado.id_producto, idBodega: traslado.id_bodega_destino, lote };
      const movimiento = await stockService.aplicarMovimiento(trx, {
        tipo: 'TRASLADO_ENTRADA', ...destino, cantidad: traslado.cantidad, idTraslado: id, claveIdempotencia: claveEntrada, observacion,
        idUsuario: identity.idUsuario,
      }).catch((error) => traducirConflictoDeLote(trx, error, destino));
      if (lote !== null) await comprobarLoteDeDestino(trx, movimiento.id_lote, lote);
      const recibido = await trasladoRepository.marcarRecibido(trx, id, { idUsuarioRecibe: identity.idUsuario });
      if (!recibido) throw new Error(`El traslado ${id} bloqueado y EN_TRANSITO no se pudo marcar como recibido`);
      return { traslado: recibido, movimiento };
    });
    return { ...resultado, replayed: false };
  } catch (error) {
    return repeticionDeRecepcion(db, await resolverFallo(db, claveEntrada, error), id);
  }
}

/**
 * Una página de traslados (GET /traslados). Un operador de bodega solo ve los traslados cuyo origen O destino es SU bodega
 * (scopeBodega, D31(g)): sin `idBodega` se usa la suya y con otra es 403 (también sin bodega asignada); los demás roles y las
 * llamadas internas (sin X-User-Id, D8) ven todos. `total` es el del filtro EFECTIVO: no revela cuántos traslados hay entre otras
 * bodegas. Una lectura: no llama a otros servicios.
 * @param {object} db instancia de Knex
 * @param {{estado?: string, idBodega?: number, limit: number, offset: number}} filtros ya validados por el controlador
 * @param {object} identity
 * @returns {Promise<{filas: Traslado[], total: number}>}
 * @throws 403 SIN_PERMISO
 */
async function listar(db, { estado, idBodega, limit, offset }, identity) {
  const bodegaEfectiva = scopeBodega(identity, idBodega);
  return trasladoRepository.listar(db, { estado, idBodega: bodegaEfectiva, limit, offset });
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearTrasladoService(deps = {}) {
  return {
    crear: (peticion) => crear(deps, peticion),
    recibir: (peticion) => recibir(deps, peticion),
    listar: (filtros, identity) => listar(deps.db, filtros, identity),
  };
}

module.exports = { crear, recibir, listar, conflictoDeFecha, crearTrasladoService };
