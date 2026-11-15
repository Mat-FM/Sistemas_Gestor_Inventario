// Simulador de ms-inventario y ms-notificaciones para desarrollar y probar ms-compras mientras esos
// servicios no existen. Implementa solo lo que ms-compras usa, con el mismo contrato:
//   POST /movimientos                (ms-inventario: ENTRADA_COMPRA y DEVOLUCION_PROVEEDOR, con Idempotency-Key)
//   GET  /saldos?id_producto&id_bodega (para ver el efecto de las recepciones)
//   POST /internas/notificaciones     (ms-notificaciones: aviso ORDEN_RECIBIDA)
//   GET  /internas/notificaciones     (para ver los avisos recibidos)
// No usa dependencias: corre con `node dev/simulador-servicios.js`. Puerto: SIMULADOR_PORT (3001).
// NO es parte del sistema: se borra cuando ms-inventario y ms-notificaciones estén listos.
const http = require('node:http');

function crearSimulador() {
  let siguienteMovimiento = 1;
  const saldos = new Map(); // "producto:bodega" -> cantidad
  const porClave = new Map(); // Idempotency-Key -> movimiento
  const avisos = [];

  function responder(res, status, cuerpo) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cuerpo));
  }

  const servidor = http.createServer((req, res) => {
    let texto = '';
    req.on('data', (parte) => {
      texto += parte;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://simulador');
      let cuerpo = {};
      try {
        cuerpo = texto ? JSON.parse(texto) : {};
      } catch {
        return responder(res, 400, { error: { codigo: 'PETICION_INVALIDA', mensaje: 'JSON inválido', detalles: [] } });
      }

      if (req.method === 'GET' && url.pathname === '/health') return responder(res, 200, { estado: 'ok', servicio: 'simulador' });

      if (req.method === 'POST' && url.pathname === '/movimientos') {
        const clave = req.headers['idempotency-key'];
        if (!clave) return responder(res, 400, { error: { codigo: 'PETICION_INVALIDA', mensaje: 'Falta Idempotency-Key', detalles: [] } });
        if (porClave.has(clave)) return responder(res, 200, porClave.get(clave));

        const { tipo, id_producto: idProducto, id_bodega: idBodega, cantidad } = cuerpo;
        if (!['ENTRADA_COMPRA', 'DEVOLUCION_PROVEEDOR'].includes(tipo) || !Number.isInteger(cantidad) || cantidad <= 0) {
          return responder(res, 422, { error: { codigo: 'DATOS_INVALIDOS', mensaje: 'Movimiento no válido', detalles: [] } });
        }
        const llave = `${idProducto}:${idBodega}`;
        const saldo = saldos.get(llave) || 0;
        if (tipo === 'DEVOLUCION_PROVEEDOR' && saldo < cantidad) {
          return responder(res, 409, {
            error: { codigo: 'STOCK_INSUFICIENTE', mensaje: `Solo hay ${saldo} unidades en la bodega.`, detalles: [] },
          });
        }
        const nuevoSaldo = tipo === 'ENTRADA_COMPRA' ? saldo + cantidad : saldo - cantidad;
        saldos.set(llave, nuevoSaldo);
        const movimiento = {
          id_movimiento: siguienteMovimiento++,
          tipo,
          id_producto: idProducto,
          id_bodega: idBodega,
          cantidad,
          saldo_resultante: nuevoSaldo,
          id_usuario: Number(req.headers['x-user-id']) || null,
          documento_referencia: cuerpo.documento_referencia ?? null,
          fecha: new Date().toISOString(),
        };
        porClave.set(clave, movimiento);
        return responder(res, 201, movimiento);
      }

      if (req.method === 'GET' && url.pathname === '/saldos') {
        const datos = [...saldos.entries()].map(([llave, cantidad]) => {
          const [idProducto, idBodega] = llave.split(':').map(Number);
          return { id_producto: idProducto, id_bodega: idBodega, cantidad_disponible: cantidad };
        });
        return responder(res, 200, { datos });
      }

      if (url.pathname === '/internas/notificaciones') {
        if (req.method === 'POST') {
          avisos.push({ ...cuerpo, recibido: new Date().toISOString() });
          return responder(res, 202, { aceptada: true });
        }
        if (req.method === 'GET') return responder(res, 200, { datos: avisos });
      }

      return responder(res, 404, { error: { codigo: 'RUTA_NO_ENCONTRADA', mensaje: url.pathname, detalles: [] } });
    });
  });

  return { servidor, saldos, avisos, porClave };
}

module.exports = { crearSimulador };

if (require.main === module) {
  const puerto = Number(process.env.SIMULADOR_PORT || 3001);
  crearSimulador().servidor.listen(puerto, () => {
    console.log(`Simulador de ms-inventario y ms-notificaciones escuchando en el puerto ${puerto}`);
  });
}
