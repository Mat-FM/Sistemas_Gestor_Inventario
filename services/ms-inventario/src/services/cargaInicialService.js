const { AppError, e } = require('../errors');
const { entero, fecha, texto, validarCampos } = require('../http/validate');
const { requireUser } = require('../middleware/identity');
const movimientoRepository = require('../repositories/movimientoRepository');
const { OPERACIONES, claveAlmacenada, derivada, leerClaveIdempotencia } = require('./idempotencia');
const stockService = require('./stockService');

// Lógica de negocio de la carga inicial de saldos (RF16, D34; RNF13): POST /internas/saldos/carga-inicial, que solo llama
// ms-reportes al importar el inventario de arranque desde un archivo. Cada fila válida crea un movimiento CARGA_INICIAL con el
// motor de movimientos (stockService.aplicarMovimiento); las filas inválidas se devuelven en `rechazados` y no abortan la carga.
// No sabe nada de HTTP: recibe las filas, el valor de la cabecera Idempotency-Key y la identidad como datos. El SQL vive en el
// repositorio. Las dependencias llegan en `deps` = { db } (el logger y los clientes no se usan) y se leen en cada llamada.
//
// Diseño (D34):
// - UNA TRANSACCIÓN POR FILA, en el orden de la lista (éxito parcial): el resultado de una fila no depende de las demás y una
//   carga de 1 000 filas no mantiene bloqueados 1 000 saldos a la vez. Cada transacción toma UN solo saldo (y sus lotes), así
//   que no hay ciclo de bloqueos posible entre filas ni entre cargas (a diferencia de la aprobación de un conteo).
// - IDEMPOTENCIA POR FILA (RNF17): la fila `n` (base 1) lleva la clave derivada(base, n), con
//   base = claveAlmacenada(idUsuario, OPERACIONES.CARGA_INICIAL, clave) (D5, D25b, D25d). ms-reportes espera 3 s por intento y
//   REINTENTA hasta 4 veces con la MISMA clave, y el servidor sigue trabajando aunque el cliente se desconecte: un reintento
//   puede SOLAPARSE con la primera ejecución. Dos defensas, y ninguna depende del tiempo:
//     1) antes de procesar, UNA consulta (clavesExistentes) dice cuáles de las claves de fila ya existen: esas filas ya están
//        aplicadas, cuentan como `creados` y no se tocan ni se vuelven a validar;
//     2) si una fila falla, ANTES de clasificar el error se relee su clave con movimientoRepository.findByClave (fuera de la
//        transacción ya deshecha; no con resolverFallo, que ante un fallo de la relectura relanza el error ORIGINAL): si otra
//        petición la aplicó entre medias (el 23505 de la clave, o cualquier rechazo del motor que dependa de lo que esa petición
//        escribió, p. ej. un desborde porque ya sumó), la fila cuenta como `creados`. Solo si la relectura SE HIZO y no hay
//        movimiento se decide: un AppError 4xx es un rechazo de la fila; cualquier otro error se propaga (500). Si la propia
//        relectura falla (se corta la conexión), se propaga ESE error (500 y el llamador reintenta con la misma clave sin
//        duplicar nada, porque lo ya aplicado se reconoce por (1)): nunca se clasifica el error original cuando no se pudo
//        comprobar si la fila existe, porque informar como «rechazada» una fila que sí se creó es un dato falso (Ruling 61).
//   Una clave (usuario, operación, clave) identifica CADA FILA por su posición: la repetición con la misma clave no vuelve a
//   leer el cuerpo de las filas ya aplicadas (D7).
// - No consulta ms-catalogo (llamador interno de confianza: mil llamadas HTTP por carga serían inviables con el plazo de 3 s de
//   ms-reportes) y no evalúa el umbral (D13: CARGA_INICIAL solo suma).

/**
 * Máximo de filas de una carga (D34(c)). Cada fila es una transacción: una carga enorme tendría al llamador esperando minutos y,
 * con el cuerpo de 1 MB, cabrían unas 9 000. Más de esto se envía por partes (ms-reportes debe trocear la importación).
 */
const MAX_FILAS_CARGA_INICIAL = 1000;

const ausente = (valor) => valor === undefined || valor === null;

