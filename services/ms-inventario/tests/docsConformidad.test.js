const { e } = require('../src/errors');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { crearBodega, crearLote, crearMovimiento, crearSaldo, crearUmbral, headers } = require('./helpers/fixtures');
const { validar } = require('./helpers/esquemaOpenapi');
const { cargarDocumento, esquemaJson, operaciones, respuestaDeclarada } = require('./helpers/openapi');

// Conformidad de openapi.yaml con el servicio REAL (RNF08): cada operación se ejecuta contra createApp (PostgreSQL real y clientes
// falsos, como en las demás suites) y se comprueba que el estado esté declarado en ESA operación y que el cuerpo cumpla el esquema de ESA
// respuesta; las operaciones con cuerpo comprueban además que la petición válida cumpla su `requestBody`. Es lo que impide que el
// documento se desfase: un campo de más o de menos en el código, un nombre de parámetro distinto o un estado no declarado la rompen.
//
// Tres tablas:
// - PRINCIPALES: un escenario de ÉXITO por operación (las 24 más la sonda de salud); de él se generan las pruebas desde el documento.
// - ADICIONALES: más respuestas reales (la repetición idempotente, los errores 403/404/409/422/503 con sus códigos…).
// - Las pruebas GENERADAS parten de lo que el documento dice de cada parámetro y de cada campo del cuerpo (tipo, rango, enum,
//   obligatorio) y comprueban que el servicio lo hace cumplir: el servicio ignora en silencio lo que no conoce, así que un 200 no
//   prueba que el nombre documentado exista.

const ADM = headers('ADMINISTRADOR');
const HOY = new Date('2026-11-15T12:00:00.000Z'); // el reloj de las reglas que dependen del día (fecha de un conteo)
const JSON_UTF8 = /^application\/json/;

// El documento se lee al cargar el archivo (no en un beforeAll): las pruebas generadas se construyen a partir de él al declararse.
const documento = cargarDocumento();
const operacionesPorClave = Object.fromEntries(operaciones(documento).map((operacion) => [operacion.clave, operacion]));
let request;
let db;
let clients;
let b1;
let b2;

beforeAll(() => {
  ({ request, db, clients } = buildTestApp({ now: () => HOY }));
});
afterAll(() => db.destroy());
beforeEach(async () => {
  await truncateAll(db);
  b1 = (await crearBodega(db, { codigo: 'B1' })).id_bodega;
  b2 = (await crearBodega(db, { codigo: 'B2' })).id_bodega;
  clients.catalogo.obtenerProducto.mockClear();
  clients.notificaciones.notificarStockBajo.mockClear();
});

// ---------------------------------------------------------------------------------------------------------------------------
// Lo que se ejercitó: cada campo anulable debe verse en sus DOS estados (null y no null) y cada campo opcional de una respuesta,
// presente y ausente; si no, el esquema podría prometer algo que nunca se comprobó. Lo recoge el observador del validador.
// ---------------------------------------------------------------------------------------------------------------------------
const nulos = new Map(); // esquema anulable → { nulo, noNulo }
const opcionales = new Map(); // esquema de objeto → Map(propiedad → { presente, ausente })
const observador = {
  valor(esquema, valor) {
    if (esquema.nullable !== true) return;
    const visto = nulos.get(esquema) ?? { nulo: false, noNulo: false };
    if (valor === null) visto.nulo = true;
    else visto.noNulo = true;
    nulos.set(esquema, visto);
  },
  objeto(esquema, valor) {
    const obligatorias = esquema.required ?? [];
    const vistas = opcionales.get(esquema) ?? new Map();
    for (const nombre of Object.keys(esquema.properties ?? {})) {
      if (obligatorias.includes(nombre)) continue;
      const visto = vistas.get(nombre) ?? { presente: false, ausente: false };
      if (nombre in valor) visto.presente = true;
      else visto.ausente = true;
      vistas.set(nombre, visto);
    }
    opcionales.set(esquema, vistas);
  },
};

// ---------------------------------------------------------------------------------------------------------------------------
// Envío de peticiones y comprobación de respuestas
// ---------------------------------------------------------------------------------------------------------------------------
let contadorDeClaves = 0;
const claveNueva = (prefijo = 'k') => `${prefijo}-${(contadorDeClaves += 1)}`;

function direccion(ruta, consulta = {}) {
  const texto = Object.entries(consulta)
    .flatMap(([nombre, valor]) => (Array.isArray(valor) ? valor : [valor]).map((v) => `${encodeURIComponent(nombre)}=${encodeURIComponent(v)}`))
    .join('&');
  return texto === '' ? ruta : `${ruta}?${texto}`;
}

/**
 * Envía una petición. `p` = { ruta, consulta?, cuerpo?, cabeceras?, clave? }; `cambios` reemplaza partes de `p` (en `consulta` y `cuerpo`
 * se reemplaza todo el objeto). `cuerpoCrudo` envía ese texto tal cual (para el JSON mal formado o enorme) con el `tipoContenido` dado.
 */
function enviar(claveDeOperacion, p, cambios = {}) {
  const [metodo] = claveDeOperacion.split(' ');
  const peticion = { ...p, ...cambios };
  let envio = request[metodo.toLowerCase()](direccion(peticion.ruta, peticion.consulta)).set(peticion.cabeceras ?? ADM);
  if (peticion.clave !== undefined) envio = envio.set('Idempotency-Key', peticion.clave);
  if (peticion.cuerpoCrudo !== undefined) envio = envio.set('Content-Type', peticion.tipoContenido ?? 'application/json').send(peticion.cuerpoCrudo);
  else if (peticion.cuerpo !== undefined) envio = envio.send(peticion.cuerpo);
  return envio;
}

// Las rutas de los arreglos vacíos de un cuerpo (una respuesta de éxito sin elementos no ejercita el esquema de sus ítems).
function arreglosVacios(valor, donde = '$') {
  if (Array.isArray(valor)) return valor.length === 0 ? [donde] : valor.flatMap((elemento, i) => arreglosVacios(elemento, `${donde}[${i}]`));
  if (valor && typeof valor === 'object') return Object.entries(valor).flatMap(([nombre, hijo]) => arreglosVacios(hijo, `${donde}.${nombre}`));
  return [];
}

/**
 * Comprueba una respuesta real contra el documento: el estado está declarado en la operación, el tipo de contenido es JSON y el cuerpo
 * cumple el esquema de ESA respuesta. Una respuesta de éxito no puede traer arreglos vacíos (ejercitarían poco el esquema).
 * `admiteVacios` lo permite en los pocos escenarios cuyo resultado natural es una lista vacía.
 */
function comprobarRespuesta(claveDeOperacion, res, { admiteVacios = false } = {}) {
  const { operacion } = operacionesPorClave[claveDeOperacion];
  const declarada = respuestaDeclarada(documento, operacion, res.status);
  expect({ operacion: claveDeOperacion, estado: res.status, cuerpo: res.body, declarado: declarada !== undefined }).toEqual({
    operacion: claveDeOperacion, estado: res.status, cuerpo: res.body, declarado: true,
  });
  const esquema = esquemaJson(declarada);
  expect({ operacion: claveDeOperacion, estado: res.status, tieneEsquema: esquema !== undefined }).toEqual({ operacion: claveDeOperacion, estado: res.status, tieneEsquema: true });
  expect(res.headers['content-type']).toMatch(JSON_UTF8);
  expect(res.headers['x-request-id']).toEqual(expect.any(String)); // toda respuesta lleva el identificador de la petición
  const errores = validar(documento, esquema, res.body, '$', observador);
  expect({ operacion: claveDeOperacion, estado: res.status, errores }).toEqual({ operacion: claveDeOperacion, estado: res.status, errores: [] });
  if (res.status < 300 && !admiteVacios) expect({ operacion: claveDeOperacion, vacios: arreglosVacios(res.body) }).toEqual({ operacion: claveDeOperacion, vacios: [] });
  return res;
}

// El cuerpo de la petición válida cumple el requestBody que el documento declara.
function comprobarPeticion(claveDeOperacion, p) {
  const { operacion } = operacionesPorClave[claveDeOperacion];
  if (p.cuerpo === undefined) return;
  const esquema = esquemaJson(operacion.requestBody);
  expect({ operacion: claveDeOperacion, declaraCuerpo: esquema !== undefined }).toEqual({ operacion: claveDeOperacion, declaraCuerpo: true });
  expect({ operacion: claveDeOperacion, errores: validar(documento, esquema, p.cuerpo) }).toEqual({ operacion: claveDeOperacion, errores: [] });
}

