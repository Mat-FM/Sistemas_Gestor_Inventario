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
  };
}

module.exports = { crearTrasladoController };
