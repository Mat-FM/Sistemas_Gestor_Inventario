// Utilidades compartidas por las pruebas de integración.
const request = require('supertest');
const { pool } = require('../src/config/db');
const { migrar } = require('../scripts/migrar');
const { crearApp } = require('../src/app');
const { crearSimulador } = require('../dev/simulador-servicios');
const inventario = require('../src/clients/inventarioCliente');

const app = crearApp();

const ADMIN = { 'X-User-Id': '1', 'X-User-Rol': 'ADMINISTRADOR' };
const operador = (bodega) => ({ 'X-User-Id': '7', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': String(bodega) });

async function reiniciarBase() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar({ silencioso: true });
}

let simulador;
function levantarSimulador() {
  simulador = crearSimulador();
  return new Promise((resolver) => simulador.servidor.listen(3099, () => resolver(simulador)));
}

function detenerSimulador() {
  return new Promise((resolver) => (simulador ? simulador.servidor.close(() => resolver()) : resolver()));
}

// El cortacircuito guarda estado entre pruebas; se cierra para que cada prueba empiece limpia.
function cerrarCortacircuito() {
  inventario.cliente.cortacircuito.exito();
}

const ordenBase = {
  id_proveedor: 3,
  id_bodega_destino: 1,
  fecha_esperada: '2026-12-01',
  detalles: [
    { id_producto: 25, cantidad_pedida: 10, precio_unitario: 18500 },
    { id_producto: 26, cantidad_pedida: 5, precio_unitario: 4200 },
  ],
};

async function crearOrdenEnviada(datos = ordenBase) {
  const creada = await request(app).post('/ordenes-compra').set(ADMIN).send(datos);
  await request(app).patch(`/ordenes-compra/${creada.body.id_orden}/estado`).set(ADMIN).send({ estado: 'ENVIADA' });
  return creada.body;
}

module.exports = {
  app,
  request,
  pool,
  ADMIN,
  operador,
  ordenBase,
  reiniciarBase,
  levantarSimulador,
  detenerSimulador,
  cerrarCortacircuito,
  crearOrdenEnviada,
  simulador: () => simulador,
};
