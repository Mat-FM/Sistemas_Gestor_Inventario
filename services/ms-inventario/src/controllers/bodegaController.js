const { envelope, parsePagination } = require('../http/pagination');
const { booleanoQuery, cuerpoObjeto, idRuta, texto, validarCampos } = require('../http/validate');

// Largos exactos de las columnas de `bodegas` (migración 20261103000100): un texto más largo sería un error 22001 de
// PostgreSQL, es decir un 500. bodegas.test.js comprueba que coinciden con la base.
const LARGOS = { codigo: 30, nombre: 100, ciudad: 100, direccion: 255 };

const campoTexto = (cuerpo, campo) => () => texto(cuerpo[campo], campo, { max: LARGOS[campo] });

// Cuerpo de POST /bodegas: {codigo, nombre, ciudad, direccion}. Se descarta cualquier otro campo (`activa`, `id_bodega`…).
// `texto` recorta los espacios de los extremos, así que el código se GUARDA recortado: ms-reportes busca la bodega por
// `codigo.strip().casefold()` y un código con espacios sobrantes no coincidiría con lo que escribe su usuario.
const leerAlta = (cuerpo) => {
  const datos = cuerpoObjeto(cuerpo);
  return validarCampos({
    codigo: campoTexto(datos, 'codigo'),
    nombre: campoTexto(datos, 'nombre'),
    ciudad: campoTexto(datos, 'ciudad'),
    direccion: campoTexto(datos, 'direccion'),
  });
};

// Cuerpo de PUT /bodegas/{id}: {nombre, ciudad, direccion}, los tres obligatorios (Tabla 9: solo los campos con «?» son
// opcionales). El `codigo` del cuerpo se ignora: no es editable.
const leerCambios = (cuerpo) => {
  const datos = cuerpoObjeto(cuerpo);
  return validarCampos({
    nombre: campoTexto(datos, 'nombre'),
    ciudad: campoTexto(datos, 'ciudad'),
    direccion: campoTexto(datos, 'direccion'),
  });
};

/**
 * Controlador fino de las bodegas (RNF13): lee la petición, valida su forma, llama al servicio y arma la respuesta. No
 * decide reglas de negocio ni toca la base. La identidad (X-User-Id en las escrituras) la exige registrarRutas.
 * Los métodos no usan `this`: se pasan sueltos como handlers de Express. Un error lanzado, también en `async`, llega al
 * manejador de errores (Express 5).
 */
function crearBodegaController({ bodegaService }) {
  return {
    // GET /bodegas?activa&pagina&por_pagina → 200 {datos, meta}
    async listar(req, res) {
      // Se informan juntos todos los parámetros inválidos (activa, pagina y por_pagina).
      const { activa, paginacion } = validarCampos({
        activa: () => booleanoQuery(req.query.activa, 'activa'),
        paginacion: () => parsePagination(req.query),
      });
      const { filas, total } = await bodegaService.listar({ activa, limit: paginacion.porPagina, offset: paginacion.offset });
      res.json(envelope(filas, { pagina: paginacion.pagina, porPagina: paginacion.porPagina, total }));
    },

    // GET /bodegas/{id} → 200 bodega
    async obtener(req, res) {
      res.json(await bodegaService.obtener(idRuta(req.params.id)));
    },

    // POST /bodegas → 201 bodega activa
    async crear(req, res) {
      res.status(201).json(await bodegaService.crear(leerAlta(req.body)));
    },

    // PUT /bodegas/{id} → 200 bodega
    async actualizar(req, res) {
      const id = idRuta(req.params.id);
      res.json(await bodegaService.actualizar(id, leerCambios(req.body)));
    },

    // POST /bodegas/{id}/inactivar → 200 bodega
    async inactivar(req, res) {
      res.json(await bodegaService.inactivar(idRuta(req.params.id)));
    },

    // POST /bodegas/{id}/activar → 200 bodega
    async activar(req, res) {
      res.json(await bodegaService.activar(idRuta(req.params.id)));
    },
  };
}

module.exports = { crearBodegaController };
