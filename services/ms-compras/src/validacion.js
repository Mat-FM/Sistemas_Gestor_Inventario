// Validación sencilla de los datos de entrada. Acumula los errores por campo para devolverlos
// todos juntos en un 422 (Entrega 2, sección 4.1).
const { ApiError } = require('./errores');

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function esFechaValida(valor) {
  if (typeof valor !== 'string' || !FECHA.test(valor)) return false;
  const fecha = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().startsWith(valor);
}

class Validador {
  constructor() {
    this.detalles = [];
  }

  error(campo, mensaje) {
    this.detalles.push({ campo, mensaje });
  }

  enteroPositivo(valor, campo, { opcional = false } = {}) {
    if (valor === undefined || valor === null) {
      if (!opcional) this.error(campo, 'Es obligatorio.');
      return undefined;
    }
    if (!Number.isInteger(valor) || valor <= 0) {
      this.error(campo, 'Debe ser un número entero mayor que cero.');
      return undefined;
    }
    return valor;
  }

  numeroNoNegativo(valor, campo) {
    if (valor === undefined || valor === null) {
      this.error(campo, 'Es obligatorio.');
      return undefined;
    }
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) {
      this.error(campo, 'Debe ser un número mayor o igual a cero.');
      return undefined;
    }
    return Math.round(valor * 100) / 100;
  }

  texto(valor, campo, { opcional = false, max = 255 } = {}) {
    if (valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')) {
      if (!opcional) this.error(campo, 'Es obligatorio.');
      return undefined;
    }
    if (typeof valor !== 'string') {
      this.error(campo, 'Debe ser un texto.');
      return undefined;
    }
    if (valor.trim().length > max) {
      this.error(campo, `No puede tener más de ${max} caracteres.`);
      return undefined;
    }
    return valor.trim();
  }

  fecha(valor, campo, { opcional = false } = {}) {
    if (valor === undefined || valor === null || valor === '') {
      if (!opcional) this.error(campo, 'Es obligatorio.');
      return undefined;
    }
    if (!esFechaValida(valor)) {
      this.error(campo, 'Debe ser una fecha con formato AAAA-MM-DD.');
      return undefined;
    }
    return valor;
  }

  lista(valor, campo) {
    if (!Array.isArray(valor) || valor.length === 0) {
      this.error(campo, 'Debe ser una lista con al menos un elemento.');
      return [];
    }
    return valor;
  }

  // Lanza un 422 si hubo algún error.
  verificar() {
    if (this.detalles.length > 0) throw ApiError.datosInvalidos(this.detalles);
  }
}

// Para parámetros de consulta (?id_proveedor=3): convierte a entero o registra el error.
function enteroDeConsulta(validador, valor, campo) {
  if (valor === undefined || valor === '') return undefined;
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    validador.error(campo, 'Debe ser un número entero mayor que cero.');
    return undefined;
  }
  return numero;
}

function paginacion(validador, query) {
  const pagina = query.pagina === undefined ? 1 : Number(query.pagina);
  const porPagina = query.por_pagina === undefined ? 20 : Number(query.por_pagina);
  if (!Number.isInteger(pagina) || pagina < 1) validador.error('pagina', 'Debe ser un entero mayor o igual a 1.');
  if (!Number.isInteger(porPagina) || porPagina < 1 || porPagina > 100) {
    validador.error('por_pagina', 'Debe ser un entero entre 1 y 100.');
  }
  return { pagina, porPagina };
}

module.exports = { Validador, enteroDeConsulta, paginacion, esFechaValida };
