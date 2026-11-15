// Reglas de negocio de las órdenes de compra (RF06): creación, edición y cambios de estado.
const { enTransaccion } = require('../config/db');
const { ApiError } = require('../errores');
const { Validador } = require('../validacion');
const repo = require('../repositories/ordenesRepositorio');

// Cambios de estado que el usuario puede pedir con PATCH /estado (Entrega 2, sección 4.8).
// RECIBIDA_PARCIAL y RECIBIDA no se piden: se asignan solos con cada recepción.
const TRANSICIONES_MANUALES = {
  CREADA: ['ENVIADA', 'ANULADA'],
  ENVIADA: ['ANULADA'], // solo si todavía no tiene recepciones
};

function validarOrden(cuerpo) {
  const v = new Validador();
  const datos = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const idProveedor = v.enteroPositivo(datos.id_proveedor, 'id_proveedor');
  const idBodegaDestino = v.enteroPositivo(datos.id_bodega_destino, 'id_bodega_destino');
  const fechaEsperada = v.fecha(datos.fecha_esperada, 'fecha_esperada');
  const lista = v.lista(datos.detalles, 'detalles');

  const productos = new Set();
  const lineas = lista.map((linea, i) => {
    const campo = (c) => `detalles[${i}].${c}`;
    const l = linea && typeof linea === 'object' ? linea : {};
    const idProducto = v.enteroPositivo(l.id_producto, campo('id_producto'));
    if (idProducto !== undefined) {
      if (productos.has(idProducto)) v.error(campo('id_producto'), 'El producto está repetido en la orden.');
      productos.add(idProducto);
    }
    return {
      idProducto,
      cantidadPedida: v.enteroPositivo(l.cantidad_pedida, campo('cantidad_pedida')),
      precioUnitario: v.numeroNoNegativo(l.precio_unitario, campo('precio_unitario')),
    };
  });
  v.verificar();
  return { idProveedor, idBodegaDestino, fechaEsperada, lineas };
}

async function obtenerCompleta(idOrden, db) {
  const orden = await repo.obtener(idOrden, db);
  if (!orden) throw ApiError.noEncontrado(`No existe la orden de compra ${idOrden}.`, 'ORDEN_NO_ENCONTRADA');
  const [detalles, recepciones] = await Promise.all([repo.detalles(idOrden, db), repo.recepciones(idOrden, db)]);
  return { ...orden, detalles, recepciones };
}

async function listar(filtros, paginacion) {
  return repo.listar(filtros, paginacion);
}

async function crear(cuerpo, usuario) {
  const datos = validarOrden(cuerpo);
  const idOrden = await enTransaccion((db) => repo.crear(db, { ...datos, idUsuario: usuario.id }));
  return obtenerCompleta(idOrden);
}

async function actualizar(idOrden, cuerpo) {
  const datos = validarOrden(cuerpo);
  await enTransaccion(async (db) => {
    const orden = await repo.obtener(idOrden, db, { bloquear: true });
    if (!orden) throw ApiError.noEncontrado(`No existe la orden de compra ${idOrden}.`, 'ORDEN_NO_ENCONTRADA');
    if (orden.estado !== 'CREADA') {
      throw ApiError.conflicto('ESTADO_NO_EDITABLE', `La orden está ${orden.estado}; solo se edita en estado CREADA.`);
    }
    await repo.reemplazar(db, idOrden, datos);
  });
  return obtenerCompleta(idOrden);
}

async function cambiarEstado(idOrden, cuerpo) {
  const nuevo = cuerpo?.estado;
  if (!['ENVIADA', 'ANULADA'].includes(nuevo)) {
    throw ApiError.datosInvalidos([{ campo: 'estado', mensaje: 'Debe ser ENVIADA o ANULADA.' }]);
  }
  await enTransaccion(async (db) => {
    const orden = await repo.obtener(idOrden, db, { bloquear: true });
    if (!orden) throw ApiError.noEncontrado(`No existe la orden de compra ${idOrden}.`, 'ORDEN_NO_ENCONTRADA');
    const permitidos = TRANSICIONES_MANUALES[orden.estado] || [];
    if (!permitidos.includes(nuevo)) {
      throw ApiError.conflicto('TRANSICION_INVALIDA', `No se puede pasar de ${orden.estado} a ${nuevo}.`);
    }
    if (orden.estado === 'ENVIADA' && nuevo === 'ANULADA') {
      const detalles = await repo.detalles(idOrden, db);
      if (detalles.some((d) => d.cantidad_recibida > 0)) {
        throw ApiError.conflicto('TRANSICION_INVALIDA', 'La orden ya tiene recepciones; no se puede anular.');
      }
    }
    await repo.cambiarEstado(db, idOrden, nuevo);
  });
  return obtenerCompleta(idOrden);
}

async function listarRecepciones(idOrden) {
  const orden = await repo.obtener(idOrden);
  if (!orden) throw ApiError.noEncontrado(`No existe la orden de compra ${idOrden}.`, 'ORDEN_NO_ENCONTRADA');
  return repo.recepciones(idOrden);
}

module.exports = { listar, crear, actualizar, cambiarEstado, obtenerCompleta, listarRecepciones, validarOrden };
