const { describirError, e } = require('../errors');
const { cuerpoObjeto, entero, fecha, idRuta, recoger, validarCampos } = require('../http/validate');
const { requireUser, scopeBodega } = require('../middleware/identity');
const bodegaRepository = require('../repositories/bodegaRepository');
const conteoRepository = require('../repositories/conteoRepository');
const movimientoRepository = require('../repositories/movimientoRepository');
const { OPERACIONES, claveAlmacenada, derivada, leerClaveIdempotencia } = require('./idempotencia');
const movimientoService = require('./movimientoService');
const stockService = require('./stockService');

// Lógica de negocio de los conteos físicos (RF18; RNF13). Un conteo pasa por tres estados (D32(c)):
// - PROGRAMADO (POST /conteos): nace con una línea por producto y `cantidad_sistema` = el saldo de ese instante;
// - EN_REVISION (PUT /conteos/{id}/detalles): se registran las cantidades contadas;
// - APROBADO (POST /conteos/{id}/aprobacion): se aplica un AJUSTE por cada diferencia.
// No sabe nada de HTTP: recibe el cuerpo, el {id} de la ruta y la identidad como datos. El SQL vive en los repositorios. Las
// dependencias llegan en `deps` = { db, clients, logger, now } y se leen en cada llamada (rutasDeclaradas() se llama sin ellas).
// `now` es el reloj (`() => Date`), inyectable para que las pruebas no dependan del día real (D32(g)); por omisión, la hora real.
//
// Alcance (D32(h)): programar y aprobar son de ADMINISTRADOR y eso lo aplica el Gateway (como el resto de permisos por rol, la
// matriz de la Tabla 5); registrar lo contado y las lecturas limitan al operador a la bodega DEL CONTEO (scopeBodega).

const relojReal = () => new Date();

/**
 * Máximo de líneas de un conteo (D33). Aprobar bloquea a la vez los saldos de TODAS sus líneas: un conteo enorme (con 100 kB de
 * cuerpo caben ~14 000 ids) dejaría media bodega sin poder moverse varios segundos. Más de esto se cuenta por partes.
 */
const MAX_LINEAS_CONTEO = 1000;

// 422 de un conteo con demasiadas líneas, sobre `campo` (D33).
const demasiadasLineas = (campo, mensaje) => e.datosNoValidos([{ campo, mensaje }]);

/**
 * El día UTC (YYYY-MM-DD) del instante que da el reloj (D29: todos los servicios usan UTC). Un reloj que no devuelva un Date
 * válido es un error de programación: TypeError (un 500), nunca un 422 inventado.
 */
function diaUtc(now = relojReal) {
  const instante = now();
  if (!(instante instanceof Date) || Number.isNaN(instante.getTime())) throw new TypeError('El reloj (now) debe devolver un Date válido');
  return instante.toISOString().slice(0, 10);
}

/** `fecha_programada`: fecha real YYYY-MM-DD no anterior a `hoy` (texto YYYY-MM-DD de ancho fijo: compara en orden). */
function leerFechaProgramada(valor, hoy) {
  const dia = fecha(valor, 'fecha_programada');
  if (dia < hoy) throw e.datosNoValidos([{ campo: 'fecha_programada', mensaje: `no puede ser anterior a hoy (${hoy}, día UTC)` }]);
  return dia;
}

/**
 * `ids_producto?` (D32(f)): ausente o null → null (todos los productos con existencia en la bodega). Si viene, un arreglo NO
 * vacío de enteros positivos sin repetidos; cada posición inválida o repetida se informa por separado (`ids_producto[i]`). Una
 * lista vacía es 422: un cliente que la envía casi seguro no quería contar «todos».
 */
