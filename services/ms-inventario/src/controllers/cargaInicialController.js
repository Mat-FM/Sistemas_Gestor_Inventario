/**
 * Controlador fino de la carga inicial de saldos (RNF13, RF16): toma de la petición las filas del cuerpo, la cabecera
 * Idempotency-Key y la identidad, llama al servicio y arma la respuesta. Todo lo demás, incluido el ORDEN de las comprobaciones
 * (identidad, clave y después las filas), lo decide el servicio: aquí no se valida el cuerpo, para que un cuerpo mal formado
 * nunca se responda antes que una clave que falta. La identidad (X-User-Id) también la exige registrarRutas en las escrituras.
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearCargaInicialController({ cargaInicialService }) {
  return {
    // POST /internas/saldos/carga-inicial + Idempotency-Key → SIEMPRE 200 { creados, rechazados: [{ fila, motivo }] } si la
    // petición está bien formada, aunque todas las filas se rechacen. `filas` es undefined si el cuerpo no es un objeto
    // (ausente, un arreglo, un texto…): el servicio lo responde con su 422.
    async cargar(req, res) {
      res.json(await cargaInicialService.cargar({
        filas: req.body?.filas,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      }));
    },
  };
}

module.exports = { crearCargaInicialController };