/** 422 sobre `filas`. Lo mira ANTES que cada elemento: una lista enorme no cuesta nada. */
function comprobarFilas(filas) {
  if (!Array.isArray(filas) || filas.length === 0) {
    throw e.datosNoValidos([{ campo: 'filas', mensaje: 'debe ser una lista no vacía de { id_producto, id_bodega, cantidad, codigo_lote?, fecha_vencimiento? }' }]);
  }
  if (filas.length > MAX_FILAS_CARGA_INICIAL) {
    throw e.datosNoValidos([{ campo: 'filas', mensaje: `una carga admite como máximo ${MAX_FILAS_CARGA_INICIAL} filas: envíela por partes` }]);
  }
}

/** Texto corto y legible de un 422 de los validadores: «campo: mensaje; campo: mensaje». Nunca un mensaje de PostgreSQL. */
const motivoDeDetalles = (detalles) => detalles.map(({ campo, mensaje }) => `${campo}: ${mensaje}`).join('; ');

/**
 * Valida una fila (D34(b)). Devuelve { datos } con lo que recibe el motor, o { motivo } si la fila se rechaza (nunca lanza un
 * error de validación: una fila mala no aborta la carga). Informa todos los campos inválidos de la fila a la vez.
 * - Una fila que no es un objeto (ni un arreglo) se rechaza.
 * - id_producto, id_bodega y cantidad: enteros ≥ 1 dentro del INTEGER (0, negativos, decimales, texto, null y ausentes se rechazan).
 * - codigo_lote: opcional (null o ausente = sin lote); si viene, texto recortado de 1 a 50 caracteres (el largo de la columna).
 * - fecha_vencimiento: opcional; si viene, una fecha real YYYY-MM-DD, y solo junto con codigo_lote (la fecha es del lote).
 * Lo que los validadores aceptan nunca hace lanzar un TypeError al motor (código sin recortar o con NUL, fecha imposible): un
 * TypeError convertiría en 500 toda la carga por una sola fila mala.
 */
function leerFila(fila) {
  if (typeof fila !== 'object' || fila === null || Array.isArray(fila)) {
    return { motivo: 'La fila debe ser un objeto con id_producto, id_bodega y cantidad' };
  }
  try {
    return {
      datos: validarCampos({
        idProducto: () => entero(fila.id_producto, 'id_producto'),
        idBodega: () => entero(fila.id_bodega, 'id_bodega'),
        cantidad: () => entero(fila.cantidad, 'cantidad'),
        codigoLote: () => (ausente(fila.codigo_lote) ? null : texto(fila.codigo_lote, 'codigo_lote', { max: stockService.LARGO_CODIGO_LOTE })),
        fechaVencimiento: () => {
          if (ausente(fila.fecha_vencimiento)) return null;
          const dia = fecha(fila.fecha_vencimiento, 'fecha_vencimiento');
          if (ausente(fila.codigo_lote)) throw e.datosNoValidos([{ campo: 'fecha_vencimiento', mensaje: 'solo se admite junto con codigo_lote (es la fecha del lote)' }]);
          return dia;
        },
      }),
    };
  } catch (error) {
    if (error instanceof AppError && error.codigo === 'DATOS_NO_VALIDOS') return { motivo: motivoDeDetalles(error.detalles) };
    throw error;
  }
}

/** ¿Un rechazo de negocio del motor (404, 409, 422…)? Es lo único que vuelve una fila rechazada; el resto de los errores se propaga. */
const esRechazoDeNegocio = (error) => error instanceof AppError && error.status >= 400 && error.status < 500;

/**
 * Motivo de un rechazo de negocio del motor, en palabras del servicio: el detalle si lo trae (p. ej. «El lote ya existe con fecha
 * de vencimiento 2027-01-31») o el mensaje («La bodega no existe»). Un 422 del motor (desborde) se lee como los de la fila.
 */
function motivoDelMotor(error) {
  if (error.codigo === 'DATOS_NO_VALIDOS') return motivoDeDetalles(error.detalles);
  return error.detalles.length > 0 ? error.detalles.map(({ mensaje }) => mensaje).join('; ') : error.message;
}

/**
 * Aplica una fila válida en SU transacción. Dentro del callback solo se usa `trx` (con un pool pequeño, una conexión más ocupada
 * por la misma petición la dejaría sin conexiones). Lo llama por el objeto del módulo (stockService.aplicarMovimiento): las
 * pruebas lo sustituyen.
 * Si la transacción falla, se relee la clave de la fila ANTES de clasificar el error (ver la cabecera del módulo, defensa 2).
 * @returns {Promise<{motivo?: string}>} `{}` si la fila quedó aplicada (por esta petición o por otra con la misma clave);
 *   `{ motivo }` si se rechaza (un AppError 4xx del motor y NO hay movimiento con la clave). Cualquier otro error se propaga; si
 *   falla la relectura de la clave, se propaga el error de la relectura y no el original.
 */