function leerIdsProducto(valor) {
  if (valor === undefined || valor === null) return null;
  if (!Array.isArray(valor) || valor.length === 0) {
    throw e.datosNoValidos([{ campo: 'ids_producto', mensaje: 'debe ser una lista no vacía de id_producto (omítala para contar todos los productos con existencia)' }]);
  }
  // D33: la longitud antes que cada elemento, para que una lista enorme no cueste nada.
  if (valor.length > MAX_LINEAS_CONTEO) {
    throw demasiadasLineas('ids_producto', `un conteo admite como máximo ${MAX_LINEAS_CONTEO} productos`);
  }
  const detalles = [];
  const vistos = new Set();
  valor.forEach((valorId, posicion) => {
    const campo = `ids_producto[${posicion}]`;
    const id = recoger(detalles, () => entero(valorId, campo));
    if (id === undefined) return;
    if (vistos.has(id)) detalles.push({ campo, mensaje: `el producto ${id} está repetido` });
    vistos.add(id);
  });
  if (detalles.length > 0) throw e.datosNoValidos(detalles);
  return valor;
}

/** Cuerpo de POST /conteos: {id_bodega, fecha_programada, ids_producto?} (Tabla 9). Informa todos los campos inválidos a la vez. */
function leerCuerpoProgramacion(cuerpo, hoy) {
  const datos = cuerpoObjeto(cuerpo);
  return validarCampos({
    idBodega: () => entero(datos.id_bodega, 'id_bodega'),
    fechaProgramada: () => leerFechaProgramada(datos.fecha_programada, hoy),
    idsProducto: () => leerIdsProducto(datos.ids_producto),
  });
}

// El {id} de la ruta: lo que no sea un entero positivo canónico dentro del INTEGER es 404 NO_EXISTE (idRuta). Admite el número
// ya convertido para quien llame al servicio sin HTTP.
const leerIdConteo = (valor) => idRuta(typeof valor === 'number' ? String(valor) : valor);

const conteoNoExiste = () => e.noExiste('El conteo no existe');

/**
 * Programa un conteo (POST /conteos). Orden: requireUser (401) → cuerpo (422; la fecha contra el día UTC de `now`) → bodega
 * inexistente (404) o inactiva (409 BODEGA_INACTIVA, D12) → transacción: cabecera PROGRAMADO + líneas (insertarDetalles); si no
 * resulta ninguna línea → 422 sobre `ids_producto` y se deshace todo (no queda un conteo vacío). No llama al catálogo: el
 * contrato no lo pide y los ids de `ids_producto` se aceptan aunque no tengan saldo (cantidad_sistema 0).
 * La bodega se lee antes de la transacción, sin bloqueo: una inactivación simultánea puede dejar programado un conteo de una
 * bodega recién inactivada (la aprobación vuelve a exigir la bodega activa).
 * @param {{db: object, now?: () => Date}} deps
 * @param {{body: unknown, identity: object}} peticion
 * @returns {Promise<Conteo>} con sus detalles
 */
async function programar({ db, now }, { body, identity }) {
  requireUser(identity);
  const { idBodega, fechaProgramada, idsProducto } = leerCuerpoProgramacion(body, diaUtc(now));
  const bodega = await bodegaRepository.findById(db, idBodega);
  if (!bodega) throw e.noExiste('La bodega no existe');
  if (!bodega.activa) throw e.conflicto('BODEGA_INACTIVA', 'La bodega está inactiva: no admite conteos nuevos');

  return db.transaction(async (trx) => {
    const { id_conteo: idConteo } = await conteoRepository.insertarConteo(trx, { idBodega, fechaProgramada });
    // Sin ids_producto la consulta se corta en MAX + 1 filas: basta para saber si se pasa del tope sin leer toda la bodega (D33).
    const lineas = await conteoRepository.insertarDetalles(trx, { idConteo, idBodega, idsProducto, limite: MAX_LINEAS_CONTEO + 1 });
    if (lineas > MAX_LINEAS_CONTEO) {
      throw demasiadasLineas('ids_producto', `la bodega tiene más de ${MAX_LINEAS_CONTEO} productos con existencia: cuéntelos por partes indicando ids_producto (máximo ${MAX_LINEAS_CONTEO} por conteo)`);
    }
    if (lineas === 0) {
      throw e.datosNoValidos([{ campo: 'ids_producto', mensaje: 'la bodega no tiene productos con existencia: indique los productos a contar' }]);
    }
    return conteoRepository.findById(trx, idConteo);
  });
}

