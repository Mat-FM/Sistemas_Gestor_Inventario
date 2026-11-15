const { TIPOS, TIPOS_PERMITIDOS_POR_API } = require('../domain/tipos');
const { e } = require('../errors');
const { headersDe } = require('../clients/propagacion');
const { ENTERO_MAXIMO, cuerpoObjeto, entero, enumerado, texto, validarCampos } = require('../http/validate');
const { requireUser, scopeBodega } = require('../middleware/identity');
const movimientoRepository = require('../repositories/movimientoRepository');
const stockService = require('./stockService');

// Lógica de negocio de POST /movimientos (RF04, RF10, RNF17; RNF13): idempotencia por usuario, validación del cuerpo, permisos,
// confirmación del producto en ms-catalogo y la transacción con el motor (stockService). No sabe nada de HTTP: recibe el cuerpo,
// el valor de la cabecera Idempotency-Key y la identidad como datos. El SQL vive en los repositorios.
//
// Las dependencias llegan en `deps` = { db, clients, logger } y se leen en cada llamada (no al construir), como en el resto de
// servicios: rutasDeclaradas() se puede llamar sin dependencias.

// La cabecera Idempotency-Key, sin espacios en los extremos, tiene de 1 a 200 caracteres (D25): con el prefijo `<id_usuario>:`
// (hasta 11 caracteres) y los sufijos `#<n>` de las claves derivadas (D5, hasta 11 más) cabe en varchar(255).
const LARGO_MAXIMO_CLAVE = 200;

// Largos exactos de las columnas de `movimientos` (migración 20261103000100): un texto más largo sería un 22001 (un 500).
const LARGOS = { documento_referencia: 100, observacion: 500 };

/**
 * La clave tal como se guarda en movimientos.clave_idempotencia: `<id_usuario>:<clave>` (D25). Es inyectiva porque el id solo
 * tiene dígitos: el primer `:` separa siempre el usuario de su clave, así que el usuario 1 con la clave «2:x» («1:2:x») y el
 * usuario 12 con la clave «x» («12:x») nunca coinciden. Una sola función para que las Tareas 9–13 armen sus claves igual
 * (las derivadas de D5 añaden su sufijo `#<n>` a este resultado).
 * @param {number} idUsuario entero positivo (X-User-Id ya validado)
 * @param {string} clave la cabecera ya validada (leerClaveIdempotencia)
 * @returns {string}
 * @throws {TypeError} si los argumentos no son un id y un texto no vacío (error de programación)
 */
function claveAlmacenada(idUsuario, clave) {
  if (!Number.isSafeInteger(idUsuario) || idUsuario < 1) throw new TypeError('idUsuario debe ser un entero positivo');
  if (typeof clave !== 'string' || clave === '') throw new TypeError('La clave de idempotencia debe ser un texto no vacío');
  return `${idUsuario}:${clave}`;
}

/**
 * Valor de la cabecera Idempotency-Key, sin espacios en los extremos. Node une con «, » los valores de una cabecera repetida;
 * el resultado se trata como una sola clave con la misma regla de largo.
 * @param {string|undefined} valor
 * @returns {string} la clave recortada, de 1 a 200 caracteres
 * @throws 400 PETICION_MAL_FORMADA si falta, está vacía (o solo tiene espacios) o supera los 200 caracteres
 */
function leerClaveIdempotencia(valor) {
  const clave = typeof valor === 'string' ? valor.trim() : '';
  if (clave === '') throw e.malFormada('Falta la cabecera Idempotency-Key');
  if (clave.length > LARGO_MAXIMO_CLAVE) {
    throw e.malFormada(`La cabecera Idempotency-Key debe tener como máximo ${LARGO_MAXIMO_CLAVE} caracteres`);
  }
  return clave;
}

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

/**
 * Registra un movimiento por POST /movimientos. Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401 (D8, D22).
 * 2. Idempotency-Key: falta, vacía o más de 200 caracteres → 400.
 * 3. Repetición: si este usuario ya usó la clave se devuelve el movimiento original (replayed) SIN validar el cuerpo, sin
 *    permisos y sin catálogo: un reintento tras un éxito debe dar 200 aunque ms-catalogo esté caído (D7, D25).
 * 4. Cuerpo: 422 (y 403 para los tipos reservados, D4).
 * 5. Alcance de bodega: un operador fuera de la suya (o sin bodega) → 403.
 * 6. Catálogo: GET /productos/{id} (llamada 1); null → 404, sin respuesta → 503. Se llama SIN ninguna conexión tomada.
 * 7. Transacción con el motor (bloqueo, saldo, movimiento). Los errores no se guardan: no dejan clave y un reintento con la
 *    misma clave se vuelve a ejecutar.
 * @param {{db: object, clients: {catalogo: object}, logger: object}} deps
 * @param {{body: unknown, claveIdempotencia: string|undefined, identity: object}} peticion
 * @returns {Promise<{movimiento: Movimiento, replayed: boolean}>}
 */
async function registrarMovimiento({ db, clients }, { body, claveIdempotencia, identity }) {
  requireUser(identity);
  const almacenada = claveAlmacenada(identity.idUsuario, leerClaveIdempotencia(claveIdempotencia));

  const repetido = await movimientoRepository.findByClave(db, almacenada);
  if (repetido) return { movimiento: repetido, replayed: true };

  const datos = leerCuerpo(body);
  scopeBodega(identity, datos.idBodega);

  const producto = await clients.catalogo.obtenerProducto(datos.idProducto, headersDe(identity));
  // El cliente devuelve el producto o null; cualquier resultado vacío se trata como inexistente (falla cerrado). Un producto
  // INACTIVO en el catálogo se acepta: el contrato solo exige que exista.
  if (!producto) throw e.noExiste('El producto no existe');

  try {
    const movimiento = await db.transaction((trx) => stockService.aplicarMovimiento(trx, {
      ...datos, claveIdempotencia: almacenada, idUsuario: identity.idUsuario,
    }));
    return { movimiento, replayed: false };
  } catch (error) {
    return { movimiento: await resolverFallo(db, almacenada, error), replayed: true };
  }
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearMovimientoService(deps = {}) {
  return {
    registrar: (peticion) => registrarMovimiento(deps, peticion),
  };
}

module.exports = { LARGO_MAXIMO_CLAVE, claveAlmacenada, leerClaveIdempotencia, registrarMovimiento, crearMovimientoService };