const exito = (res, estado) => {
  if (res.status !== estado) throw new Error(`La preparación esperaba ${estado} y recibió ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Preparación de datos: directa con Knex cuando basta y por la API cuando el dato es de un flujo (traslados, conteos)
// ---------------------------------------------------------------------------------------------------------------------------
const POST = (ruta, cuerpo, { clave = claveNueva('prep'), cabeceras = ADM, sinClave = false } = {}) => {
  let envio = request.post(ruta).set(cabeceras);
  if (!sinClave) envio = envio.set('Idempotency-Key', clave);
  if (cuerpo !== undefined) envio = envio.send(cuerpo);
  return envio;
};
const PUT = (ruta, cuerpo) => request.put(ruta).set(ADM).send(cuerpo);

// Saldo de 100 del producto en la bodega con un lote de 40 (vence 2027-03-01): 60 quedan sin lote.
async function sembrarStockConLote({ idProducto = 25, idBodega = b1, total = 100, enLote = 40, codigoLote = 'L2026-114', fechaVencimiento = '2027-03-01' } = {}) {
  await crearSaldo(db, { idProducto, idBodega, cantidad: total });
  return crearLote(db, { idBodega, idProducto, codigoLote, fechaVencimiento, cantidad: enLote });
}

// Un traslado creado por la API: con el lote (si se pide) o con stock sin lote. Otro producto permite crear dos traslados en una prueba.
async function crearTraslado({ conLote, idProducto = 25, codigoLote = 'L2026-114' }) {
  const lote = await sembrarStockConLote({ idProducto, codigoLote });
  const cuerpo = { id_producto: idProducto, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10, ...(conLote ? { id_lote: lote.id_lote } : {}) };
  return exito(await POST('/traslados', cuerpo), 201);
}

// Un conteo programado por la API de los productos de `saldos` ({ id_producto: cantidad }) de una bodega.
async function programarConteo({ idBodega = b1, saldos = { 25: 120, 31: 7 } } = {}) {
  for (const [idProducto, cantidad] of Object.entries(saldos)) await crearSaldo(db, { idProducto: Number(idProducto), idBodega, cantidad });
  const ids = Object.keys(saldos).map(Number);
  return exito(await POST('/conteos', { id_bodega: idBodega, fecha_programada: '2026-11-20', ids_producto: ids }, { sinClave: true }), 201);
}
const contarConteo = async (id, detalles) => exito(await PUT(`/conteos/${id}/detalles`, { detalles }), 200);

// ---------------------------------------------------------------------------------------------------------------------------
// Escenarios de éxito, uno por operación. `preparar` siembra los datos y devuelve la petición { ruta, consulta?, cuerpo?, cabeceras?,
// clave? }; `estado` es el que esa petición debe dar.
// ---------------------------------------------------------------------------------------------------------------------------
const PRINCIPALES = {
  'GET /health': { estado: 200, preparar: async () => ({ ruta: '/health' }) },

  'GET /bodegas': {
    estado: 200,
    preparar: async () => {
      await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
      return { ruta: '/bodegas', consulta: { pagina: 1, por_pagina: 20 } };
    },
  },
  'GET /bodegas/{id}': { estado: 200, preparar: async () => ({ ruta: `/bodegas/${b1}` }) },
  'POST /bodegas': {
    estado: 201,
    preparar: async () => ({ ruta: '/bodegas', cuerpo: { codigo: 'BOD-NUEVA-01', nombre: 'Bodega nueva', ciudad: 'Manizales', direccion: 'Carrera 1 # 2-3' } }),
  },
  'PUT /bodegas/{id}': {
    estado: 200,
    preparar: async () => ({ ruta: `/bodegas/${b1}`, cuerpo: { nombre: 'Bodega principal', ciudad: 'Manizales', direccion: 'Carrera 23 # 65-12' } }),
  },
  'POST /bodegas/{id}/inactivar': { estado: 200, preparar: async () => ({ ruta: `/bodegas/${b1}/inactivar` }) },
  'POST /bodegas/{id}/activar': {
    estado: 200,
    preparar: async () => {
      await db('bodegas').where({ id_bodega: b1 }).update({ activa: false });
      return { ruta: `/bodegas/${b1}/activar` };
    },
  },

  'GET /saldos': {
    estado: 200,
    preparar: async () => {
      await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 120 });
      await crearSaldo(db, { idProducto: 25, idBodega: b2, cantidad: 30 });
      await crearSaldo(db, { idProducto: 31, idBodega: b1, cantidad: 7 });
      return { ruta: '/saldos', consulta: { id_producto: 25, pagina: 1, por_pagina: 20 } };
    },
  },
  'GET /saldos/bajo-umbral': {
    estado: 200,
    preparar: async () => {
      await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 120 });
      await crearSaldo(db, { idProducto: 25, idBodega: b2, cantidad: 30 });
      await crearUmbral(db, { idProducto: 25, cantidadMinima: 200 });
      return { ruta: '/saldos/bajo-umbral' };
    },
  },

  'GET /umbrales': {
    estado: 200,
    preparar: async () => {
      await crearUmbral(db, { idProducto: 25, cantidadMinima: 200 });
      await crearUmbral(db, { idProducto: 31, cantidadMinima: 5 });
      return { ruta: '/umbrales', consulta: { pagina: 1, por_pagina: 20 } };
    },
  },
  'PUT /umbrales/{id_producto}': { estado: 200, preparar: async () => ({ ruta: '/umbrales/25', cuerpo: { cantidad_minima: 50 } }) },

  'POST /movimientos': {
    estado: 201,
    preparar: async () => ({
      ruta: '/movimientos',
      clave: 'mov-2026-11-10-0001',
      cuerpo: {
        tipo: 'ENTRADA', id_producto: 25, id_bodega: b1, cantidad: 40,
        lote: { codigo_lote: 'L2026-114', fecha_vencimiento: '2027-03-01' }, documento_referencia: 'FAC-4521', observacion: 'Recepción de pedido',
      },
    }),
  },
  'GET /movimientos': {
    estado: 200,
    preparar: async () => {
      const lote = await crearLote(db, { idBodega: b1, idProducto: 25, codigoLote: 'L1', fechaVencimiento: '2027-03-01', cantidad: 40 });
      await crearMovimiento(db, { idBodega: b1, idProducto: 25, tipo: 'ENTRADA', idLote: lote.id_lote, documentoReferencia: 'FAC-1', observacion: 'obs', fecha: '2026-11-01T10:00:00Z' });
      await crearMovimiento(db, { idBodega: b1, idProducto: 25, tipo: 'SALIDA', fecha: '2026-11-02T10:00:00Z' });
      return {
        ruta: '/movimientos',
        consulta: { id_producto: 25, id_bodega: b1, id_usuario: 7, fecha_desde: '2026-11-01', fecha_hasta: '2026-11-30', pagina: 1, por_pagina: 20 },
      };
    },
  },
  'GET /movimientos/{id}': {
    estado: 200,
    preparar: async () => {
      const movimiento = await crearMovimiento(db, { idBodega: b1, idProducto: 25, documentoReferencia: 'FAC-9', observacion: 'obs' });
      return { ruta: `/movimientos/${movimiento.id_movimiento}` };
    },
  },

  'GET /lotes': {
    estado: 200,
    preparar: async () => {
      await sembrarLotes();
      return { ruta: '/lotes', consulta: { id_producto: 25, id_bodega: b1, vence_antes_de: '2099-01-01', con_existencia: true, pagina: 1, por_pagina: 20 } };
    },
  },
  'GET /lotes/sugerencia-salida': {
    estado: 200,
    preparar: async () => {
      await sembrarLotes();
      return { ruta: '/lotes/sugerencia-salida', consulta: { id_producto: 25, id_bodega: b1, cantidad: 52 } };
    },
  },

  'POST /traslados': {
    estado: 201,
    preparar: async () => {
      const lote = await sembrarStockConLote();
      return { ruta: '/traslados', clave: 'tras-2026-11-12-0001', cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10, id_lote: lote.id_lote } };
    },
  },
  'GET /traslados': {
    estado: 200,
    preparar: async () => {
      const recibido = await crearTraslado({ conLote: false });
      exito(await POST(`/traslados/${recibido.id_traslado}/recepcion`, {}), 200);
      await crearTraslado({ conLote: true, idProducto: 31, codigoLote: 'L-31' });
      return { ruta: '/traslados', consulta: { id_bodega: b1, pagina: 1, por_pagina: 20 } };
    },
  },
  'POST /traslados/{id}/recepcion': {
    estado: 200,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: true });
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: 'rec-2026-11-13-0001', cuerpo: { observacion: 'Llegó completo' } };
    },
  },

  'POST /conteos': {
    estado: 201,
    preparar: async () => {
      await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 120 });
      await crearSaldo(db, { idProducto: 31, idBodega: b1, cantidad: 7 });
      return { ruta: '/conteos', cuerpo: { id_bodega: b1, fecha_programada: '2026-11-20', ids_producto: [25, 31] } };
    },
  },
  'GET /conteos': {
    estado: 200,
    preparar: async () => {
      const aprobado = await programarConteo();
      await contarConteo(aprobado.id_conteo, [{ id_producto: 25, cantidad_contada: 118 }, { id_producto: 31, cantidad_contada: 7 }]);
      exito(await POST(`/conteos/${aprobado.id_conteo}/aprobacion`), 200);
      exito(await POST('/conteos', { id_bodega: b1, fecha_programada: '2026-11-21', ids_producto: [25] }, { sinClave: true }), 201);
      return { ruta: '/conteos', consulta: { id_bodega: b1, pagina: 1, por_pagina: 20 } };
    },
  },
  'GET /conteos/{id}': {
    estado: 200,
    preparar: async () => {
      const conteo = await programarConteo();
      await contarConteo(conteo.id_conteo, [{ id_producto: 25, cantidad_contada: 118 }]); // el 31 queda sin contar
      return { ruta: `/conteos/${conteo.id_conteo}` };
    },
  },
  'PUT /conteos/{id}/detalles': {
    estado: 200,
    preparar: async () => {
      const conteo = await programarConteo();
      return { ruta: `/conteos/${conteo.id_conteo}/detalles`, cuerpo: { detalles: [{ id_producto: 25, cantidad_contada: 118 }, { id_producto: 31, cantidad_contada: 40 }] } };
    },
  },
  'POST /conteos/{id}/aprobacion': {
    estado: 200,
    preparar: async () => {
      const conteo = await programarConteo();
      await contarConteo(conteo.id_conteo, [{ id_producto: 25, cantidad_contada: 118 }, { id_producto: 31, cantidad_contada: 7 }]);
      return { ruta: `/conteos/${conteo.id_conteo}/aprobacion`, clave: 'apr-2026-11-20-0001' };
    },
  },

  'POST /internas/saldos/carga-inicial': {
    estado: 200,
    preparar: async () => ({
      ruta: '/internas/saldos/carga-inicial',
      clave: 'ini-2026-11-01-0001',
      cuerpo: {
        filas: [
          { id_producto: 25, id_bodega: b1, cantidad: 40, codigo_lote: 'L2026-114', fecha_vencimiento: '2027-03-01' },
          { id_producto: 31, id_bodega: b1, cantidad: 15 },
          { id_producto: 25, id_bodega: 4242, cantidad: 1 }, // cumple el esquema y se rechaza por negocio: la bodega no existe
        ],
      },
    }),
  },
};

// Tres lotes del producto 25 en la bodega 1: dos con fecha (10 y 40 unidades) y uno sin fecha (5), todos con existencia.
async function sembrarLotes() {
  await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 60 });
  await crearLote(db, { idBodega: b1, idProducto: 25, codigoLote: 'L-A', fechaVencimiento: '2027-03-01', cantidad: 40 });
  await crearLote(db, { idBodega: b1, idProducto: 25, codigoLote: 'L-B', fechaVencimiento: '2027-01-15', cantidad: 10 });
  await crearLote(db, { idBodega: b1, idProducto: 25, codigoLote: 'L-C', fechaVencimiento: null, cantidad: 5 });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Más respuestas reales: la repetición idempotente, los estados de error con sus códigos y los dos estados de cada campo anulable.
// ---------------------------------------------------------------------------------------------------------------------------
const mov = (extra) => ({ tipo: 'ENTRADA', id_producto: 25, id_bodega: b1, cantidad: 10, ...extra });
const operador = (idBodega) => headers('OPERADOR_BODEGA', { idBodega });

const ADICIONALES = [
  // ---- 2xx con los demás estados de los campos anulables ----
  { op: 'GET /saldos', titulo: 'sin id_producto no envía meta.cantidad_total', estado: 200,
    preparar: async () => { await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 5 }); return { ruta: '/saldos' }; } },
  { op: 'GET /saldos', titulo: 'un operador de bodega ve solo su bodega', estado: 200,
    preparar: async () => {
      await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 5 });
      await crearSaldo(db, { idProducto: 25, idBodega: b2, cantidad: 9 });
      return { ruta: '/saldos', consulta: { id_producto: 25 }, cabeceras: operador(b1) };
    } },
  { op: 'GET /saldos/bajo-umbral', titulo: 'ningún producto bajo el umbral es una lista vacía', estado: 200, admiteVacios: true,
    preparar: async () => ({ ruta: '/saldos/bajo-umbral' }) },
  { op: 'GET /lotes', titulo: 'sin filtros incluye el lote sin fecha de vencimiento (fecha null)', estado: 200,
    preparar: async () => { await sembrarLotes(); return { ruta: '/lotes' }; } },
  { op: 'GET /movimientos', titulo: 'filtrado por tipo', estado: 200,
    preparar: async () => {
      await crearMovimiento(db, { idBodega: b1, tipo: 'ENTRADA' });
      return { ruta: '/movimientos', consulta: { tipo: 'ENTRADA' } };
    } },
  { op: 'GET /movimientos', titulo: 'un movimiento de un traslado y otro de un conteo traen su id_traslado e id_conteo', estado: 200,
    preparar: async () => {
      await crearTraslado({ conLote: true });
      const conteo = await programarConteo({ saldos: { 40: 50, 41: 3 } });
      await contarConteo(conteo.id_conteo, [{ id_producto: 40, cantidad_contada: 48 }]);
      exito(await POST(`/conteos/${conteo.id_conteo}/aprobacion`), 200);
      return { ruta: '/movimientos', consulta: { por_pagina: 100 } };
    } },
  { op: 'POST /movimientos', titulo: 'la repetición con la misma clave devuelve el movimiento original (200)', estado: 200,
    preparar: async () => {
      const peticion = { ruta: '/movimientos', clave: 'repetida-1', cuerpo: mov() };
      exito(await enviar('POST /movimientos', peticion), 201);
      return peticion;
    } },
  { op: 'POST /movimientos', titulo: 'una entrada sin lote ni documento deja id_lote, documento_referencia y observacion en null', estado: 201,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov() }) },
  { op: 'POST /movimientos', titulo: 'una salida sin id_lote sale por FEFO y deja el primer lote consumido en id_lote', estado: 201,
    preparar: async () => { await sembrarStockConLote(); return { ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ tipo: 'SALIDA', cantidad: 5 }) }; } },
  { op: 'POST /movimientos', titulo: 'un ajuste negativo trae cantidad con signo', estado: 201,
    preparar: async () => { await sembrarStockConLote(); return { ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ tipo: 'AJUSTE', cantidad: -2 }) }; } },
  { op: 'POST /traslados', titulo: 'sin id_lote mueve stock sin lote (id_lote null)', estado: 201,
    preparar: async () => {
      await sembrarStockConLote();
      return { ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10 } };
    } },
  { op: 'POST /traslados', titulo: 'la repetición devuelve el traslado en su estado actual (200)', estado: 200,
    preparar: async () => {
      const lote = await sembrarStockConLote();
      const peticion = { ruta: '/traslados', clave: 'tras-repetida', cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10, id_lote: lote.id_lote } };
      exito(await enviar('POST /traslados', peticion), 201);
      return peticion;
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'sin cuerpo recibe un traslado sin lote (observacion y lote en null)', estado: 200,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: false });
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: claveNueva() };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'la repetición de la misma recepción devuelve el original (200)', estado: 200,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: true });
      const peticion = { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: 'rec-repetida', cuerpo: {} };
      exito(await enviar('POST /traslados/{id}/recepcion', peticion), 200);
      return peticion;
    } },
  { op: 'GET /conteos/{id}', titulo: 'un conteo aprobado trae fecha_aprobacion e id_usuario_aprueba', estado: 200,
    preparar: async () => {
      const conteo = await programarConteo();
      await contarConteo(conteo.id_conteo, [{ id_producto: 25, cantidad_contada: 118 }, { id_producto: 31, cantidad_contada: 7 }]);
      exito(await POST(`/conteos/${conteo.id_conteo}/aprobacion`), 200);
      return { ruta: `/conteos/${conteo.id_conteo}` };
    } },
  { op: 'POST /conteos', titulo: 'sin ids_producto cuenta los productos con existencia', estado: 201,
    preparar: async () => {
      await crearSaldo(db, { idProducto: 25, idBodega: b1, cantidad: 120 });
      return { ruta: '/conteos', cuerpo: { id_bodega: b1, fecha_programada: '2026-11-15' } };
    } },
  { op: 'POST /conteos/{id}/aprobacion', titulo: 'la repetición con la misma clave devuelve el conteo y sus movimientos originales', estado: 200,
    preparar: async () => {
      const conteo = await programarConteo();
      await contarConteo(conteo.id_conteo, [{ id_producto: 25, cantidad_contada: 118 }]);
      const peticion = { ruta: `/conteos/${conteo.id_conteo}/aprobacion`, clave: 'apr-repetida' };
      exito(await enviar('POST /conteos/{id}/aprobacion', peticion), 200);
      return peticion;
    } },
  { op: 'POST /internas/saldos/carga-inicial', titulo: 'todas las filas rechazadas siguen siendo 200 con creados 0', estado: 200, peticionInvalida: true,
    preparar: async () => ({ ruta: '/internas/saldos/carga-inicial', clave: claveNueva(), cuerpo: { filas: [{ id_producto: 25, id_bodega: b1, cantidad: 1.5 }, 'no soy una fila'] } }) },
  { op: 'GET /health', titulo: 'sin una variable obligatoria responde 503 SERVICIO_NO_DISPONIBLE', estado: 503, aparte: 'salud-sin-configuracion',
    preparar: async () => ({ ruta: '/health' }) },

  // ---- 400, 401, 403, 404, 409, 422 y 503 con sus códigos ----
  { op: 'POST /bodegas', titulo: 'un código repetido sin distinguir mayúsculas es 409 CODIGO_DUPLICADO', estado: 409,
    preparar: async () => ({ ruta: '/bodegas', cuerpo: { codigo: 'b1', nombre: 'Otra', ciudad: 'Pereira', direccion: 'Calle 1' } }) },
  { op: 'POST /movimientos', titulo: 'sin stock es 409 STOCK_INSUFICIENTE con disponible y solicitado', estado: 409,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ tipo: 'SALIDA', cantidad: 5 }) }) },
  { op: 'POST /movimientos', titulo: 'una bodega inactiva es 409 BODEGA_INACTIVA', estado: 409,
    preparar: async () => {
      await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
      return { ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ id_bodega: b2 }) };
    } },
  { op: 'POST /movimientos', titulo: 'un lote que ya existe con otra fecha es 409 CONFLICTO', estado: 409,
    preparar: async () => {
      await sembrarStockConLote({ codigoLote: 'L-1', fechaVencimiento: '2027-03-01' });
      return { ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ lote: { codigo_lote: 'L-1', fecha_vencimiento: '2027-04-01' } }) };
    } },
  { op: 'POST /movimientos', titulo: 'un tipo reservado es 403 SIN_PERMISO', estado: 403,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ tipo: 'TRASLADO_SALIDA' }) }) },
  { op: 'POST /movimientos', titulo: 'un operador con otra bodega es 403 SIN_PERMISO', estado: 403,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ id_bodega: b1 }), cabeceras: operador(b2) }) },
  { op: 'POST /movimientos', titulo: 'un producto que el catálogo no conoce es 404 NO_EXISTE', estado: 404,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ id_producto: 999 }) }) },
  { op: 'POST /movimientos', titulo: 'una bodega que no existe es 404 NO_EXISTE', estado: 404,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ id_bodega: 4242 }) }) },
  { op: 'POST /movimientos', titulo: 'un id_lote que no es de esa bodega y producto es 404 NO_EXISTE', estado: 404,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ id_lote: 4242 }) }) },
  { op: 'POST /movimientos', titulo: 'sin Idempotency-Key es 400 PETICION_MAL_FORMADA', estado: 400,
    preparar: async () => ({ ruta: '/movimientos', cuerpo: mov() }) },
  { op: 'POST /movimientos', titulo: 'sin X-User-Id es 401 NO_AUTENTICADO', estado: 401,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov(), cabeceras: {} }) },
  { op: 'POST /movimientos', titulo: 'un cuerpo inválido es 422 DATOS_NO_VALIDOS', estado: 422,
    preparar: async () => ({ ruta: '/movimientos', clave: claveNueva(), cuerpo: mov({ cantidad: 0 }) }) },
  { op: 'POST /movimientos', titulo: 'con ms-catalogo caído es 503 SERVICIO_NO_DISPONIBLE', estado: 503,
    preparar: async () => {
      clients.catalogo.obtenerProducto.mockImplementationOnce(async () => { throw e.noDisponible('El servicio ms-catalogo no está disponible'); });
      return { ruta: '/movimientos', clave: claveNueva(), cuerpo: mov() };
    } },
  { op: 'PUT /umbrales/{id_producto}', titulo: 'un producto que el catálogo no conoce es 404', estado: 404,
    preparar: async () => ({ ruta: '/umbrales/999', cuerpo: { cantidad_minima: 5 } }) },
  { op: 'PUT /umbrales/{id_producto}', titulo: 'con ms-catalogo caído es 503', estado: 503,
    preparar: async () => {
      clients.catalogo.obtenerProducto.mockImplementationOnce(async () => { throw e.noDisponible('El servicio ms-catalogo no está disponible'); });
      return { ruta: '/umbrales/25', cuerpo: { cantidad_minima: 5 } };
    } },
  { op: 'GET /lotes/sugerencia-salida', titulo: 'si los lotes no alcanzan es 409 STOCK_INSUFICIENTE', estado: 409,
    preparar: async () => { await sembrarLotes(); return { ruta: '/lotes/sugerencia-salida', consulta: { id_producto: 25, id_bodega: b1, cantidad: 500 } }; } },
  { op: 'GET /lotes/sugerencia-salida', titulo: 'sin un parámetro obligatorio es 422', estado: 422,
    preparar: async () => ({ ruta: '/lotes/sugerencia-salida', consulta: { id_producto: 25, id_bodega: b1 } }) },
  { op: 'GET /movimientos', titulo: 'un operador pide otra bodega: 403', estado: 403,
    preparar: async () => ({ ruta: '/movimientos', consulta: { id_bodega: b1 }, cabeceras: operador(b2) }) },
  { op: 'GET /movimientos', titulo: 'fecha_desde posterior a fecha_hasta es 422', estado: 422,
    preparar: async () => ({ ruta: '/movimientos', consulta: { fecha_desde: '2026-11-30', fecha_hasta: '2026-11-01' } }) },
  { op: 'GET /movimientos/{id}', titulo: 'un movimiento de otra bodega es 403 (no 404) para un operador', estado: 403,
    preparar: async () => {
      const movimiento = await crearMovimiento(db, { idBodega: b1 });
      return { ruta: `/movimientos/${movimiento.id_movimiento}`, cabeceras: operador(b2) };
    } },
  { op: 'POST /traslados', titulo: 'sin stock sin lote suficiente es 409 STOCK_INSUFICIENTE', estado: 409,
    preparar: async () => {
      await sembrarStockConLote({ total: 100, enLote: 95 });
      return { ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10 } };
    } },
  { op: 'POST /traslados', titulo: 'con el destino inactivo es 409 BODEGA_INACTIVA', estado: 409,
    preparar: async () => {
      await sembrarStockConLote();
      await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
      return { ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10 } };
    } },
  { op: 'POST /traslados', titulo: 'un lote que el destino tiene con otra fecha es 409 CONFLICTO', estado: 409,
    preparar: async () => {
      const lote = await sembrarStockConLote({ codigoLote: 'L-9', fechaVencimiento: '2027-03-01' });
      await crearLote(db, { idBodega: b2, idProducto: 25, codigoLote: 'L-9', fechaVencimiento: '2027-06-01', cantidad: 1 });
      return { ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10, id_lote: lote.id_lote } };
    } },
  { op: 'POST /traslados', titulo: 'una bodega de destino que no existe es 404', estado: 404,
    preparar: async () => ({ ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: 4242, cantidad: 10 } }) },
  { op: 'POST /traslados', titulo: 'la misma bodega de origen y destino es 422', estado: 422,
    preparar: async () => ({ ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b1, cantidad: 10 } }) },
  { op: 'POST /traslados', titulo: 'un operador que envía desde otra bodega es 403', estado: 403,
    preparar: async () => ({ ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10 }, cabeceras: operador(b2) }) },
  { op: 'POST /traslados', titulo: 'con ms-catalogo caído es 503', estado: 503,
    preparar: async () => {
      clients.catalogo.obtenerProducto.mockImplementationOnce(async () => { throw e.noDisponible('El servicio ms-catalogo no está disponible'); });
      return { ruta: '/traslados', clave: claveNueva(), cuerpo: { id_producto: 25, id_bodega_origen: b1, id_bodega_destino: b2, cantidad: 10 } };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'recibir otra vez (con otra clave) es 409 TRASLADO_YA_RECIBIDO', estado: 409,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: true });
      exito(await POST(`/traslados/${traslado.id_traslado}/recepcion`, {}), 200);
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: claveNueva(), cuerpo: {} };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'con el destino inactivo es 409 BODEGA_INACTIVA y el traslado sigue EN_TRANSITO', estado: 409,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: true });
      await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: claveNueva(), cuerpo: {} };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'un lote del destino con otra fecha es 409 CONFLICTO y el traslado sigue EN_TRANSITO', estado: 409,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: true });
      await crearLote(db, { idBodega: b2, idProducto: 25, codigoLote: 'L2026-114', fechaVencimiento: '2027-09-01', cantidad: 1 });
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: claveNueva(), cuerpo: {} };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'una clave que ya recibió otro traslado es 409 CONFLICTO', estado: 409,
    preparar: async () => {
      const primero = await crearTraslado({ conLote: false });
      const segundo = await crearTraslado({ conLote: false, idProducto: 31, codigoLote: 'L-31' });
      exito(await POST(`/traslados/${primero.id_traslado}/recepcion`, {}, { clave: 'rec-ajena' }), 200);
      return { ruta: `/traslados/${segundo.id_traslado}/recepcion`, clave: 'rec-ajena', cuerpo: {} };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'una observación inválida es 422', estado: 422,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: false });
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: claveNueva(), cuerpo: { observacion: 12345 } };
    } },
  { op: 'POST /traslados/{id}/recepcion', titulo: 'un operador que recibe en otra bodega es 403', estado: 403,
    preparar: async () => {
      const traslado = await crearTraslado({ conLote: false });
      return { ruta: `/traslados/${traslado.id_traslado}/recepcion`, clave: claveNueva(), cuerpo: {}, cabeceras: operador(b1) };
    } },
  { op: 'POST /conteos', titulo: 'una bodega que no existe es 404', estado: 404,
    preparar: async () => ({ ruta: '/conteos', cuerpo: { id_bodega: 4242, fecha_programada: '2026-11-20', ids_producto: [25] } }) },
  { op: 'POST /conteos', titulo: 'una bodega inactiva es 409 BODEGA_INACTIVA', estado: 409,
    preparar: async () => {
      await db('bodegas').where({ id_bodega: b2 }).update({ activa: false });
      return { ruta: '/conteos', cuerpo: { id_bodega: b2, fecha_programada: '2026-11-20', ids_producto: [25] } };
    } },
  { op: 'POST /conteos', titulo: 'una fecha anterior al día UTC de hoy es 422', estado: 422,
    preparar: async () => ({ ruta: '/conteos', cuerpo: { id_bodega: b1, fecha_programada: '2026-11-14', ids_producto: [25] } }) },
  { op: 'GET /conteos', titulo: 'un operador pide otra bodega: 403', estado: 403,
    preparar: async () => ({ ruta: '/conteos', consulta: { id_bodega: b1 }, cabeceras: operador(b2) }) },
  { op: 'GET /conteos/{id}', titulo: 'un conteo de otra bodega es 403 (no 404) para un operador', estado: 403,
    preparar: async () => {
      const conteo = await programarConteo();
      return { ruta: `/conteos/${conteo.id_conteo}`, cabeceras: operador(b2) };
    } },
  { op: 'PUT /conteos/{id}/detalles', titulo: 'sobre un conteo aprobado es 409 CONTEO_ESTADO_INVALIDO', estado: 409,
    preparar: async () => {
      const conteo = await programarConteo();
      await contarConteo(conteo.id_conteo, [{ id_producto: 25, cantidad_contada: 120 }]);
      exito(await POST(`/conteos/${conteo.id_conteo}/aprobacion`), 200);
      return { ruta: `/conteos/${conteo.id_conteo}/detalles`, cuerpo: { detalles: [{ id_producto: 25, cantidad_contada: 1 }] } };
    } },
  { op: 'PUT /conteos/{id}/detalles', titulo: 'un producto que no está en el conteo es 422', estado: 422,
    preparar: async () => {
      const conteo = await programarConteo();
      return { ruta: `/conteos/${conteo.id_conteo}/detalles`, cuerpo: { detalles: [{ id_producto: 77, cantidad_contada: 1 }] } };
    } },
  { op: 'PUT /conteos/{id}/detalles', titulo: 'un operador de otra bodega es 403', estado: 403,
    preparar: async () => {
      const conteo = await programarConteo();
      return { ruta: `/conteos/${conteo.id_conteo}/detalles`, cuerpo: { detalles: [{ id_producto: 25, cantidad_contada: 1 }] }, cabeceras: operador(b2) };
    } },
  { op: 'POST /conteos/{id}/aprobacion', titulo: 'un conteo que no está EN_REVISION es 409 CONTEO_ESTADO_INVALIDO', estado: 409,
    preparar: async () => {
      const conteo = await programarConteo();
      return { ruta: `/conteos/${conteo.id_conteo}/aprobacion`, clave: claveNueva() };
    } },
  { op: 'POST /conteos/{id}/aprobacion', titulo: 'un ajuste negativo sin saldo es 409 STOCK_INSUFICIENTE y no se aplica nada', estado: 409,
    preparar: async () => {
      const conteo = await programarConteo({ saldos: { 31: 7 } });
      await contarConteo(conteo.id_conteo, [{ id_producto: 31, cantidad_contada: 0 }]); // diferencia −7
      await db('saldos').where({ id_producto: 31, id_bodega: b1 }).update({ cantidad_disponible: 0 }); // se vendió todo entre medias
      return { ruta: `/conteos/${conteo.id_conteo}/aprobacion`, clave: claveNueva() };
    } },
  { op: 'POST /conteos/{id}/aprobacion', titulo: 'una clave que ya aprobó otro conteo es 409 CONFLICTO', estado: 409,
    preparar: async () => {
      const primero = await programarConteo();
      await contarConteo(primero.id_conteo, [{ id_producto: 25, cantidad_contada: 118 }]);
      exito(await POST(`/conteos/${primero.id_conteo}/aprobacion`, undefined, { clave: 'apr-ajena' }), 200);
      const segundo = exito(await POST('/conteos', { id_bodega: b1, fecha_programada: '2026-11-22', ids_producto: [25] }, { sinClave: true }), 201);
      await contarConteo(segundo.id_conteo, [{ id_producto: 25, cantidad_contada: 117 }]);
      return { ruta: `/conteos/${segundo.id_conteo}/aprobacion`, clave: 'apr-ajena' };
    } },
  { op: 'POST /internas/saldos/carga-inicial', titulo: 'una lista de filas vacía es 422', estado: 422,
    preparar: async () => ({ ruta: '/internas/saldos/carga-inicial', clave: claveNueva(), cuerpo: { filas: [] } }) },
  { op: 'POST /internas/saldos/carga-inicial', titulo: 'sin X-User-Rol es 401', estado: 401,
    preparar: async () => ({ ruta: '/internas/saldos/carga-inicial', clave: claveNueva(), cuerpo: { filas: [{ id_producto: 25, id_bodega: b1, cantidad: 1 }] }, cabeceras: { 'X-User-Id': '7' } }) },
];

// Un escenario con la aplicación de la sonda de salud sin una variable obligatoria (503) en vez de la de las demás pruebas.
const aplicacionSinConfiguracion = () => buildTestApp({ env: { ...entornoValido(), MS_CATALOGO_URL: undefined } });

// ---------------------------------------------------------------------------------------------------------------------------
// Las pruebas
// ---------------------------------------------------------------------------------------------------------------------------
describe('conformidad: una operación de éxito por cada operación del documento', () => {
  it('hay un escenario de éxito por operación documentada, y solo por ellas', () => {
    expect(Object.keys(PRINCIPALES).sort()).toEqual(Object.keys(operacionesPorClave).sort());
    expect(Object.keys(PRINCIPALES)).toHaveLength(25);
  });

  it.each(Object.keys(PRINCIPALES))('%s: el estado de éxito está declarado y la respuesta cumple el esquema de ESA respuesta', async (clave) => {
    const escenario = PRINCIPALES[clave];
    const peticion = await escenario.preparar();
    comprobarPeticion(clave, peticion);
    const res = await enviar(clave, peticion);
    expect({ clave, estado: res.status, cuerpo: res.body }).toEqual({ clave, estado: escenario.estado, cuerpo: res.body });
    comprobarRespuesta(clave, res);
  });
});

describe('conformidad: más respuestas reales (repeticiones idempotentes, errores y campos anulables)', () => {
  it.each(ADICIONALES.map((adicional) => [`${adicional.op}: ${adicional.titulo}`, adicional]))('%s', async (_titulo, adicional) => {
    const peticion = await adicional.preparar();
    // Solo las peticiones de ÉXITO deben cumplir el requestBody (las de error son inválidas a propósito) y, entre ellas, la de la
    // carga inicial con todas las filas malas, que el servicio responde 200 con las filas rechazadas.
    if (adicional.estado < 300 && !adicional.peticionInvalida) comprobarPeticion(adicional.op, peticion);
    let res;
    if (adicional.aparte === 'salud-sin-configuracion') {
      const sinConfiguracion = aplicacionSinConfiguracion();
      try {
        res = await sinConfiguracion.request.get('/health');
      } finally {
        await sinConfiguracion.db.destroy();
      }
    } else {
      res = await enviar(adicional.op, peticion);
    }
    expect({ op: adicional.op, estado: res.status, cuerpo: res.body }).toEqual({ op: adicional.op, estado: adicional.estado, cuerpo: res.body });
    comprobarRespuesta(adicional.op, res, { admiteVacios: adicional.admiteVacios });
  });

  it('el 500 de una falla inesperada cumple el esquema de ERROR_INTERNO (con una base que falla)', async () => {
    const { createApp } = require('../src/app');
    const supertest = require('supertest');
    const baseRota = () => { throw new Error('la base no responde'); };
    const app = createApp({ db: baseRota, clients, logger: { info() {}, error() {} }, env: entornoValido() });
    const res = await supertest(app).get('/bodegas').set(ADM);
    expect(res.status).toBe(500);
    comprobarRespuesta('GET /bodegas', res);
    expect(res.body.error.codigo).toBe('ERROR_INTERNO');
  });
});

describe('conformidad: cobertura de los estados declarados', () => {
  it('todo estado 2xx, 409 y 503 que el documento declara tiene un escenario real que lo produce', () => {
    // Los demás estados de error (400, 401, 403, 404, 413, 415, 422 y el 500 genérico) también se ejercitan, pero en las pruebas
    // generadas de más abajo (cuerpos, parámetros, identidad y direcciones) y en el 500 de la base rota. Un 2xx, un 409 o un 503
    // nuevos en el documento exigen su escenario aquí, donde se comprueba además el código de error que lleva.
    const ejercitados = new Set();
    for (const [clave, escenario] of Object.entries(PRINCIPALES)) ejercitados.add(`${clave} ${escenario.estado}`);
    for (const adicional of ADICIONALES) ejercitados.add(`${adicional.op} ${adicional.estado}`);
    const sinEscenario = [];
    for (const { clave, operacion } of operaciones(documento)) {
      for (const estado of Object.keys(operacion.responses)) {
        if (/^(2\d\d|409|503)$/.test(estado) && !ejercitados.has(`${clave} ${estado}`)) sinEscenario.push(`${clave} ${estado}`);
      }
    }
    expect(sinEscenario).toEqual([]);
    expect(ejercitados.size).toBeGreaterThan(40); // control: la tabla de escenarios no está vacía
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Pruebas GENERADAS desde el documento: lo que dice de cada parámetro y de cada campo del cuerpo debe cumplirlo el servicio.
// Se parte del escenario de éxito de la operación (los datos ya sembrados) y se cambia UNA cosa por petición.
// ---------------------------------------------------------------------------------------------------------------------------
const resolverEsquema = (esquema) => (esquema?.$ref ? documento.components.schemas[esquema.$ref.split('/').pop()] : esquema);
const OPERACIONES_DE_ESCRITURA = () => Object.keys(PRINCIPALES).filter((clave) => !clave.startsWith('GET '));
const CON_CUERPO = () => Object.keys(PRINCIPALES).filter((clave) => operacionesPorClave[clave].operacion.requestBody !== undefined);
const LIMITE_GENERAL = () => documento.info['x-tamano-maximo-cuerpo-bytes'];

const ESTADO_422 = (res, campo) => {
  expect({ estado: res.status, cuerpo: res.body }).toEqual({ estado: 422, cuerpo: res.body });
  expect(res.body.error.codigo).toBe('DATOS_NO_VALIDOS');
  const campos = res.body.error.detalles.map((detalle) => detalle.campo);
  expect({ campo, campos, nombrado: campos.some((c) => c === campo || c.startsWith(`${campo}[`) || c.startsWith(`${campo}.`)) }).toEqual({ campo, campos, nombrado: true });
};

describe('conformidad generada: parámetros de consulta', () => {
  // Un valor válido del esquema de un parámetro (para repetirlo) y los inválidos que le corresponden por su tipo y sus límites.
  const valido = (esquema) => (esquema.enum ? esquema.enum[0] : esquema.format === 'date' ? '2026-11-01' : esquema.type === 'boolean' ? 'true' : 1);
  function invalidos(esquema) {
    const lista = ['', 'abc'];
    if (esquema.type === 'integer') {
      lista.push('1.5', '1e3', ' 1', String((esquema.minimum ?? 1) - 1), String((esquema.maximum ?? 2147483647) + 1));
    }
    if (esquema.type === 'boolean') lista.push('1', 'TRUE', 'si');
    if (esquema.format === 'date') lista.push('2026-02-30', '2026-13-01', '26-11-01', '2026-11-01T00:00:00Z');
    if (esquema.enum) lista.push('VALOR_NO_PERMITIDO', String(esquema.enum[0]).toLowerCase());
    return lista;
  }
  const conConsulta = Object.keys(PRINCIPALES).filter((clave) => operacionesPorClave[clave].parametros.some((p) => p.in === 'query'));

  it('hay operaciones con parámetros de consulta (control)', () => {
    expect(conConsulta.length).toBe(8);
  });

  it.each(conConsulta)('%s: cada parámetro documentado rechaza con 422, nombrándolo, un valor de otro tipo, fuera de rango, vacío o repetido', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const parametros = operacionesPorClave[clave].parametros.filter((p) => p.in === 'query');
    let probados = 0;
    for (const parametro of parametros) {
      const esquema = resolverEsquema(parametro.schema);
      for (const valor of invalidos(esquema)) {
        const res = await enviar(clave, peticion, { consulta: { ...peticion.consulta, [parametro.name]: valor } });
        ESTADO_422(res, parametro.name);
        comprobarRespuesta(clave, res);
        probados += 1;
      }
      // El mismo parámetro repetido es 422.
      const repetido = await enviar(clave, peticion, { consulta: { ...peticion.consulta, [parametro.name]: [valido(esquema), valido(esquema)] } });
      ESTADO_422(repetido, parametro.name);
      probados += 1;
    }
    expect(probados).toBeGreaterThan(parametros.length * 3);
  });

  it.each(conConsulta)('%s: los límites válidos (mínimo y máximo documentados) no dan 422 y los parámetros obligatorios ausentes sí', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    for (const parametro of operacionesPorClave[clave].parametros.filter((p) => p.in === 'query')) {
      const esquema = resolverEsquema(parametro.schema);
      if (esquema.type === 'integer') {
        for (const limite of [esquema.minimum ?? 1, esquema.maximum ?? 2147483647]) {
          const res = await enviar(clave, peticion, { consulta: { ...peticion.consulta, [parametro.name]: limite } });
          expect({ clave, parametro: parametro.name, limite, no422: res.status !== 422 }).toEqual({ clave, parametro: parametro.name, limite, no422: true });
          if (res.status < 300) comprobarRespuesta(clave, res, { admiteVacios: true });
        }
      }
      if (parametro.required === true) {
        const { [parametro.name]: _quitado, ...sinElParametro } = peticion.consulta;
        ESTADO_422(await enviar(clave, peticion, { consulta: sinElParametro }), parametro.name);
      }
    }
  });

  it.each(Object.keys(PRINCIPALES).filter((clave) => clave.startsWith('GET ')))('%s: un parámetro de consulta que no conoce se ignora', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const res = await enviar(clave, peticion, { consulta: { ...peticion.consulta, parametro_inventado: 'x', 'pagina[]': 1 } });
    expect(res.status).toBe(PRINCIPALES[clave].estado);
  });
});

describe('conformidad generada: listados paginados', () => {
  const listados = Object.keys(PRINCIPALES).filter((clave) => esquemaJson(operacionesPorClave[clave].operacion.responses['200'])?.$ref?.startsWith('#/components/schemas/Listado'));

  it('las siete operaciones de listado son las que el documento dice (control)', () => {
    expect(listados.sort()).toEqual(['GET /bodegas', 'GET /conteos', 'GET /lotes', 'GET /movimientos', 'GET /saldos', 'GET /traslados', 'GET /umbrales']);
  });

  it.each(listados)('%s: meta.total cuenta TODO el filtro y no la página, y la página pedida vuelve en meta', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const primera = await enviar(clave, peticion, { consulta: { ...peticion.consulta, pagina: 1, por_pagina: 1 } });
    comprobarRespuesta(clave, primera);
    expect(primera.body.datos).toHaveLength(1);
    expect(primera.body.meta).toMatchObject({ pagina: 1, por_pagina: 1, total: 2 });
    const segunda = await enviar(clave, peticion, { consulta: { ...peticion.consulta, pagina: 2, por_pagina: 1 } });
    comprobarRespuesta(clave, segunda);
    expect(segunda.body.datos).toHaveLength(1);
    expect(segunda.body.meta).toMatchObject({ pagina: 2, por_pagina: 1, total: 2 });
    expect(segunda.body.datos[0]).not.toEqual(primera.body.datos[0]);
    const fuera = await enviar(clave, peticion, { consulta: { ...peticion.consulta, pagina: 99, por_pagina: 1 } });
    comprobarRespuesta(clave, fuera, { admiteVacios: true });
    expect(fuera.body).toMatchObject({ datos: [], meta: { pagina: 99, por_pagina: 1, total: 2 } });
  });

  it('GET /saldos: meta.cantidad_total suma todo el filtro (no la página) solo con id_producto', async () => {
    const peticion = await PRINCIPALES['GET /saldos'].preparar();
    const pagina = await enviar('GET /saldos', peticion, { consulta: { id_producto: 25, por_pagina: 1 } });
    expect(pagina.body.meta).toMatchObject({ total: 2, cantidad_total: 150 });
    const sinProducto = await enviar('GET /saldos', peticion, { consulta: { por_pagina: 1 } });
    expect(sinProducto.body.meta).not.toHaveProperty('cantidad_total');
    const unaBodega = await enviar('GET /saldos', peticion, { consulta: { id_producto: 25, id_bodega: b2 } });
    expect(unaBodega.body.meta).toMatchObject({ total: 1, cantidad_total: 30 });
  });
});

describe('conformidad generada: cuerpos de petición', () => {
  // Valores de otro tipo para una propiedad, según su esquema, más los que rompen sus límites. Cada uno debe dar 422.
  function malos(esquema, nombre) {
    const lista = [];
    const otrosTipos = { integer: ['texto', 1.5, true, []], string: [12345, true, {}, []], boolean: ['si', 1], array: ['texto', 5, {}], object: [5, 'texto', []] };
    for (const valor of otrosTipos[esquema.type] ?? []) lista.push([`${JSON.stringify(valor)} no es ${esquema.type}`, valor]);
    if (esquema.nullable !== true) lista.push(['null en un campo que no admite null', null]);
    if (esquema.enum) lista.push(['un valor fuera del enum', 'VALOR_NO_PERMITIDO']);
    if (esquema.minimum !== undefined) lista.push([`${esquema.minimum - 1} está por debajo del mínimo`, esquema.minimum - 1]);
    if (esquema.maximum !== undefined) lista.push([`${esquema.maximum + 1} supera el máximo`, esquema.maximum + 1]);
    if (esquema.type === 'integer' && esquema.maximum === undefined) lista.push(['supera el techo del INTEGER', 2147483648]);
    if (esquema.minLength >= 1) lista.push(['un texto vacío', '']);
    if (esquema.maxLength !== undefined) lista.push([`${esquema.maxLength + 1} caracteres`, 'a'.repeat(esquema.maxLength + 1)]);
    if (esquema.format === 'date') lista.push(['una fecha imposible', '2026-02-30'], ['un texto que no es una fecha', 'no-es-fecha']);
    if (esquema.type === 'array') {
      if (esquema.minItems >= 1) lista.push(['una lista vacía', []]);
      if (esquema.maxItems !== undefined) lista.push([`${esquema.maxItems + 1} elementos`, Array.from({ length: esquema.maxItems + 1 }, (_, i) => i + 1)]);
      if (esquema.uniqueItems) lista.push(['un elemento repetido', [1, 1]]);
    }
    return lista.map(([titulo, valor]) => [`${nombre}: ${titulo}`, valor]);
  }

  // Todas las rutas de propiedades del cuerpo que el servicio valida con 422: las de primer nivel, las de un objeto anidado y las de los
  // elementos de una lista de objetos (la posición 0). Las filas de la carga inicial no: una fila inválida se rechaza, no es 422.
  function caminos(esquema, camino = [], salta = new Set()) {
    const resuelto = resolverEsquema(esquema);
    const lista = [];
    for (const [nombre, propiedad] of Object.entries(resuelto.properties ?? {})) {
      const esquemaPropiedad = resolverEsquema(propiedad);
      const ruta = [...camino, nombre];
      lista.push({ ruta, esquema: esquemaPropiedad });
      if (esquemaPropiedad.type === 'object' && esquemaPropiedad.properties) lista.push(...caminos(esquemaPropiedad, ruta, salta));
      if (esquemaPropiedad.type === 'array' && esquemaPropiedad.items && !salta.has(nombre)) {
        const item = resolverEsquema(esquemaPropiedad.items);
        if (item.type === 'object' && item.properties) lista.push(...caminos(item, [...ruta, 0], salta));
        else lista.push({ ruta: [...ruta, 0], esquema: item });
      }
    }
    return lista;
  }
  const nombreDelCampo = (ruta) => ruta.reduce((texto, parte) => (typeof parte === 'number' ? `${texto}[${parte}]` : texto === '' ? parte : `${texto}.${parte}`), '');
  function asignar(objeto, ruta, valor) {
    const copia = structuredClone(objeto);
    let actual = copia;
    ruta.slice(0, -1).forEach((parte) => { actual = actual[parte]; });
    actual[ruta[ruta.length - 1]] = valor;
    return copia;
  }

  it.each(CON_CUERPO())('%s: cada campo documentado del cuerpo rechaza con 422, nombrándolo, un valor de otro tipo o fuera de sus límites', async (clave) => {
    const operacion = operacionesPorClave[clave];
    const esquemaCuerpo = resolverEsquema(esquemaJson(operacion.operacion.requestBody));
    const peticion = await PRINCIPALES[clave].preparar();
    const base = peticion.cuerpo ?? { observacion: 'x' }; // el cuerpo de la recepción es opcional: se parte de uno con su campo
    const salta = new Set(clave === 'POST /internas/saldos/carga-inicial' ? ['filas'] : []);
    const propiedades = caminos(esquemaCuerpo, [], salta);
    expect(propiedades.length).toBeGreaterThanOrEqual(Object.keys(esquemaCuerpo.properties).length);
    let probados = 0;
    for (const { ruta, esquema } of propiedades) {
      for (const [titulo, valor] of malos(esquema, nombreDelCampo(ruta))) {
        const cuerpo = asignar(base, ruta, valor);
        const res = await enviar(clave, peticion, { cuerpo, ...(peticion.clave === undefined ? {} : { clave: claveNueva() }) });
        try {
          ESTADO_422(res, nombreDelCampo(ruta));
        } catch (error) {
          error.message = `${clave} con ${titulo}:\n${error.message}`;
          throw error;
        }
        comprobarRespuesta(clave, res);
        probados += 1;
      }
    }
    expect(probados).toBeGreaterThan(propiedades.length);
  });

  it.each(CON_CUERPO())('%s: un campo obligatorio ausente es 422 y los campos que el documento llama nullable aceptan null', async (clave) => {
    const operacion = operacionesPorClave[clave];
    const esquemaCuerpo = resolverEsquema(esquemaJson(operacion.operacion.requestBody));
    const peticion = await PRINCIPALES[clave].preparar();
    const base = peticion.cuerpo ?? {};
    for (const nombre of esquemaCuerpo.required ?? []) {
      const { [nombre]: _quitado, ...sinElCampo } = base;
      ESTADO_422(await enviar(clave, peticion, { cuerpo: sinElCampo, ...(peticion.clave === undefined ? {} : { clave: claveNueva() }) }), nombre);
    }
    // Los nullable van al final: aceptar null puede completar la operación (y cambiar datos).
    for (const [nombre, propiedad] of Object.entries(esquemaCuerpo.properties)) {
      if (resolverEsquema(propiedad).nullable !== true) continue;
      const res = await enviar(clave, peticion, { cuerpo: { ...base, [nombre]: null }, ...(peticion.clave === undefined ? {} : { clave: claveNueva() }) });
      expect({ clave, campo: nombre, estado: res.status }).not.toEqual({ clave, campo: nombre, estado: 422 });
    }
  });

  it.each(CON_CUERPO())('%s: un campo que el documento no conoce se ignora (la petición de éxito sigue dando su estado)', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const res = await enviar(clave, peticion, { cuerpo: { ...(peticion.cuerpo ?? {}), campo_inventado: 'x', id_usuario: 4242, activa: false } });
    expect({ clave, estado: res.status, cuerpo: res.body }).toEqual({ clave, estado: PRINCIPALES[clave].estado, cuerpo: res.body });
  });

  it('POST /bodegas: los campos que fija el servidor (id_bodega, activa) se ignoran y la bodega nace activa', async () => {
    const res = await enviar('POST /bodegas', { ruta: '/bodegas' }, { cuerpo: { codigo: 'X-1', nombre: 'n', ciudad: 'c', direccion: 'd', activa: false, id_bodega: 4242 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ codigo: 'X-1', activa: true });
    expect(res.body.id_bodega).not.toBe(4242);
  });

  it('POST /internas/saldos/carga-inicial: una fila con un campo inválido NO es 422, se rechaza con un motivo que nombra el campo', async () => {
    const operacion = operacionesPorClave['POST /internas/saldos/carga-inicial'];
    const fila = resolverEsquema(resolverEsquema(esquemaJson(operacion.operacion.requestBody)).properties.filas.items);
    const buena = { id_producto: 25, id_bodega: b1, cantidad: 3, codigo_lote: 'L-X', fecha_vencimiento: '2027-03-01' };
    let n = 0;
    for (const [nombre, propiedad] of Object.entries(fila.properties)) {
      for (const [, valor] of malos(resolverEsquema(propiedad), nombre).filter(([titulo]) => !titulo.includes('null'))) {
        n += 1;
        const res = await enviar('POST /internas/saldos/carga-inicial', { ruta: '/internas/saldos/carga-inicial' }, {
          clave: claveNueva(), cuerpo: { filas: [{ ...buena, [nombre]: valor }] },
        });
        comprobarRespuesta('POST /internas/saldos/carga-inicial', res);
        expect({ campo: nombre, estado: res.status, creados: res.body.creados }).toEqual({ campo: nombre, estado: 200, creados: 0 });
        expect(res.body.rechazados).toEqual([{ fila: 1, motivo: expect.stringContaining(nombre) }]);
      }
    }
    expect(n).toBeGreaterThan(10);
  });
});

describe('conformidad generada: identidad, alcance por bodega y rutas', () => {
  it.each(Object.keys(PRINCIPALES))('%s: las cabeceras de identidad inválidas son 401 y las lecturas sin X-User-Id valen', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const estadoDeExito = PRINCIPALES[clave].estado;
    const exigeUsuario = operacionesPorClave[clave].parametros.find((p) => p.name === 'X-User-Id').required;
    expect(exigeUsuario).toBe(clave.split(' ')[0] !== 'GET'); // lo que el documento dice de la cabecera
    const intentos = [
      ['X-User-Id inválido', { 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }],
      ['X-User-Id cero', { 'X-User-Id': '0', 'X-User-Rol': 'ADMINISTRADOR' }],
      ['X-User-Id negativo', { 'X-User-Id': '-3', 'X-User-Rol': 'ADMINISTRADOR' }],
      ['X-User-Id sobre el INTEGER', { 'X-User-Id': '2147483648', 'X-User-Rol': 'ADMINISTRADOR' }],
      ['X-User-Rol inválido', { 'X-User-Id': '7', 'X-User-Rol': 'SUPERUSUARIO' }],
      ['X-User-Id sin X-User-Rol', { 'X-User-Id': '7' }],
      ['X-User-Bodega inválida', { 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR', 'X-User-Bodega': 'abc' }],
      ['X-User-Bodega cero', { 'X-User-Id': '7', 'X-User-Rol': 'ADMINISTRADOR', 'X-User-Bodega': '0' }],
    ];
    for (const [titulo, cabeceras] of intentos) {
      const res = await enviar(clave, peticion, { cabeceras });
      expect({ clave, titulo, estado: res.status, codigo: res.body.error?.codigo }).toEqual({ clave, titulo, estado: 401, codigo: 'NO_AUTENTICADO' });
      comprobarRespuesta(clave, res);
    }
    const sinIdentidad = await enviar(clave, peticion, { cabeceras: {} });
    if (exigeUsuario) {
      expect({ clave, estado: sinIdentidad.status }).toEqual({ clave, estado: 401 });
      comprobarRespuesta(clave, sinIdentidad);
      const soloRol = await enviar(clave, peticion, { cabeceras: { 'X-User-Rol': 'ADMINISTRADOR' } });
      expect(soloRol.status).toBe(401);
    } else {
      expect({ clave, estado: sinIdentidad.status }).toEqual({ clave, estado: estadoDeExito }); // llamada interna válida
    }
  });

  it.each(Object.keys(PRINCIPALES))('%s: un operador de bodega SIN bodega asignada recibe 403 si y solo si el documento declara 403', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const declara403 = '403' in operacionesPorClave[clave].operacion.responses;
    const res = await enviar(clave, peticion, { cabeceras: headers('OPERADOR_BODEGA') });
    if (declara403) {
      expect({ clave, estado: res.status }).toEqual({ clave, estado: 403 });
      expect(res.body.error.codigo).toBe('SIN_PERMISO');
      comprobarRespuesta(clave, res);
    } else {
      expect({ clave, estado: res.status }).toEqual({ clave, estado: PRINCIPALES[clave].estado });
    }
  });

  const conRutaConId = Object.keys(PRINCIPALES).filter((clave) => operacionesPorClave[clave].parametros.some((p) => p.in === 'path'));
  it.each(conRutaConId)('%s: un {id} que no es un entero positivo (o supera el INTEGER) es 404 NO_EXISTE', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    for (const id of ['abc', '0', '-1', '1.5', '2147483648', '007']) {
      const ruta = peticion.ruta.replace(/\/\d+(?=\/|$)/, `/${id}`);
      expect(ruta).not.toBe(peticion.ruta);
      const res = await enviar(clave, peticion, { ruta });
      expect({ clave, id, estado: res.status, codigo: res.body.error?.codigo }).toEqual({ clave, id, estado: 404, codigo: 'NO_EXISTE' });
      comprobarRespuesta(clave, res);
    }
  });

  it('las rutas que el documento no declara son 404 NO_EXISTE (control: un método no documentado de una ruta documentada también)', async () => {
    for (const [metodo, ruta] of [['delete', '/bodegas/1'], ['patch', '/bodegas/1'], ['put', '/saldos'], ['get', '/bodegas/1/inactivar'], ['post', '/lotes'], ['get', '/internas/saldos/carga-inicial']]) {
      const res = await request[metodo](ruta).set(ADM);
      expect({ metodo, ruta, estado: res.status, codigo: res.body.error?.codigo }).toEqual({ metodo, ruta, estado: 404, codigo: 'NO_EXISTE' });
    }
  });
});

describe('conformidad generada: Idempotency-Key', () => {
  const conClave = Object.keys(PRINCIPALES).filter((clave) => operacionesPorClave[clave].parametros.some((p) => p.name === 'Idempotency-Key'));

  it('son las cinco operaciones de escritura de stock (control)', () => {
    expect(conClave.sort()).toEqual(['POST /conteos/{id}/aprobacion', 'POST /internas/saldos/carga-inicial', 'POST /movimientos', 'POST /traslados', 'POST /traslados/{id}/recepcion']);
  });

  it.each(conClave)('%s: sin la cabecera, vacía, con #, o de más de 200 caracteres es 400; de exactamente 200 caracteres vale', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const maximo = operacionesPorClave[clave].parametros.find((p) => p.name === 'Idempotency-Key').schema.maxLength;
    expect(maximo).toBe(200);
    const sin = { ...peticion };
    delete sin.clave;
    const intentos = [
      ['sin la cabecera', await enviar(clave, sin)],
      ['vacía', await enviar(clave, peticion, { clave: '' })],
      ['solo espacios', await enviar(clave, peticion, { clave: '   ' })],
      ['con #', await enviar(clave, peticion, { clave: 'abc#1' })],
      [`de ${maximo + 1} caracteres`, await enviar(clave, peticion, { clave: 'k'.repeat(maximo + 1) })],
    ];
    for (const [titulo, res] of intentos) {
      expect({ clave, titulo, estado: res.status, codigo: res.body.error?.codigo }).toEqual({ clave, titulo, estado: 400, codigo: 'PETICION_MAL_FORMADA' });
      comprobarRespuesta(clave, res);
    }
    const justa = await enviar(clave, peticion, { clave: 'k'.repeat(maximo) });
    expect({ clave, estado: justa.status }).toEqual({ clave, estado: PRINCIPALES[clave].estado });
  });

  it.each(['POST /movimientos', 'POST /traslados'])('%s: la repetición con la misma clave del mismo usuario da 200 y no repite la operación; con otro usuario no es una repetición', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const primera = await enviar(clave, peticion);
    expect(primera.status).toBe(201);
    const repetida = await enviar(clave, peticion);
    expect(repetida.status).toBe(200);
    comprobarRespuesta(clave, repetida);
    const idDeLaPrimera = primera.body.id_movimiento ?? primera.body.movimiento.id_movimiento;
    expect(repetida.body.id_movimiento ?? repetida.body.movimiento.id_movimiento).toBe(idDeLaPrimera);
    expect(await db('movimientos').count({ n: '*' }).then(([{ n }]) => Number(n))).toBe(1); // un solo movimiento: el de la primera petición
    const otroUsuario = await enviar(clave, peticion, { cabeceras: headers('ADMINISTRADOR', { idUsuario: 8 }) });
    expect(otroUsuario.status).toBe(201); // otra clave almacenada: se ejecuta
  });
});

describe('conformidad generada: límites del cuerpo', () => {
  // Un cuerpo JSON de EXACTAMENTE `bytes` bytes: `{"relleno":"aaa…"}`, o con un prefijo de campos (para la carga inicial).
  function cuerpoDeBytes(bytes, prefijo = '') {
    const apertura = `{${prefijo}"relleno":"`;
    const cierre = '"}';
    return `${apertura}${'a'.repeat(bytes - Buffer.byteLength(apertura) - Buffer.byteLength(cierre))}${cierre}`;
  }

  it.each(CON_CUERPO().filter((clave) => clave !== 'POST /internas/saldos/carga-inicial'))('%s: admite hasta 100 kB (el límite documentado) y por encima responde 413 PETICION_MAL_FORMADA', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const nueva = () => (peticion.clave === undefined ? {} : { clave: claveNueva() });
    const justo = await enviar(clave, peticion, { cuerpoCrudo: cuerpoDeBytes(LIMITE_GENERAL()), ...nueva() });
    expect({ clave, bytes: LIMITE_GENERAL(), estado: justo.status }).not.toEqual({ clave, bytes: LIMITE_GENERAL(), estado: 413 });
    const pasado = await enviar(clave, peticion, { cuerpoCrudo: cuerpoDeBytes(LIMITE_GENERAL() + 1), ...nueva() });
    expect({ clave, bytes: LIMITE_GENERAL() + 1, estado: pasado.status, codigo: pasado.body.error?.codigo }).toEqual({ clave, bytes: LIMITE_GENERAL() + 1, estado: 413, codigo: 'PETICION_MAL_FORMADA' });
    comprobarRespuesta(clave, pasado);
  });

  it('POST /internas/saldos/carga-inicial: admite hasta 1 MB (el límite documentado), por encima responde 413, y entre 100 kB y 1 MB es válido', async () => {
    const limiteCarga = operacionesPorClave['POST /internas/saldos/carga-inicial'].operacion.requestBody['x-tamano-maximo-cuerpo-bytes'];
    const peticion = await PRINCIPALES['POST /internas/saldos/carga-inicial'].preparar();
    const prefijo = '"filas":[1],'; // una fila inválida: se rechaza sin tocar la base
    const justo = await enviar('POST /internas/saldos/carga-inicial', peticion, { clave: claveNueva(), cuerpoCrudo: cuerpoDeBytes(limiteCarga, prefijo) });
    expect({ estado: justo.status, cuerpo: justo.body }).toEqual({ estado: 200, cuerpo: { creados: 0, rechazados: [{ fila: 1, motivo: expect.any(String) }] } });
    const pasado = await enviar('POST /internas/saldos/carga-inicial', peticion, { clave: claveNueva(), cuerpoCrudo: cuerpoDeBytes(limiteCarga + 1, prefijo) });
    expect({ estado: pasado.status, codigo: pasado.body.error?.codigo }).toEqual({ estado: 413, codigo: 'PETICION_MAL_FORMADA' });
    comprobarRespuesta('POST /internas/saldos/carga-inicial', pasado);
    const medio = await enviar('POST /internas/saldos/carga-inicial', peticion, { clave: claveNueva(), cuerpoCrudo: cuerpoDeBytes(LIMITE_GENERAL() + 1, prefijo) });
    expect(medio.status).toBe(200);
  });

  it.each(CON_CUERPO())('%s: un JSON mal formado es 400 y una codificación que no es UTF-8 es 415, los dos PETICION_MAL_FORMADA', async (clave) => {
    const peticion = await PRINCIPALES[clave].preparar();
    const nueva = peticion.clave === undefined ? {} : { clave: claveNueva() };
    const malo = await enviar(clave, peticion, { cuerpoCrudo: '{"a":', ...nueva });
    expect({ clave, estado: malo.status, codigo: malo.body.error?.codigo }).toEqual({ clave, estado: 400, codigo: 'PETICION_MAL_FORMADA' });
    comprobarRespuesta(clave, malo);
    const latin = await enviar(clave, peticion, { cuerpoCrudo: '{}', tipoContenido: 'application/json; charset=iso-8859-1', ...nueva });
    expect({ clave, estado: latin.status, codigo: latin.body.error?.codigo }).toEqual({ clave, estado: 415, codigo: 'PETICION_MAL_FORMADA' });
    comprobarRespuesta(clave, latin);
  });
});