/**
 * Un conteo con sus líneas (GET /conteos/{id}). Orden: id (404) → un operador sin bodega asignada → 403 antes de tocar la base →
 * conteo inexistente (404) → un operador de otra bodega → 403 (scopeBodega sobre la bodega DEL CONTEO, D32(h)). Los demás roles y
 * las llamadas internas (sin X-User-Id, D8) lo ven siempre.
 * @param {{db: object}} deps
 * @param {{idConteo: string|number, identity: object}} peticion
 * @returns {Promise<Conteo>}
 */
async function obtener({ db }, { idConteo, identity }) {
  const id = leerIdConteo(idConteo);
  scopeBodega(identity);
  const conteo = await conteoRepository.findById(db, id);
  if (!conteo) throw conteoNoExiste();
  scopeBodega(identity, conteo.id_bodega);
  return conteo;
}

/**
 * Una página de conteos (GET /conteos), sin líneas. Un operador de bodega solo ve los de SU bodega: sin `idBodega` se usa la
 * suya y con otra es 403 (también sin bodega asignada); los demás roles y las llamadas internas ven todos. `total` es el del
 * filtro EFECTIVO.
 * @param {{db: object}} deps
 * @param {{estado?: string, idBodega?: number, limit: number, offset: number, identity: object}} consulta ya validada
 * @returns {Promise<{filas: object[], total: number}>}
 */
async function listar({ db }, { estado, idBodega, limit, offset, identity }) {
  const bodegaEfectiva = scopeBodega(identity, idBodega);
  return conteoRepository.listar(db, { estado, idBodega: bodegaEfectiva, limit, offset });
}

const estadoInvalido = (mensaje) => e.conflicto('CONTEO_ESTADO_INVALIDO', mensaje);

/**
 * D33: un PUT con más de MAX_LINEAS_CONTEO líneas es 422 sobre `detalles`. Se llama ANTES de leer el conteo (sin tocar la base:
 * ningún conteo puede tener tantas líneas) y otra vez dentro de leerCuerpoDetalles. Un cuerpo que no es un objeto o sin
 * arreglo se deja a leerCuerpoDetalles.
 */
function rechazarDemasiadosDetalles(cuerpo) {
  const detalles = cuerpo !== null && typeof cuerpo === 'object' ? cuerpo.detalles : undefined;
  if (Array.isArray(detalles) && detalles.length > MAX_LINEAS_CONTEO) {
    throw demasiadasLineas('detalles', `un conteo tiene como máximo ${MAX_LINEAS_CONTEO} líneas`);
  }
}

/**
 * Cuerpo de PUT /conteos/{id}/detalles: {detalles: [{id_producto, cantidad_contada}]} (Tabla 9, D32(b)). `detalles` es un
 * arreglo NO vacío; cada elemento, un objeto con `id_producto` (entero positivo) y `cantidad_contada` (entero ≥ 0, techo
 * INTEGER). Un id_producto repetido es 422 sobre la posición repetida. Informa todos los problemas a la vez
 * (`detalles[i].campo`); los demás campos de cada elemento se descartan.
 * @returns {Array<{idProducto: number, cantidadContada: number}>}
 */
function leerCuerpoDetalles(cuerpo) {
  const { detalles } = cuerpoObjeto(cuerpo);
  if (!Array.isArray(detalles) || detalles.length === 0) {
    throw e.datosNoValidos([{ campo: 'detalles', mensaje: 'debe ser una lista no vacía de { id_producto, cantidad_contada }' }]);
  }
  rechazarDemasiadosDetalles(cuerpo);
  const errores = [];
  const vistos = new Set();
  const lineas = detalles.map((linea, posicion) => {
    const prefijo = `detalles[${posicion}]`;
    if (typeof linea !== 'object' || linea === null || Array.isArray(linea)) {
      errores.push({ campo: prefijo, mensaje: 'debe ser un objeto { id_producto, cantidad_contada }' });
      return undefined;
    }
    const idProducto = recoger(errores, () => entero(linea.id_producto, `${prefijo}.id_producto`));
    if (idProducto !== undefined && vistos.has(idProducto)) {
      errores.push({ campo: `${prefijo}.id_producto`, mensaje: `el producto ${idProducto} está repetido` });
    }
    vistos.add(idProducto);
    const cantidadContada = recoger(errores, () => entero(linea.cantidad_contada, `${prefijo}.cantidad_contada`, { min: 0 }));
    return { idProducto, cantidadContada };
  });
  if (errores.length > 0) throw e.datosNoValidos(errores);
  return lineas;
}