async function aplicarFila(db, { datos, clave, idUsuario }) {
  try {
    await db.transaction((trx) => stockService.aplicarMovimiento(trx, {
      tipo: 'CARGA_INICIAL',
      idProducto: datos.idProducto,
      idBodega: datos.idBodega,
      cantidad: datos.cantidad,
      lote: datos.codigoLote === null ? null : { codigoLote: datos.codigoLote, fechaVencimiento: datos.fechaVencimiento },
      claveIdempotencia: clave,
      idUsuario,
    }));
    return {};
  } catch (error) {
    // La transacción ya se deshizo. ¿La aplicó otra petición con la misma clave (un reintento solapado)? Se relee ANTES de
    // clasificar: si hay movimiento, la fila cuenta como creada, sea cual sea el error que vio ésta. Si la relectura falla, su
    // error se propaga tal cual: sin saber si la fila existe, no se puede decir que se rechazó.
    if (await movimientoRepository.findByClave(db, clave)) return {};
    if (esRechazoDeNegocio(error)) return { motivo: motivoDelMotor(error) };
    throw error;
  }
}

/**
 * Carga inicial de saldos (POST /internas/saldos/carga-inicial). Orden (cada paso decide antes que el siguiente):
 * 1. requireUser: sin X-User-Id → 401 (D8, D22; `identity` ya rechaza X-User-Id sin X-User-Rol con 401).
 * 2. Idempotency-Key: falta, vacía, más de 200 caracteres o con «#» → 400.
 * 3. `filas`: una lista NO vacía de como máximo MAX_FILAS_CARGA_INICIAL (1 000) elementos → si no, 422 sobre `filas` sin tocar
 *    la base.
 * 4. Una consulta busca cuáles de las claves de fila ya existen (clavesExistentes): esas filas cuentan como `creados` sin tocar
 *    nada y sin re-validarse. Las demás se procesan EN ORDEN, cada una en su transacción (aplicarFila): fila inválida o rechazada
 *    por el motor → `rechazados`; el resto, `creados`. Un error que no es de negocio (la base cae a mitad) se propaga: 500
 *    genérico, las filas anteriores YA están aplicadas y la repetición con la misma clave las cuenta y completa el resto.
 * @param {{db: object}} deps
 * @param {{filas: unknown, claveIdempotencia: string|undefined, identity: object}} peticion `filas` sin validar
 * @returns {Promise<{creados: number, rechazados: Array<{fila: number, motivo: string}>}>} `fila` es la posición en `filas`
 *   (base 1) y `rechazados` va ordenado por `fila`. Siempre es un resultado si la petición está bien formada, aunque todas las
 *   filas se rechacen (`creados: 0`).
 */
async function cargar({ db }, { filas, claveIdempotencia, identity }) {
  requireUser(identity);
  const clave = leerClaveIdempotencia(claveIdempotencia);
  comprobarFilas(filas);
  const base = claveAlmacenada(identity.idUsuario, OPERACIONES.CARGA_INICIAL, clave);
  const claves = filas.map((_fila, posicion) => derivada(base, posicion + 1));
  const yaAplicadas = await movimientoRepository.clavesExistentes(db, claves);

  let creados = 0;
  const rechazados = [];
  for (let posicion = 0; posicion < filas.length; posicion += 1) {
    const fila = posicion + 1;
    if (yaAplicadas.has(claves[posicion])) {
      creados += 1;
    } else {
      const lectura = leerFila(filas[posicion]);
      const resultado = lectura.motivo === undefined
        ? await aplicarFila(db, { datos: lectura.datos, clave: claves[posicion], idUsuario: identity.idUsuario })
        : lectura;
      if (resultado.motivo === undefined) creados += 1;
      else rechazados.push({ fila, motivo: resultado.motivo });
    }
  }
  return { creados, rechazados };
}

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearCargaInicialService(deps = {}) {
  return { cargar: (peticion) => cargar(deps, peticion) };
}

module.exports = { MAX_FILAS_CARGA_INICIAL, cargar, crearCargaInicialService };
