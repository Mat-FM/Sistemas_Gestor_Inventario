/**
 * Controlador fino de los movimientos (RNF13): toma de la petición el cuerpo, la cabecera Idempotency-Key y la identidad, llama
 * al servicio y arma la respuesta. La validación va en el servicio porque su ORDEN es parte del contrato: la repetición de una
 * clave se responde antes de mirar el cuerpo (RNF17). La identidad (X-User-Id) también la exige registrarRutas.
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearMovimientoController({ movimientoService }) {
  return {
    // POST /movimientos + Idempotency-Key → 201 movimiento con saldo_resultante; 200 con el original si la clave ya se usó
    async registrar(req, res) {
      const { movimiento, replayed } = await movimientoService.registrar({
        body: req.body,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      });
      res.status(replayed ? 200 : 201).json(movimiento);
    },
  };
}

module.exports = { crearMovimientoController };
