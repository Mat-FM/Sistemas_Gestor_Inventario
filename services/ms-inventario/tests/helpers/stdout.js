// Espía process.stdout.write para leer las líneas JSON que escribe el logger real (D19: las pruebas usan el logger de verdad,
// porque un logger falso no añade ni `servicio`, ni `nivel`, ni el `request_id` del contexto de la petición).
function capturarStdout() {
  const escritura = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const lineas = () => escritura.mock.calls.map(([texto]) => JSON.parse(texto));

  /**
   * Espera a que aparezca una línea que cumpla el predicado. La línea de requestLog sale cuando la respuesta termina,
   * y eso puede ocurrir después de que el cliente ya recibió la respuesta.
   */
  async function esperar(predicado, ms = 1000) {
    const limite = Date.now() + ms;
    for (;;) {
      const linea = lineas().find(predicado);
      if (linea) return linea;
      if (Date.now() > limite) throw new Error(`No apareció la línea esperada. Líneas escritas: ${JSON.stringify(lineas())}`);
      await new Promise((resolver) => setTimeout(resolver, 5));
    }
  }

  return { lineas, esperar, restaurar: () => escritura.mockRestore() };
}

module.exports = { capturarStdout };
