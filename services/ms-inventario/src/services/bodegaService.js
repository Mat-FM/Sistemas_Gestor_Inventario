const { e } = require('../errors');
const bodegaRepository = require('../repositories/bodegaRepository');

/**
 * Lógica de negocio de las bodegas (RF05, RNF13): decide qué errores de negocio produce cada operación y no sabe nada de
 * HTTP ni de SQL. Recibe datos ya validados por el controlador.
 *
 * Es una fábrica con sus dependencias inyectadas, como createApp:
 * - db: Knex (o una transacción) sobre la que se ejecuta cada operación.
 * - repo: el repositorio; las pruebas pasan uno falso para provocar errores de la base.
 */
function crearBodegaService({ db, repo = bodegaRepository } = {}) {
  const noExiste = () => e.noExiste('La bodega no existe');

  // Un undefined del repositorio (ninguna fila) es una bodega que no existe.
  const existente = (bodega) => {
    if (bodega === undefined) throw noExiste();
    return bodega;
  };

  return {
    /** @returns {Promise<{filas: Bodega[], total: number}>} */
    async listar({ activa, limit, offset }) {
      return repo.list(db, { activa, limit, offset });
    },

    /** @throws 404 NO_EXISTE */
    async obtener(id) {
      return existente(await repo.findById(db, id));
    },

    /**
     * Crea una bodega activa.
     * @throws 409 CODIGO_DUPLICADO si el código ya existe sin distinguir mayúsculas (también el de una bodega inactiva: el
     *         código no se libera). Solo el 23505 de las unicidades del código se traduce; cualquier otro error de la base se
     *         relanza tal cual.
     */
    async crear({ codigo, nombre, ciudad, direccion }) {
      try {
        return await repo.insert(db, { codigo, nombre, ciudad, direccion });
      } catch (error) {
        if (repo.esCodigoDuplicado(error)) throw e.conflicto('CODIGO_DUPLICADO', 'Ya existe una bodega con ese código (no se distingue entre mayúsculas y minúsculas)');
        throw error;
      }
    },

    /** Cambia nombre, ciudad y direccion; el código no es editable. @throws 404 NO_EXISTE */
    async actualizar(id, { nombre, ciudad, direccion }) {
      return existente(await repo.update(db, id, { nombre, ciudad, direccion }));
    },

    /** La bodega deja de recibir movimientos (D12). Idempotente: inactivar una inactiva devuelve 200. @throws 404 NO_EXISTE */
    async inactivar(id) {
      return existente(await repo.setActiva(db, id, false));
    },

    /** Idempotente, como inactivar. @throws 404 NO_EXISTE */
    async activar(id) {
      return existente(await repo.setActiva(db, id, true));
    },
  };
}

module.exports = { crearBodegaService };