/**
 * Registra lo contado (PUT /conteos/{id}/detalles). Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401 (D8, D22). 2. {id} de la ruta inválido → 404.
 * 3. Un operador sin bodega asignada → 403 antes de tocar la base; más de MAX_LINEAS_CONTEO líneas → 422 (D33), también antes.
 * 4. Conteo inexistente → 404.
 * 5. Un operador de otra bodega → 403 (scopeBodega sobre la bodega DEL CONTEO, D32(h)). 6. Cuerpo → 422.
 * 7. Transacción: bloquea la fila del conteo (FOR UPDATE) ANTES de mirar el estado (una aprobación simultánea se pone en fila y
 *    este PUT ve APROBADO → 409 CONTEO_ESTADO_INVALIDO); un producto que no está en el conteo → 422 sobre su posición (nada
 *    cambia: ninguna línea del cuerpo se guarda); registra lo contado (registrarContados: cantidad_sistema = saldo de ESE
 *    instante, diferencia = contada − sistema, D11, D32(a)) y deja el conteo EN_REVISION. Repetible mientras no esté APROBADO.
 *    No toca saldos ni kardex, no llama a otros servicios y no necesita Idempotency-Key: repetirlo con el mismo cuerpo deja el
 *    mismo resultado (salvo que el saldo haya cambiado, y entonces lo correcto es la foto nueva).
 * @param {{db: object}} deps
 * @param {{idConteo: string|number, body: unknown, identity: object}} peticion
 * @returns {Promise<Conteo>} el conteo EN_REVISION con sus líneas
 */
async function registrarDetalles({ db }, { idConteo, body, identity }) {
  requireUser(identity);
  const id = leerIdConteo(idConteo);
  scopeBodega(identity);
  rechazarDemasiadosDetalles(body);
  const actual = await conteoRepository.findById(db, id);
  if (!actual) throw conteoNoExiste();
  scopeBodega(identity, actual.id_bodega);
  const lineas = leerCuerpoDetalles(body);

  return db.transaction(async (trx) => {
    const conteo = await conteoRepository.bloquearPorId(trx, id); // PRIMER bloqueo; el estado se mira después
    if (conteo.estado === 'APROBADO') throw estadoInvalido('El conteo ya fue aprobado: no admite más cantidades contadas');
    const enConteo = new Set(actual.detalles.map((linea) => linea.id_producto)); // las líneas no cambian tras programar
    const fuera = lineas
      .map((linea, posicion) => ({ linea, posicion }))
      .filter(({ linea }) => !enConteo.has(linea.idProducto))
      .map(({ linea, posicion }) => ({ campo: `detalles[${posicion}].id_producto`, mensaje: `el producto ${linea.idProducto} no está en el conteo` }));
    if (fuera.length > 0) throw e.datosNoValidos(fuera);
    await conteoRepository.registrarContados(trx, { idConteo: id, idBodega: conteo.id_bodega, lineas });
    if (!(await conteoRepository.marcarEnRevision(trx, id))) throw new Error(`El conteo ${id} bloqueado y sin aprobar no pasó a EN_REVISION`);
    return conteoRepository.findById(trx, id);
  });
}

/**
 * Las líneas que se ajustan al aprobar (D32(a)(b)): las CONTADAS (`cantidad_contada` registrada) con `diferencia ≠ 0`, por
 * id_producto ascendente (D25c, D32(e): el orden de bloqueo de los saldos; dos aprobaciones de la misma bodega nunca se esperan
 * en orden cruzado). Las que nunca se contaron se ignoran.
 */
