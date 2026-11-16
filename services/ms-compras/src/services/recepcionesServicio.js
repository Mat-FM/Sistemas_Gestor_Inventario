// Recepción total o parcial de una orden de compra (RF06) — Entrega 2, sección 4.8.
//
// Por cada línea recibida se registra un movimiento ENTRADA_COMPRA en ms-inventario (llamada 2) y
// solo cuando inventario responde se guarda la recepción. Si una línea falla, las demás siguen y la
// respuesta indica cuáles faltan; al reintentar con la misma Idempotency-Key, las líneas ya
// registradas no se repiten ni aquí ni en inventario (RNF17).
const { pool, enTransaccion } = require('../config/db');
const { ApiError } = require('../errores');
const { Validador } = require('../validacion');
const repo = require('../repositories/ordenesRepositorio');
const idempotencia = require('../repositories/idempotenciaRepositorio');
const inventario = require('../clients/inventarioCliente');
const notificaciones = require('../clients/notificacionesCliente');
const { verificarBodega } = require('../middleware/contexto');

const OPERACION = 'recepcion';
const ESTADOS_RECIBIBLES = ['ENVIADA', 'RECIBIDA_PARCIAL'];

const presente = (valor) => valor !== undefined && valor !== null && !(typeof valor === 'string' && valor.trim() === '');

function validarLineas(cuerpo) {
  const v = new Validador();
  const lista = v.lista(cuerpo?.lineas, 'lineas');
  const vistos = new Set();
  const lineas = lista.map((linea, i) => {
    const campo = (c) => `lineas[${i}].${c}`;
    const l = linea && typeof linea === 'object' ? linea : {};
    const idDetalle = v.enteroPositivo(l.id_detalle, campo('id_detalle'));
    if (idDetalle !== undefined) {
      if (vistos.has(idDetalle)) v.error(campo('id_detalle'), 'La línea está repetida en la recepción.');
      vistos.add(idDetalle);
    }
    const codigoLote = v.texto(l.codigo_lote, campo('codigo_lote'), { opcional: true, max: 50 });
    const fechaVencimiento = v.fecha(l.fecha_vencimiento, campo('fecha_vencimiento'), { opcional: true });
    // ms-inventario exige la fecha de vencimiento siempre que llega un lote: un texto vacío cuenta como ausente,
    // para que un lote nunca viaje sin su fecha.
    const traeLote = presente(l.codigo_lote);
    const traeFecha = presente(l.fecha_vencimiento);
    if (traeLote !== traeFecha) {
      v.error(campo('codigo_lote'), 'El código de lote y la fecha de vencimiento van juntos.');
    }
    return { idDetalle, cantidad: v.enteroPositivo(l.cantidad, campo('cantidad')), codigoLote, fechaVencimiento };
  });
  v.verificar();
  return lineas;
}

function estadoSegunDetalles(detalles) {
  if (detalles.every((d) => d.cantidad_recibida >= d.cantidad_pedida)) return 'RECIBIDA';
  if (detalles.some((d) => d.cantidad_recibida > 0)) return 'RECIBIDA_PARCIAL';
  return 'ENVIADA';
}

// Bloqueo por orden durante toda la recepción, para que dos recepciones simultáneas de la misma
// orden no superen la cantidad pendiente. Se usa un candado de PostgreSQL ligado a la conexión.
// TODAS las consultas de la recepción usan esa misma conexión: si pidieran otra al pool mientras otras
// recepciones esperan el candado ocupando conexiones, el pool se agotaría y nadie podría avanzar.
async function conBloqueoDeOrden(idOrden, fn) {
  const conexion = await pool.connect();
  let bloqueada = false;
  try {
    await repo.tomarCandadoOrden(conexion, idOrden);
    bloqueada = true;
    return await fn(conexion);
  } finally {
    if (bloqueada) await repo.liberarCandadoOrden(conexion, idOrden).catch(() => {});
    conexion.release();
  }
}

