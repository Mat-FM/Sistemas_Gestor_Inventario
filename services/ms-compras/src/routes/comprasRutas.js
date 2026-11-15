// Rutas internas de ms-compras (Entrega 2, Tabla 10). El Gateway las publica con el prefijo /api y
// ya comprobó los roles de cada una; aquí se aplica la restricción por bodega del operador.
const { Router } = require('express');
const c = require('../controllers/comprasControlador');
const { requiereUsuario } = require('../middleware/contexto');

const rutas = Router();

// Express 5 pasa al manejador de errores las promesas rechazadas, así que no hace falta try/catch.
rutas.get('/ordenes-compra', c.listarOrdenes); // también la usa ms-reportes (llamada 6)
rutas.get('/ordenes-compra/:id', c.obtenerOrden);
rutas.post('/ordenes-compra', requiereUsuario, c.crearOrden);
rutas.put('/ordenes-compra/:id', requiereUsuario, c.actualizarOrden);
rutas.patch('/ordenes-compra/:id/estado', requiereUsuario, c.cambiarEstado);
rutas.post('/ordenes-compra/:id/recepciones', requiereUsuario, c.recibir);
rutas.get('/ordenes-compra/:id/recepciones', c.listarRecepciones);

rutas.post('/devoluciones-proveedor', requiereUsuario, c.crearDevolucion);
rutas.get('/devoluciones-proveedor', c.listarDevoluciones);

module.exports = rutas;
