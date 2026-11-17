// Cliente para llamar a otros servicios con las reglas de RNF18:
//  - espera máxima de 3 s por intento;
//  - reintentos (0,2 s, 0,4 s y 0,8 s) solo si la operación no se duplica al repetirse;
//  - cortacircuito: tras 5 fallos seguidos deja de llamar al servicio durante 30 s.
const config = require('../config');
const logger = require('../logger');

class ServicioNoDisponible extends Error {
  constructor(servicio, causa) {
    super(`${servicio} no responde: ${causa}`);
    this.servicio = servicio;
  }
}

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

class Cortacircuito {
  constructor(nombre, { fallosParaAbrir, tiempoAbiertoMs }) {
    this.nombre = nombre;
    this.fallosParaAbrir = fallosParaAbrir;
    this.tiempoAbiertoMs = tiempoAbiertoMs;
    this.fallosSeguidos = 0;
    this.abiertoHasta = 0;
  }

  // Abierto: no se llama. Pasado el tiempo, se deja pasar una llamada de prueba.
  permite() {
    return Date.now() >= this.abiertoHasta;
  }

  exito() {
    this.fallosSeguidos = 0;
    this.abiertoHasta = 0;
  }

  fallo() {
    this.fallosSeguidos += 1;
    if (this.fallosSeguidos >= this.fallosParaAbrir) {
      this.abiertoHasta = Date.now() + this.tiempoAbiertoMs;
      logger.warn('cortacircuito abierto', { destino: this.nombre, segundos: this.tiempoAbiertoMs / 1000 });
    }
  }

  get estado() {
    return this.permite() ? 'CERRADO' : 'ABIERTO';
  }
}

class ClienteHttp {
  constructor(nombre, urlBase, opciones = {}) {
    this.nombre = nombre;
    this.urlBase = urlBase.replace(/\/$/, '');
    this.timeoutMs = opciones.timeoutMs ?? config.llamadas.timeoutMs;
    this.esperas = opciones.esperasReintentoMs ?? config.llamadas.esperasReintentoMs;
    this.cortacircuito = new Cortacircuito(nombre, {
      fallosParaAbrir: opciones.fallosParaAbrir ?? config.llamadas.fallosParaAbrir,
      tiempoAbiertoMs: opciones.tiempoAbiertoMs ?? config.llamadas.tiempoAbiertoMs,
    });
  }

  // Devuelve { status, cuerpo } para cualquier respuesta HTTP (también 4xx).
  // Lanza ServicioNoDisponible si no hubo respuesta, si respondió 5xx o si el cortacircuito está abierto.
  async peticion(metodo, ruta, { cuerpo, cabeceras = {}, reintentar = false } = {}) {
    if (!this.cortacircuito.permite()) {
      throw new ServicioNoDisponible(this.nombre, 'cortacircuito abierto');
    }
    const intentos = reintentar ? this.esperas.length + 1 : 1;
    let ultimoError;

    for (let intento = 0; intento < intentos; intento += 1) {
      if (intento > 0) {
        if (!this.cortacircuito.permite()) break;
        await esperar(this.esperas[intento - 1]);
      }
      try {
        const respuesta = await fetch(`${this.urlBase}${ruta}`, {
          method: metodo,
          headers: { Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...cabeceras },
          body: cuerpo ? JSON.stringify(cuerpo) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const texto = await respuesta.text();
        let datos = null;
        try {
          datos = texto ? JSON.parse(texto) : null;
        } catch {
          datos = { texto };
        }
        if (respuesta.status >= 500) {
          ultimoError = `respondió ${respuesta.status}`;
          this.cortacircuito.fallo();
          continue;
        }
        this.cortacircuito.exito();
        return { status: respuesta.status, cuerpo: datos };
      } catch (error) {
        ultimoError = error.name === 'TimeoutError' ? `no respondió en ${this.timeoutMs} ms` : error.message;
        this.cortacircuito.fallo();
      }
    }
    logger.warn('llamada fallida', { destino: this.nombre, metodo, ruta, causa: ultimoError });
    throw new ServicioNoDisponible(this.nombre, ultimoError);
  }
}

module.exports = { ClienteHttp, Cortacircuito, ServicioNoDisponible };
