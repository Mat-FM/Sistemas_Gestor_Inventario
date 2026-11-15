/**
 * Controlador fino de los traslados (RNF13): toma de la petición el cuerpo, la cabecera Idempotency-Key y la identidad, llama al
 * servicio y arma la respuesta. La validación va en el servicio porque su ORDEN es parte del contrato: la repetición de una clave
 * se responde antes de mirar el cuerpo (RNF17). La identidad (X-User-Id) también la exige registrarRutas en las escrituras.
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearTrasladoController({ trasladoService }) {
  return {
    // POST /traslados + Idempotency-Key → 201 { ...Traslado EN_TRANSITO, movimiento: TRASLADO_SALIDA }; 200 con el original
    // (en su estado actual) si la clave ya se usó
    async crear(req, res) {
      const { traslado, movimiento, replayed } = await trasladoService.crear({
        body: req.body,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      });
      res.status(replayed ? 200 : 201).json({ ...traslado, movimiento });
    },

    // POST /traslados/{id}/recepcion + Idempotency-Key → 200 { ...Traslado RECIBIDO, movimiento: TRASLADO_ENTRADA }, también
    // cuando es la repetición de la misma recepción. El {id} lo valida el servicio, DESPUÉS de la clave (su orden es parte del
    // contrato: una clave ausente es 400 aunque el id sea inválido).
    async recibir(req, res) {
      const { traslado, movimiento } = await trasladoService.recibir({
        idTraslado: req.params.id,
        body: req.body,
        claveIdempotencia: req.headers['idempotency-key'],
        identity: req.identity,
      });
      res.json({ ...traslado, movimiento });
    },
  };
}

module.exports = { crearTrasladoController };