describe('conformidad: lo que los escenarios ejercitaron de cada esquema', () => {
  // Todos los esquemas (y los de adentro) a los que llegan las respuestas del documento, siguiendo las referencias, cada uno con su
  // lugar (`Movimiento.id_lote`) para que un fallo diga de qué campo habla.
  function esquemasDeRespuesta() {
    const vistos = new Set();
    const lista = [];
    const visitar = (esquema, donde) => {
      if (!esquema || typeof esquema !== 'object') return;
      if (esquema.$ref) {
        const nombre = esquema.$ref.split('/').pop();
        const destino = documento.components.schemas[nombre];
        if (!vistos.has(destino)) { vistos.add(destino); visitar(destino, nombre); }
        return;
      }
      lista.push({ donde, esquema });
      for (const [propiedad, hija] of Object.entries(esquema.properties ?? {})) visitar(hija, `${donde}.${propiedad}`);
      visitar(esquema.items, `${donde}[]`);
    };
    for (const { clave, operacion } of operaciones(documento)) {
      for (const declarada of Object.values(operacion.responses)) visitar(esquemaJson(declarada.$ref ? documento.components.responses[declarada.$ref.split('/').pop()] : declarada), `${clave} (respuesta)`);
    }
    return lista;
  }

  it('todo campo anulable de una respuesta se vio con valor y con null (si no, el esquema no está comprobado en uno de sus estados)', () => {
    const anulables = esquemasDeRespuesta().filter(({ esquema }) => esquema.nullable === true);
    expect(anulables.length).toBeGreaterThanOrEqual(15); // control: los campos anulables de movimientos, lotes, traslados y conteos
    const sinVer = anulables.filter(({ esquema }) => !(nulos.get(esquema)?.nulo && nulos.get(esquema)?.noNulo));
    expect(sinVer.map(({ donde, esquema }) => ({ donde, visto: nulos.get(esquema) ?? 'nunca' }))).toEqual([]);
  });

  it('todo campo opcional de una respuesta se vio presente y ausente', () => {
    const objetos = esquemasDeRespuesta().map(({ esquema }) => esquema).filter((esquema) => esquema.type === 'object' && esquema.properties);
    const faltan = [];
    let opcionalesVistos = 0;
    for (const esquema of objetos) {
      for (const nombre of Object.keys(esquema.properties).filter((propiedad) => !(esquema.required ?? []).includes(propiedad))) {
        opcionalesVistos += 1;
        const visto = opcionales.get(esquema)?.get(nombre);
        if (!(visto?.presente && visto?.ausente)) faltan.push({ campo: nombre, visto: visto ?? 'nunca' });
      }
    }
    expect(opcionalesVistos).toBe(3); // meta.cantidad_total, disponible y solicitado
    expect(faltan).toEqual([]);
  });
});
