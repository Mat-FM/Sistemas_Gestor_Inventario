const { e } = require('../errors');
const { cuerpoObjeto, entero, fecha, idRuta, recoger, validarCampos } = require('../http/validate');
const { requireUser, scopeBodega } = require('../middleware/identity');
const bodegaRepository = require('../repositories/bodegaRepository');
const conteoRepository = require('../repositories/conteoRepository');

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
    const lineas = await conteoRepository.insertarDetalles(trx, { idConteo, idBodega, idsProducto });
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

/** Servicio con sus dependencias fijadas, para el controlador. Las lee en cada llamada. */
function crearConteoService(deps = {}) {
  return {
    programar: (peticion) => programar(deps, peticion),
    obtener: (peticion) => obtener(deps, peticion),
    listar: (consulta) => listar(deps, consulta),
  };
}

module.exports = { programar, obtener, listar, crearConteoService };
