// Traduce las peticiones HTTP a llamadas de los servicios y da forma a las respuestas.
const { ApiError } = require('../errores');
const { Validador, enteroDeConsulta, paginacion, esFechaValida } = require('../validacion');
const ordenes = require('../services/ordenesServicio');
const recepciones = require('../services/recepcionesServicio');
const devoluciones = require('../services/devolucionesServicio');

const ESTADOS = ['CREADA', 'ENVIADA', 'RECIBIDA_PARCIAL', 'RECIBIDA', 'ANULADA'];

function idDeRuta(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.noEncontrado('El identificador no es válido.', 'ORDEN_NO_ENCONTRADA');
  return id;
}

// Las operaciones que crean movimientos exigen la cabecera Idempotency-Key (RNF17).
function claveIdempotencia(req) {
  const clave = req.get('Idempotency-Key');
  if (!clave || clave.trim() === '') {
    throw ApiError.peticionInvalida('Falta la cabecera Idempotency-Key.', [{ campo: 'Idempotency-Key', mensaje: 'Es obligatoria.' }]);
  }
  if (clave.length > 80) {
    throw ApiError.peticionInvalida('La cabecera Idempotency-Key no puede tener más de 80 caracteres.');
  }
  return clave.trim();
}

function fechasDeConsulta(v, query) {
  const fechaDesde = query.fecha_desde || undefined;
  const fechaHasta = query.fecha_hasta || undefined;
  if (fechaDesde && !esFechaValida(fechaDesde)) v.error('fecha_desde', 'Debe tener el formato AAAA-MM-DD.');
  if (fechaHasta && !esFechaValida(fechaHasta)) v.error('fecha_hasta', 'Debe tener el formato AAAA-MM-DD.');
  if (fechaDesde && fechaHasta && fechaDesde > fechaHasta) v.error('fecha_desde', 'No puede ser posterior a fecha_hasta.');
  return { fechaDesde, fechaHasta };
}

function listado({ filas, total }, { pagina, porPagina }) {
  return { datos: filas, meta: { pagina, por_pagina: porPagina, total } };
}

async function listarOrdenes(req, res) {
  const v = new Validador();
  const estado = req.query.estado || undefined;
  if (estado && !ESTADOS.includes(estado)) v.error('estado', `Debe ser uno de: ${ESTADOS.join(', ')}.`);
  const filtros = {
    estado,
    idProveedor: enteroDeConsulta(v, req.query.id_proveedor, 'id_proveedor'),
    idBodegaDestino: enteroDeConsulta(v, req.query.id_bodega_destino, 'id_bodega_destino'),
    ...fechasDeConsulta(v, req.query),
  };
  const pag = paginacion(v, req.query);
  v.verificar();
  res.json(listado(await ordenes.listar(filtros, pag), pag));
}

async function obtenerOrden(req, res) {
  res.json(await ordenes.obtenerCompleta(idDeRuta(req)));
}

async function crearOrden(req, res) {
  res.status(201).json(await ordenes.crear(req.body, req.contexto.usuario));
}

async function actualizarOrden(req, res) {
  res.json(await ordenes.actualizar(idDeRuta(req), req.body));
}

async function cambiarEstado(req, res) {
  res.json(await ordenes.cambiarEstado(idDeRuta(req), req.body));
}

async function recibir(req, res) {
  const resultado = await recepciones.recibir(idDeRuta(req), req.body, {
    usuario: req.contexto.usuario,
    clave: claveIdempotencia(req),
    requestId: req.contexto.requestId,
  });
  res.status(resultado.status).json(resultado.cuerpo);
}

async function listarRecepciones(req, res) {
  res.json({ datos: await ordenes.listarRecepciones(idDeRuta(req)) });
}

async function crearDevolucion(req, res) {
  const resultado = await devoluciones.crear(req.body, {
    usuario: req.contexto.usuario,
    clave: claveIdempotencia(req),
    requestId: req.contexto.requestId,
  });
  res.status(resultado.status).json(resultado.cuerpo);
}

async function listarDevoluciones(req, res) {
  const v = new Validador();
  const filtros = {
    idProveedor: enteroDeConsulta(v, req.query.id_proveedor, 'id_proveedor'),
    ...fechasDeConsulta(v, req.query),
  };
  const pag = paginacion(v, req.query);
  v.verificar();
  res.json(listado(await devoluciones.listar(filtros, pag), pag));
}

module.exports = {
  listarOrdenes,
  obtenerOrden,
  crearOrden,
  actualizarOrden,
  cambiarEstado,
  recibir,
  listarRecepciones,
  crearDevolucion,
  listarDevoluciones,
};