const lineasAjustables = (detalles) => detalles
  .filter((linea) => linea.cantidad_contada !== null && linea.diferencia !== 0)
  .sort((a, b) => a.id_producto - b.id_producto);

/**
 * Respuesta de una aprobación ya hecha con esta clave (RNF17, D32(d)): el conteo hallado por `clave_aprobacion` solo es una
 * repetición si es ESTE; si es OTRO, la clave ya se usó en otra operación → 409 CONFLICTO (devolver la aprobación de otro conteo
 * sería un error silencioso). Devuelve el conteo en su estado actual (APROBADO, inmutable) con sus movimientos ORIGINALES,
 * releídos por la clave derivada de cada línea ajustada. Un ajuste que falte es un estado imposible: Error (500).
 */
async function repeticionDeAprobacion(db, hallado, idConteo, base) {
  if (hallado.id_conteo !== idConteo) {
    throw e.conflicto('CONFLICTO', 'La Idempotency-Key ya se usó en otra operación: la aprobación de otro conteo');
  }
  const conteo = await conteoRepository.findById(db, idConteo);
  const movimientos = [];
  for (const linea of lineasAjustables(conteo.detalles)) {
    const movimiento = await movimientoRepository.findByClave(db, derivada(base, linea.id_producto));
    if (!movimiento) throw new Error(`El conteo ${idConteo} aprobado no tiene el AJUSTE del producto ${linea.id_producto}`);
    movimientos.push(movimiento);
  }
  return { conteo, movimientos, replayed: true };
}

/**
 * Relectura tras un fallo de la transacción de la aprobación (como idempotencia.resolverFallo, pero por `clave_aprobacion`, que
 * existe también cuando no hubo ningún ajuste): otra petición del mismo usuario con la misma clave pudo confirmar entre medias
 * (aquí llega como 409 CONTEO_ESTADO_INVALIDO, como el 23505 de una clave o como cualquier rechazo del motor). Si la halla, la
 * respuesta es la de repeticionDeAprobacion; si no (o si la relectura también falla), relanza el MISMO error original.
 */
async function resolverFalloDeAprobacion(db, base, idConteo, error) {
  let hallado;
  try {
    hallado = await conteoRepository.findByClaveAprobacion(db, base);
  } catch {
    throw error;
  }
  if (!hallado) throw error;
  return repeticionDeAprobacion(db, hallado, idConteo, base);
}

// Un logger roto no puede cambiar la respuesta de una aprobación ya confirmada.
function registrarFallo(logger, registro) {
  try {
    logger?.error(registro);
  } catch {
    // se ignora: registrar es secundario
  }
}

/**
 * Aprueba un conteo (POST /conteos/{id}/aprobacion). Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401. 2. Idempotency-Key: falta, vacía, más de 200 caracteres o con «#» → 400.
 * 3. {id} de la ruta inválido → 404. 4. `base = claveAlmacenada(idUsuario, OPERACIONES.CONTEO, clave)`.
 * 5. Repetición (D32(d)): si `clave_aprobacion = base` existe: de ESTE conteo → 200 con el conteo y sus movimientos originales,
 *    sin ajustes nuevos ni umbral; de OTRO → 409 CONFLICTO. 6. Conteo inexistente → 404.
 * 7. Transacción (READ COMMITTED). ORDEN DE BLOQUEO (D32(e)): fila del conteo (FOR UPDATE) → saldos de las líneas por id_producto
 *    ascendente (los toma el motor, uno por AJUSTE) → lotes (FEFO, D27). El estado se mira DESPUÉS de bloquear: no EN_REVISION →
 *    409 CONTEO_ESTADO_INVALIDO (dos aprobaciones simultáneas: una gana; con la MISMA clave, la perdedora relee y responde 200).
 *    Bodega inactiva → 409 BODEGA_INACTIVA, también sin diferencias (D12, D32(j)). Por cada línea contada con diferencia ≠ 0,
 *    un AJUSTE de esa diferencia GUARDADA (con signo, D32(a): no se recalcula contra el saldo actual) con `idConteo` y la clave
 *    derivada(base, id_producto) (D25d). Después, APROBADO con fecha, usuario y `clave_aprobacion = base` (también sin ajustes).
 *    Si algo falla (409 STOCK_INSUFICIENTE de un ajuste negativo, 422 de desborde, un 5xx) se deshace TODO: ningún ajuste, el
 *    conteo sigue EN_REVISION y la clave no se guarda (un reintento con la misma clave se vuelve a ejecutar).
 * 8. Tras confirmar, el umbral (D13) por cada producto ajustado, fuera de la transacción y dentro de try/catch: el aviso no se
 *    espera y un fallo solo se registra; nunca cambia la respuesta.
 * No llama al catálogo: los productos son los del conteo.
 * @param {{db: object, clients: {notificaciones: object}, logger: object}} deps
 * @param {{idConteo: string|number, claveIdempotencia: string|undefined, identity: object}} peticion
 * @returns {Promise<{conteo: Conteo, movimientos: Movimiento[], replayed: boolean}>} movimientos por id_producto
 */
