// Rutas internas de ms-compras (Entrega 2, Tabla 10). El Gateway las publica con el prefijo /api y comprueba los roles de cada una; aquí
// se repiten (permisos.js, defensa en profundidad) y se aplica la restricción por bodega del operador.
const { Router } = require('express');
const c = require('../controllers/comprasControlador');
const { exigirRol, requiereUsuario } = require('../middleware/contexto');
const { PERMISOS } = require('./permisos');

const router = Router();

// Cada ruta se declara con `ruta`, que le pone su regla de roles (permisos.js): una ruta sin regla no se puede declarar.
const rutas = new Proxy(router, {
  get(destino, metodo) {
    if (!['get', 'post', 'put', 'patch'].includes(metodo)) return Reflect.get(destino, metodo).bind(destino);
    return (ruta, ...manejadores) => {
      const clave = `${metodo.toUpperCase()} ${ruta}`;
      if (!(clave in PERMISOS)) throw new Error(`La ruta ${clave} no tiene regla de roles en src/routes/permisos.js`);
      const roles = PERMISOS[clave];
      // Primero se exige el usuario (401) y después el rol (403), como en ms-inventario.
      const [primero, ...resto] = manejadores;
      const cadena = primero === requiereUsuario ? [primero, ...(roles ? [exigirRol(roles)] : []), ...resto] : [...(roles ? [exigirRol(roles)] : []), ...manejadores];
      return destino[metodo](ruta, ...cadena);
    };
  },
});

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

module.exports = router;
