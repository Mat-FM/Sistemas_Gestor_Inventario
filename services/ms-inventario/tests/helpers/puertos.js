// Puertos TCP para las pruebas del arranque. El servicio ya no acepta PORT=0 (puerto efímero: nadie sabría dónde escucha), así que
// una prueba que arranca `iniciar` o `node src/server.js` necesita un puerto concreto y libre; y para probar un puerto ocupado
// hace falta ocuparlo. Los dos enlazan SIN indicar host, igual que `server.listen(puerto)` del servicio (todas las interfaces):
// así chocan con él en cualquier sistema (un servidor en 127.0.0.1 no siempre choca con uno en `::`).
const net = require('node:net');

/** Un puerto libre: se enlaza a 0, se lee el que dio el sistema y se suelta. Entre soltarlo y usarlo otro proceso podría tomarlo. */
function puertoLibre() {
  return new Promise((resolver, rechazar) => {
    const servidor = net.createServer();
    servidor.once('error', rechazar);
    servidor.listen(0, () => {
      const { port } = servidor.address();
      servidor.close((error) => (error ? rechazar(error) : resolver(port)));
    });
  });
}

/**
 * Ocupa un puerto y lo mantiene ocupado hasta `cerrar()`; un `listen` de otro servidor sobre el mismo puerto falla con EADDRINUSE.
 * @returns {Promise<{puerto: number, cerrar: () => Promise<void>}>}
 */
function ocuparPuerto() {
  return new Promise((resolver, rechazar) => {
    const servidor = net.createServer();
    servidor.once('error', rechazar);
    servidor.listen(0, () => {
      resolver({
        puerto: servidor.address().port,
        cerrar: () => new Promise((cerrado) => servidor.close(() => cerrado())),
      });
    });
  });
}

module.exports = { puertoLibre, ocuparPuerto };
