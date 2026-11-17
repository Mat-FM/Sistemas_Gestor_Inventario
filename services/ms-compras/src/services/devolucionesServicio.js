// Devoluciones a proveedor (RF13) — Entrega 2, sección 4.8.
// Primero se registra la salida DEVOLUCION_PROVEEDOR en ms-inventario (llamada 2) y, cuando
// inventario responde, se guarda la devolución con el identificador del movimiento.
const { ApiError } = require('../errores');
const { Validador } = require('../validacion');
const repo = require('../repositories/devolucionesRepositorio');
const ordenes = require('../repositories/ordenesRepositorio');
const inventario = require('../clients/inventarioCliente');
const { verificarBodega } = require('../middleware/contexto');

function validar(cuerpo) {
  const v = new Validador();
  const d = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const datos = {
    idProveedor: v.enteroPositivo(d.id_proveedor, 'id_proveedor'),
    idProducto: v.enteroPositivo(d.id_producto, 'id_producto'),
    idBodega: v.enteroPositivo(d.id_bodega, 'id_bodega'),
    cantidad: v.enteroPositivo(d.cantidad, 'cantidad'),
    motivo: v.texto(d.motivo, 'motivo'),
    idOrden: v.enteroPositivo(d.id_orden, 'id_orden', { opcional: true }),
    idLote: v.enteroPositivo(d.id_lote, 'id_lote', { opcional: true }),
  };
  v.verificar();
  return datos;
}

async function crear(cuerpo, { usuario, clave, requestId }) {
  // Si la misma petición ya se procesó, se devuelve la devolución original (RNF17).
  const previa = await repo.porClave(clave);
  if (previa) return { status: 201, cuerpo: previa };

  const datos = validar(cuerpo);
  verificarBodega(usuario, datos.idBodega);

  let orden = null;
  if (datos.idOrden) {
    orden = await ordenes.obtener(datos.idOrden);
    if (!orden) throw ApiError.noEncontrado(`No existe la orden de compra ${datos.idOrden}.`, 'ORDEN_NO_ENCONTRADA');
    if (orden.id_proveedor !== datos.idProveedor) {
      throw ApiError.datosInvalidos([{ campo: 'id_orden', mensaje: 'La orden pertenece a otro proveedor.' }]);
    }
  }

  const movimiento = await inventario.registrarMovimiento(
    {
      tipo: 'DEVOLUCION_PROVEEDOR',
      id_producto: datos.idProducto,
      id_bodega: datos.idBodega,
      cantidad: datos.cantidad,
      ...(datos.idLote ? { id_lote: datos.idLote } : {}),
      documento_referencia: orden ? orden.numero : `DEV-PROV-${datos.idProveedor}`,
      observacion: datos.motivo,
    },
    { claveIdempotencia: `ms-compras:devolucion:${clave}`, usuario, requestId },
  );

  const devolucion = await repo.crear({ ...datos, idUsuario: usuario.id, idMovimiento: movimiento.id_movimiento, clave });
  return { status: 201, cuerpo: devolucion };
}

async function listar(filtros, paginacion) {
  return repo.listar(filtros, paginacion);
}

module.exports = { crear, listar };
