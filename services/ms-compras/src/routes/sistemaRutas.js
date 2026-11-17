// /health (RNF10) y /docs (RNF08). No pasan por el Gateway.
const fs = require('node:fs');
const path = require('node:path');
const { Router } = require('express');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const { pool } = require('../config/db');
const inventario = require('../clients/inventarioCliente');
const notificaciones = require('../clients/notificacionesCliente');

const rutas = Router();

rutas.get('/health', async (req, res) => {
  const dependencias = {
    'ms-inventario': inventario.cliente.cortacircuito.estado,
    'ms-notificaciones': notificaciones.cliente.cortacircuito.estado,
  };
  try {
    await pool.query('SELECT 1');
    res.json({ estado: 'ok', servicio: 'ms-compras', base_de_datos: 'ok', cortacircuitos: dependencias });
  } catch {
    res.status(503).json({ estado: 'error', servicio: 'ms-compras', base_de_datos: 'sin conexión', cortacircuitos: dependencias });
  }
});

const especificacion = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.yaml'), 'utf8'));
rutas.get('/docs/openapi.json', (req, res) => res.json(especificacion));
rutas.use('/docs', swaggerUi.serve, swaggerUi.setup(especificacion, { swaggerOptions: { validatorUrl: null } }));

module.exports = rutas;