async function aprobar(deps, { idConteo, claveIdempotencia, identity }) {
  const { db, logger } = deps;
  requireUser(identity);
  const clave = leerClaveIdempotencia(claveIdempotencia);
  const id = leerIdConteo(idConteo);
  const base = claveAlmacenada(identity.idUsuario, OPERACIONES.CONTEO, clave);

  const repetido = await conteoRepository.findByClaveAprobacion(db, base);
  if (repetido) return repeticionDeAprobacion(db, repetido, id, base);
  if (!(await conteoRepository.findById(db, id))) throw conteoNoExiste();

  let resultado;
  try {
    resultado = await db.transaction(async (trx) => {
      const conteo = await conteoRepository.bloquearPorId(trx, id); // PRIMER bloqueo; el estado se mira después
      if (conteo.estado !== 'EN_REVISION') throw estadoInvalido(`El conteo está ${conteo.estado}: solo se aprueba uno EN_REVISION`);
      const bodega = await bodegaRepository.findById(trx, conteo.id_bodega);
      if (!bodega.activa) throw e.conflicto('BODEGA_INACTIVA', 'La bodega está inactiva: no admite ajustes');
      const movimientos = [];
      for (const linea of lineasAjustables(await conteoRepository.listarDetalles(trx, id))) {
        movimientos.push(await stockService.aplicarMovimiento(trx, {
          tipo: 'AJUSTE', idProducto: linea.id_producto, idBodega: conteo.id_bodega, cantidad: linea.diferencia, idConteo: id,
          claveIdempotencia: derivada(base, linea.id_producto), idUsuario: identity.idUsuario,
        }));
      }
      const aprobado = await conteoRepository.marcarAprobado(trx, id, { idUsuarioAprueba: identity.idUsuario, claveAprobacion: base });
      if (!aprobado) throw new Error(`El conteo ${id} bloqueado y EN_REVISION no se pudo marcar como aprobado`);
      return { conteo: await conteoRepository.findById(trx, id), movimientos };
    });
  } catch (error) {
    return resolverFalloDeAprobacion(db, base, id, error);
  }

  for (const movimiento of resultado.movimientos) {
    try {
      await movimientoService.evaluarUmbral(deps, { tipo: 'AJUSTE', idProducto: movimiento.id_producto, idBodega: movimiento.id_bodega, identity });
    } catch (error) {
      registrarFallo(logger, { mensaje: 'No se pudo evaluar el umbral tras aprobar el conteo', id_conteo: id, id_producto: movimiento.id_producto, error: describirError(error) });
    }
  }
  return { ...resultado, replayed: false };
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearConteoService(deps = {}) {
  return {
    programar: (peticion) => programar(deps, peticion),
    registrarDetalles: (peticion) => registrarDetalles(deps, peticion),
    aprobar: (peticion) => aprobar(deps, peticion),
    obtener: (peticion) => obtener(deps, peticion),
    listar: (consulta) => listar(deps, consulta),
  };
}

module.exports = { MAX_LINEAS_CONTEO, programar, registrarDetalles, aprobar, obtener, listar, crearConteoService };
