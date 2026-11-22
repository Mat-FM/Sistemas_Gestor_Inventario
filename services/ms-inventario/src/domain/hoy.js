'use strict';

// "Hoy" para decidir si un lote está vencido (D36). Las fechas de vencimiento son fechas de calendario (AAAA-MM-DD) de la
// distribuidora, que está en Colombia: se toma el día de America/Bogota y no el del servidor, que en un contenedor suele ser UTC
// (a las 8 p. m. de Bogotá ya es "mañana" en UTC y un lote que vence hoy parecería vencido). Se llama como `reloj.hoy()` (no se
// desestructura) para que las pruebas puedan fijarlo con jest.spyOn.
const formato = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

/** @returns {string} la fecha de hoy en Bogotá, AAAA-MM-DD */
function hoy() {
  return formato.format(new Date());
}

module.exports = { hoy };
