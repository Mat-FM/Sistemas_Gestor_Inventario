// Pruebas de capas compartidas por los repositorios (RNF13): ÚNICA fuente del bloque «promesas reales» (Ruling 21).

/**
 * Registra, con `describe`/`it` propios, el bloque «promesas reales» de un repositorio.
 *
 * Por qué: un Knex sin `async` devuelve su builder (un thenable, no una Promise). Un fallo síncrono (p. ej. un `db` nulo)
 * saldría como excepción y no como rechazo, y esperar dos veces el mismo valor ejecutaría la consulta dos veces. Todo
 * repositorio declara sus funciones `async` y este bloque lo comprueba:
 * - la lista `funciones` cubre TODA función exportada (una función nueva sin entrada, o una entrada vieja, hace fallar el
 *   bloque, así que no se cuela una función sin `async`);
 * - cada función devuelve una `Promise` real (`instanceof Promise`);
 * - un fallo síncrono (db nulo) llega como RECHAZO (`TypeError`), no como excepción síncrona;
 * - esperar dos veces la misma promesa NO ejecuta la consulta dos veces.
 *
 * Se llama en el nivel superior del archivo de pruebas, como un `describe`.
 * @param {object} repo el módulo del repositorio (`require(...)`)
 * @param {Record<string, unknown[]>} funciones función asíncrona exportada → argumentos DESPUÉS de `dbOrTrx`; cada una debe
 *   tocar la base al menos una vez con esos argumentos
 * @param {object} opciones
 * @param {string} opciones.titulo nombre del repositorio, para el `describe`
 * @param {() => object} opciones.db la instancia de Knex de la suite. Es una función porque el `describe` se registra antes
 *   de que `beforeAll` cree la conexión
 * @param {Record<string, unknown[]>} [opciones.sincronas] funciones exportadas que NO tocan la base y son síncronas a
 *   propósito (p. ej. `esCodigoDuplicado`), con argumentos de ejemplo. Se excluyen de forma explícita: deben existir y no
 *   devolver una Promise
 */
function promesasReales(repo, funciones, { titulo, db, sincronas = {} }) {
  describe(`${titulo}: promesas reales (Ruling 21)`, () => {
    it('la lista de funciones cubre TODA función exportada del repositorio (las síncronas se declaran aparte y no devuelven una Promise)', () => {
      const exportadas = Object.entries(repo).filter(([, valor]) => typeof valor === 'function').map(([nombre]) => nombre);
      expect(exportadas.filter((nombre) => !(nombre in sincronas)).sort()).toEqual(Object.keys(funciones).sort());
      for (const [nombre, argumentos] of Object.entries(sincronas)) {
        expect(exportadas).toContain(nombre);
        expect(repo[nombre](...argumentos)).not.toBeInstanceOf(Promise);
      }
    });

    it.each(Object.entries(funciones))('%s devuelve una Promise real, no el builder de Knex', async (nombre, argumentos) => {
      const resultado = repo[nombre](db(), ...argumentos);
      expect(resultado).toBeInstanceOf(Promise);
      await resultado;
    });

    it.each(Object.entries(funciones))('%s: un fallo síncrono (db nulo) llega como RECHAZO, no como excepción síncrona', async (nombre, argumentos) => {
      let resultado;
      expect(() => { resultado = repo[nombre](null, ...argumentos); }).not.toThrow();
      expect(resultado).toBeInstanceOf(Promise);
      await expect(resultado).rejects.toBeInstanceOf(TypeError);
    });

    it.each(Object.entries(funciones))('%s: esperar dos veces la misma promesa NO ejecuta la consulta dos veces', async (nombre, argumentos) => {
      const conexion = db();
      const sql = [];
      const registrar = (consulta) => sql.push(consulta.sql);
      conexion.on('query', registrar);
      try {
        const resultado = repo[nombre](conexion, ...argumentos);
        await resultado;
        const tras1 = sql.length;
        expect(tras1).toBeGreaterThan(0);
        await resultado;
        expect(sql.length).toBe(tras1);
      } finally {
        conexion.removeListener('query', registrar);
      }
    });
  });
}

module.exports = { promesasReales };
