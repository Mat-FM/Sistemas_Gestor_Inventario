// Aplicación Express de ms-compras. Se separa de server.js para poder probarla sin abrir un puerto.
const express = require('express');
const { contexto } = require('./middleware/contexto');
const { rutaNoEncontrada, manejarErrores } = require('./middleware/errores');
const sistemaRutas = require('./routes/sistemaRutas');
const comprasRutas = require('./routes/comprasRutas');

function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(contexto);
  app.use(sistemaRutas);
  app.use(comprasRutas);
  app.use(rutaNoEncontrada);
  app.use(manejarErrores);
  return app;
}

module.exports = { crearApp };