async function recibir(idOrden, cuerpo, { usuario, clave, requestId }) {
  const guardada = await idempotencia.buscar(clave, `${OPERACION}:${idOrden}`);
  if (guardada) return { status: guardada.codigo_http, cuerpo: guardada.respuesta };

  const lineas = validarLineas(cuerpo);

  return conBloqueoDeOrden(idOrden, async (con) => {
    const orden = await repo.obtener(idOrden, con);
    if (!orden) throw ApiError.noEncontrado(`No existe la orden de compra ${idOrden}.`, 'ORDEN_NO_ENCONTRADA');
    verificarBodega(usuario, orden.id_bodega_destino);

    const detalles = await repo.detalles(idOrden, con);
    const porId = new Map(detalles.map((d) => [d.id_detalle, d]));

    // Líneas que ya quedaron registradas con esta misma clave en un intento anterior.
    const yaRegistradas = new Map();
    for (const linea of lineas) {
      if (porId.has(linea.idDetalle)) {
        const previa = await repo.recepcionPorClave(con, clave, linea.idDetalle);
        if (previa) yaRegistradas.set(linea.idDetalle, previa);
      }
    }

    if (!ESTADOS_RECIBIBLES.includes(orden.estado) && yaRegistradas.size === 0) {
      throw ApiError.conflicto('ESTADO_NO_RECIBIBLE', `La orden está ${orden.estado}; solo se recibe si está ENVIADA o RECIBIDA_PARCIAL.`);
    }

    const errores = [];
    for (const [i, linea] of lineas.entries()) {
      const detalle = porId.get(linea.idDetalle);
      if (!detalle) {
        errores.push({ campo: `lineas[${i}].id_detalle`, mensaje: `La línea ${linea.idDetalle} no pertenece a la orden.` });
      } else if (!yaRegistradas.has(linea.idDetalle)) {
        const pendiente = detalle.cantidad_pedida - detalle.cantidad_recibida;
        if (linea.cantidad > pendiente) {
          errores.push({ campo: `lineas[${i}].cantidad`, mensaje: `Supera la cantidad pendiente (${pendiente}).` });
        }
      }
    }
    if (errores.length) throw ApiError.datosInvalidos(errores);

    const registradas = [];
    const fallidas = [];
    for (const linea of lineas) {
      if (yaRegistradas.has(linea.idDetalle)) continue;
      const detalle = porId.get(linea.idDetalle);
      try {
        const movimiento = await inventario.registrarMovimiento(
          {
            tipo: 'ENTRADA_COMPRA',
            id_producto: detalle.id_producto,
            id_bodega: orden.id_bodega_destino,
            cantidad: linea.cantidad,
            ...(linea.codigoLote ? { lote: { codigo_lote: linea.codigoLote, fecha_vencimiento: linea.fechaVencimiento } } : {}),
            documento_referencia: orden.numero,
          },
          { claveIdempotencia: `ms-compras:recepcion:${clave}:${linea.idDetalle}`, usuario, requestId },
        );
        await enTransaccion(
          (db) => repo.registrarRecepcion(db, { ...linea, idUsuario: usuario.id, idMovimiento: movimiento.id_movimiento, clave }),
          con,
        );
        registradas.push(linea.idDetalle);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        fallidas.push({ id_detalle: linea.idDetalle, error });
      }
    }

    // El estado de la orden se calcula con lo que realmente quedó recibido.
    const estado = estadoSegunDetalles(await repo.detalles(idOrden, con));
    if (estado !== orden.estado) {
      await enTransaccion((db) => repo.cambiarEstado(db, idOrden, estado), con);
    }

    if (registradas.length > 0) {
      notificaciones.avisar(
        {
          tipo: 'ORDEN_RECIBIDA',
          mensaje:
            estado === 'RECIBIDA'
              ? `La orden ${orden.numero} se recibió completa.`
              : `La orden ${orden.numero} se recibió parcialmente.`,
          id_bodega: orden.id_bodega_destino,
          rol_destinatario: 'ADMINISTRADOR',
        },
        { requestId },
      );
    }

    if (fallidas.length > 0) {
      const primero = fallidas[0].error;
      throw new ApiError(
        primero.status,
        primero.codigo,
        registradas.length + yaRegistradas.size > 0
          ? 'Algunas líneas no se pudieron registrar. Reintente con la misma Idempotency-Key para completar las faltantes.'
          : primero.message,
        fallidas.map((f) => ({ id_detalle: f.id_detalle, codigo: f.error.codigo, mensaje: f.error.message })),
      );
    }

    const respuesta = await repo.obtener(idOrden, con);
    const resultado = {
      id_orden: respuesta.id_orden,
      numero: respuesta.numero,
      estado: respuesta.estado,
      recepciones: await repo.recepcionesPorClave(idOrden, clave, con),
    };
    await idempotencia.guardar(clave, `${OPERACION}:${idOrden}`, 201, resultado, con);
    return { status: 201, cuerpo: resultado };
  });
}

module.exports = { recibir, estadoSegunDetalles };
