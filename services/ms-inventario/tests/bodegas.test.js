const supertest = require('supertest');
const { createApp } = require('../src/app');
const { buildTestApp, entornoValido } = require('./helpers/app');
const { truncateAll } = require('./helpers/db');
const { crearBodega, headers } = require('./helpers/fixtures');

// Gestión de bodegas (RF05): las seis operaciones de la Tabla 9 de la Entrega 2, contra PostgreSQL real.
// Las pruebas de cada capa por separado están en bodegasCapas.test.js y la lista de rutas en routes.test.js.

const ADM = headers('ADMINISTRADOR');
const BODEGA = { codigo: 'MZL', nombre: 'Principal', ciudad: 'Manizales', direccion: 'Cra 1' };
const CLAVES = ['id_bodega', 'codigo', 'nombre', 'ciudad', 'direccion', 'activa'];
// Largos exactos de las columnas (migración 20261103000100); más abajo se comprueba contra la base real.
const LARGOS = { codigo: 30, nombre: 100, ciudad: 100, direccion: 255 };
const NO_TEXTOS = [['un número', 123], ['un arreglo', ['a']], ['un objeto', { a: 1 }], ['null', null], ['un booleano', true]];

const texto = /\S/;

let request;
let db;

beforeAll(() => {
  ({ request, db } = buildTestApp());
});
beforeEach(() => truncateAll(db));
afterAll(() => db.destroy());

const filas = () => db('bodegas').select('*').orderBy('id_bodega');

// Forma exacta del cuerpo de error común: {"error": {"codigo", "mensaje", "detalles"}}.
function esError(res, status, codigo, campos = []) {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({
    error: { codigo, mensaje: expect.stringMatching(texto), detalles: campos.map((campo) => ({ campo, mensaje: expect.stringMatching(texto) })) },
  });
}
const datosNoValidos = (res, campos) => esError(res, 422, 'DATOS_NO_VALIDOS', campos);
// 404 NO_EXISTE de un RECURSO: un id inexistente o inválido. Se distingue del 404 de una ruta que no está montada
// (rutaNoEncontrada: "La ruta solicitada no existe"), que sin esto haría pasar las pruebas aunque no hubiera rutas.
function recursoNoExiste(res) {
  esError(res, 404, 'NO_EXISTE');
  expect(res.body.error.mensaje).not.toBe('La ruta solicitada no existe');
}

// Crea una bodega por la API (con otro código que BODEGA) y exige el 201: control positivo antes de cada rechazo.
async function control(codigo = 'CTL') {
  const res = await request.post('/bodegas').set(ADM).send({ ...BODEGA, codigo });
  expect(res.status).toBe(201);
  return res.body;
}

// Un cuerpo de bodega con `campo` en `valor` y sin ningún otro problema.
const con = (campo, valor) => ({ ...BODEGA, [campo]: valor });

describe('POST /bodegas', () => {
  it('(ADM) → 201 con la bodega activa y exactamente sus seis campos; queda guardada', async () => {
    const res = await request.post('/bodegas').set(ADM).send(BODEGA);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id_bodega: expect.any(Number), ...BODEGA, activa: true });
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES].sort());
    expect(await filas()).toEqual([res.body]);
  });

  it('descarta lo que el cliente no puede fijar: `activa` e `id_bodega` del cuerpo no se aplican', async () => {
    const res = await request.post('/bodegas').set(ADM).send({ ...BODEGA, activa: false, id_bodega: 99, otro: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.activa).toBe(true);
    expect(res.body.id_bodega).not.toBe(99);
    expect(res.body).not.toHaveProperty('otro');
    const guardadas = await filas();
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toMatchObject({ activa: true });
    expect(guardadas[0].id_bodega).not.toBe(99);
  });

  it('recorta los espacios de los extremos y guarda el texto recortado', async () => {
    const res = await request.post('/bodegas').set(ADM).send({ codigo: '  MZL ', nombre: ' Principal', ciudad: 'Manizales  ', direccion: '\tCra 1\n' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(BODEGA);
    expect(await filas()).toEqual([expect.objectContaining(BODEGA)]);
  });

  it('con un codigo repetido → 409 CODIGO_DUPLICADO y no se crea otra bodega', async () => {
    await control('MZL');
    const res = await request.post('/bodegas').set(ADM).send({ ...BODEGA, nombre: 'Otra' });
    esError(res, 409, 'CODIGO_DUPLICADO');
    const guardadas = await filas();
    expect(guardadas).toHaveLength(1);
    // La bodega original no se tocó: el intento duplicado (nombre "Otra") no la sobrescribió.
    expect(guardadas[0].nombre).toBe('Principal');
  });

  it('dos altas simultáneas con el mismo codigo: exactamente una gana (201) y la otra es 409 CODIGO_DUPLICADO, nunca un 500', async () => {
    const respuestas = await Promise.all(Array.from({ length: 6 }, () => request.post('/bodegas').set(ADM).send(BODEGA)));
    expect(respuestas.filter((res) => res.status === 201)).toHaveLength(1);
    const perdedoras = respuestas.filter((res) => res.status !== 201);
    expect(perdedoras).toHaveLength(5);
    for (const res of perdedoras) esError(res, 409, 'CODIGO_DUPLICADO');
    expect(await filas()).toHaveLength(1);
  });

  it('el codigo se compara ya recortado: " MZL" repite a "MZL"', async () => {
    await control('MZL');
    esError(await request.post('/bodegas').set(ADM).send(con('codigo', '  MZL  ')), 409, 'CODIGO_DUPLICADO');
    expect(await filas()).toHaveLength(1);
  });

  it('el codigo distingue mayúsculas (el contrato no dice otra cosa y la columna es única sin normalizar): "mzl" y "MZL" coexisten', async () => {
    await control('MZL');
    const res = await request.post('/bodegas').set(ADM).send(con('codigo', 'mzl'));
    expect(res.status).toBe(201);
    expect((await filas()).map((fila) => fila.codigo)).toEqual(['MZL', 'mzl']);
  });

  it('un codigo repetido de una bodega inactiva también es 409: el código no se libera al inactivar', async () => {
    await crearBodega(db, { codigo: 'MZL', activa: false });
    esError(await request.post('/bodegas').set(ADM).send(BODEGA), 409, 'CODIGO_DUPLICADO');
    expect(await filas()).toHaveLength(1);
  });

  it('sin nombre → 422 con detalles[0].campo === "nombre" y nada guardado', async () => {
    await control();
    const { nombre: _nombre, ...sinNombre } = BODEGA;
    const res = await request.post('/bodegas').set(ADM).send(sinNombre);
    datosNoValidos(res, ['nombre']);
    expect(res.body.error.detalles[0].campo).toBe('nombre');
    expect(await filas()).toHaveLength(1);
  });

  it.each(Object.keys(LARGOS))('sin %s → 422 sobre ese campo', async (campo) => {
    await control();
    const cuerpo = { ...BODEGA };
    delete cuerpo[campo];
    datosNoValidos(await request.post('/bodegas').set(ADM).send(cuerpo), [campo]);
    expect(await filas()).toHaveLength(1);
  });

  it('informa TODOS los campos inválidos a la vez, en el orden del contrato', async () => {
    await control();
    const res = await request.post('/bodegas').set(ADM).send({ codigo: 5, nombre: '', ciudad: null });
    datosNoValidos(res, ['codigo', 'nombre', 'ciudad', 'direccion']);
    expect(res.body.error.detalles.map((detalle) => detalle.campo)).toEqual(['codigo', 'nombre', 'ciudad', 'direccion']);
  });

  it('un cuerpo vacío {} → 422 con los cuatro campos obligatorios', async () => {
    await control();
    datosNoValidos(await request.post('/bodegas').set(ADM).send({}), ['codigo', 'nombre', 'ciudad', 'direccion']);
    expect(await filas()).toHaveLength(1);
  });

  it('sin cuerpo (req.body queda undefined en Express 5) → 422 con los cuatro campos, no un 500', async () => {
    await control();
    datosNoValidos(await request.post('/bodegas').set(ADM), ['codigo', 'nombre', 'ciudad', 'direccion']);
    expect(await filas()).toHaveLength(1);
  });

  it('con Content-Type que no es JSON (text/plain) el cuerpo no se lee → 422 con los cuatro campos, no un 500', async () => {
    await control();
    const res = await request.post('/bodegas').set(ADM).set('Content-Type', 'text/plain').send(JSON.stringify(BODEGA));
    datosNoValidos(res, ['codigo', 'nombre', 'ciudad', 'direccion']);
    expect(await filas()).toHaveLength(1);
  });

  it.each([['arreglo vacío', []], ['arreglo con un objeto', [BODEGA]]])('un cuerpo que es un %s → 422 sobre "cuerpo"', async (_descripcion, cuerpo) => {
    await control();
    datosNoValidos(await request.post('/bodegas').set(ADM).send(cuerpo), ['cuerpo']);
    expect(await filas()).toHaveLength(1);
  });

  it('un JSON mal formado → 400 PETICION_MAL_FORMADA', async () => {
    await control();
    const res = await request.post('/bodegas').set(ADM).set('Content-Type', 'application/json').send('{"codigo": ');
    esError(res, 400, 'PETICION_MAL_FORMADA');
    expect(await filas()).toHaveLength(1);
  });

  describe.each(Object.keys(LARGOS))('el campo %s', (campo) => {
    const max = LARGOS[campo];

    it.each(NO_TEXTOS)('con %s → 422 sobre ese campo (no un 500)', async (_descripcion, valor) => {
      await control();
      datosNoValidos(await request.post('/bodegas').set(ADM).send(con(campo, valor)), [campo]);
      expect(await filas()).toHaveLength(1);
    });

    it.each([['vacío', ''], ['solo espacios', '   ']])('%s → 422 sobre ese campo', async (_descripcion, valor) => {
      await control();
      datosNoValidos(await request.post('/bodegas').set(ADM).send(con(campo, valor)), [campo]);
      expect(await filas()).toHaveLength(1);
    });

    it(`acepta ${max} caracteres (el largo exacto de la columna) y rechaza ${max + 1} con 422, nunca un 500`, async () => {
      const exacto = 'x'.repeat(max);
      const aceptado = await request.post('/bodegas').set(ADM).send(con(campo, exacto));
      expect(aceptado.status).toBe(201);
      expect(aceptado.body[campo]).toBe(exacto);
      // La siguiente lleva otro codigo (el exacto ya está tomado cuando el campo es `codigo`).
      const largo = await request.post('/bodegas').set(ADM).send({ ...BODEGA, codigo: 'OTRO', [campo]: 'x'.repeat(max + 1) });
      datosNoValidos(largo, [campo]);
      expect(await filas()).toHaveLength(1);
    });

    it('rechaza el carácter nulo con 422 (PostgreSQL lo rechazaría con 22021 y sería un 500)', async () => {
      await control();
      datosNoValidos(await request.post('/bodegas').set(ADM).send(con(campo, 'a\u0000b')), [campo]);
      expect(await filas()).toHaveLength(1);
    });

    it('rechaza un sustituto UTF-16 suelto con 422: sin esto la base lo guardaría como U+FFFD sin avisar', async () => {
      await control();
      // Se escribe con el escape \ud800 dentro del JSON: ningún cliente serializa un sustituto suelto, pero el JSON lo admite.
      const cuerpo = JSON.stringify(con(campo, 'a#b')).replace('#', '\\ud800');
      const res = await request.post('/bodegas').set(ADM).set('Content-Type', 'application/json').send(cuerpo);
      datosNoValidos(res, [campo]);
      expect(await filas()).toHaveLength(1);
    });
  });

  it('cuenta caracteres y no unidades UTF-16: 30 emojis caben en el codigo (varchar(30)) y 31 no', async () => {
    const aceptado = await request.post('/bodegas').set(ADM).send(con('codigo', '😀'.repeat(30)));
    expect(aceptado.status).toBe(201);
    expect(aceptado.body.codigo).toBe('😀'.repeat(30));
    datosNoValidos(await request.post('/bodegas').set(ADM).send(con('codigo', '😀'.repeat(31))), ['codigo']);
    expect(await filas()).toHaveLength(1);
  });

  it('los largos de este archivo son los de las columnas de la base (si cambia la migración, esta prueba avisa)', async () => {
    const { rows } = await db.raw(
      "SELECT column_name, character_maximum_length FROM information_schema.columns WHERE table_name = 'bodegas' AND data_type = 'character varying'",
    );
    expect(Object.fromEntries(rows.map((fila) => [fila.column_name, fila.character_maximum_length]))).toEqual(LARGOS);
  });
});

describe('identidad en las escrituras (D8, D20, D22)', () => {
  it('sin X-User-Id → 401 NO_AUTENTICADO y no se crea nada; con él, 201', async () => {
    expect((await request.post('/bodegas').set(ADM).send(BODEGA)).status).toBe(201);
    await truncateAll(db);
    const { 'X-User-Id': _usuario, ...sinUsuario } = ADM;
    esError(await request.post('/bodegas').set(sinUsuario).send(BODEGA), 401, 'NO_AUTENTICADO');
    expect(await filas()).toHaveLength(0);
  });

  it('sin ninguna cabecera de identidad → 401', async () => {
    esError(await request.post('/bodegas').send(BODEGA), 401, 'NO_AUTENTICADO');
    expect(await filas()).toHaveLength(0);
  });

  it('la identidad se exige ANTES de validar el cuerpo: sin X-User-Id y con un cuerpo inválido → 401, no 422', async () => {
    await control();
    esError(await request.post('/bodegas').send({ codigo: 5 }), 401, 'NO_AUTENTICADO');
  });

  it.each([
    ['X-User-Id no numérico', { 'X-User-Id': 'abc' }],
    ['X-User-Id cero', { 'X-User-Id': '0' }],
    ['X-User-Id negativo', { 'X-User-Id': '-1' }],
    ['X-User-Id decimal', { 'X-User-Id': '1.5' }],
    ['X-User-Id vacío', { 'X-User-Id': '' }],
    ['X-User-Id mayor que el INTEGER', { 'X-User-Id': '2147483648' }],
    ['X-User-Rol desconocido', { 'X-User-Rol': 'SUPERADMIN' }],
    ['X-User-Bodega no numérica', { 'X-User-Bodega': 'abc' }],
  ])('%s → 401 NO_AUTENTICADO y no se crea nada', async (_descripcion, cabecera) => {
    expect((await request.post('/bodegas').set(ADM).send(con('codigo', 'CTL'))).status).toBe(201);
    esError(await request.post('/bodegas').set({ ...ADM, ...cabecera }).send(BODEGA), 401, 'NO_AUTENTICADO');
    expect(await filas()).toHaveLength(1);
  });

  it('X-User-Id sin X-User-Rol → 401', async () => {
    expect((await request.post('/bodegas').set(ADM).send(con('codigo', 'CTL'))).status).toBe(201);
    esError(await request.post('/bodegas').set({ 'X-User-Id': '7' }).send(BODEGA), 401, 'NO_AUTENTICADO');
    expect(await filas()).toHaveLength(1);
  });
});

describe('GET /bodegas', () => {
  it('lista todas (activas e inactivas), ordenadas por id_bodega, con el envoltorio paginado y los seis campos', async () => {
    // Códigos en orden alfabético inverso al de los ids: ordenar por codigo o nombre daría otra secuencia.
    await crearBodega(db, { codigo: 'Z1' });
    await crearBodega(db, { codigo: 'A1', activa: false });
    await crearBodega(db, { codigo: 'M1' });
    const res = await request.get('/bodegas').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
    expect(res.body.datos.map((bodega) => bodega.codigo)).toEqual(['Z1', 'A1', 'M1']);
    expect(res.body.datos.map((bodega) => bodega.id_bodega)).toEqual([1, 2, 3]);
    expect(res.body.datos.map((bodega) => bodega.activa)).toEqual([true, false, true]);
    for (const bodega of res.body.datos) expect(Object.keys(bodega).sort()).toEqual([...CLAVES].sort());
    expect(res.body.datos[0]).toEqual({ id_bodega: 1, codigo: 'Z1', nombre: 'Bodega Z1', ciudad: 'Manizales', direccion: 'Calle Z1', activa: true });
  });

  it('el orden es por id_bodega aunque se hayan modificado filas (un UPDATE reubica la fila en la tabla de PostgreSQL)', async () => {
    const primera = await crearBodega(db, { codigo: 'P1' });
    await crearBodega(db, { codigo: 'P2' });
    await crearBodega(db, { codigo: 'P3' });
    // Sin ORDER BY, la fila actualizada saldría al final: [2, 3, 1].
    expect((await request.post(`/bodegas/${primera.id_bodega}/inactivar`).set(ADM)).status).toBe(200);
    const res = await request.get('/bodegas').set(ADM);
    expect(res.body.datos.map((bodega) => bodega.id_bodega)).toEqual([1, 2, 3]);
    const pagina2 = await request.get('/bodegas').query({ pagina: 2, por_pagina: 2 }).set(ADM);
    expect(pagina2.body.datos.map((bodega) => bodega.id_bodega)).toEqual([3]);
  });

  it('sin bodegas → {datos: [], meta: {pagina: 1, por_pagina: 20, total: 0}} con total numérico', async () => {
    const res = await request.get('/bodegas').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ datos: [], meta: { pagina: 1, por_pagina: 20, total: 0 } });
  });

  describe('?activa', () => {
    beforeEach(async () => {
      for (const [codigo, activa] of [['B1', true], ['B2', false], ['B3', true], ['B4', false], ['B5', false]]) {
        await crearBodega(db, { codigo, activa });
      }
    });

    it('?activa=false lista solo las inactivas, con envoltorio paginado y meta.total = las inactivas', async () => {
      const res = await request.get('/bodegas').query({ activa: 'false' }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.datos.map((bodega) => bodega.codigo)).toEqual(['B2', 'B4', 'B5']);
      expect(res.body.datos.every((bodega) => bodega.activa === false)).toBe(true);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 3 });
    });

    it('?activa=true lista solo las activas', async () => {
      const res = await request.get('/bodegas').query({ activa: 'true' }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.datos.map((bodega) => bodega.codigo)).toEqual(['B1', 'B3']);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 20, total: 2 });
    });

    it('sin ?activa no filtra: las cinco', async () => {
      const res = await request.get('/bodegas').set(ADM);
      expect(res.body.meta.total).toBe(5);
      expect(res.body.datos).toHaveLength(5);
    });

    it.each(['quizas', 'TRUE', '1', '0', '', 'si'])('?activa=%p → 422 sobre "activa"', async (valor) => {
      expect((await request.get('/bodegas').query({ activa: 'true' }).set(ADM)).status).toBe(200);
      datosNoValidos(await request.get('/bodegas').query({ activa: valor }).set(ADM), ['activa']);
    });

    it('?activa repetido (arreglo) → 422 sobre "activa", no un 500', async () => {
      datosNoValidos(await request.get('/bodegas?activa=true&activa=false').set(ADM), ['activa']);
    });
  });

  describe('paginación (la usa ms-reportes: pide por_pagina=100 y se detiene cuando pagina * por_pagina >= meta.total)', () => {
    // Recorre el listado con la regla literal del consumidor. Corta si no termina, para que un fallo no cuelgue la prueba.
    async function recorrer(query, porPagina) {
      const paginas = [];
      for (let pagina = 1; pagina <= 20; pagina += 1) {
        const res = await request.get('/bodegas').query({ ...query, pagina, por_pagina: porPagina }).set(ADM);
        expect(res.status).toBe(200);
        paginas.push(res.body);
        if (pagina * porPagina >= res.body.meta.total) return paginas;
      }
      throw new Error('El recorrido no termina: meta.total nunca alcanzó pagina * por_pagina');
    }

    beforeEach(async () => {
      for (const [codigo, activa] of [['E', true], ['D', false], ['C', true], ['B', false], ['A', true]]) {
        await crearBodega(db, { codigo, activa });
      }
    });

    it('dos páginas o más con por_pagina pequeño: la unión es exactamente lo sembrado, sin repetidos ni saltos, en orden de id', async () => {
      const paginas = await recorrer({}, 2);
      expect(paginas).toHaveLength(3);
      expect(paginas.map((pagina) => pagina.datos.length)).toEqual([2, 2, 1]);
      const ids = paginas.flatMap((pagina) => pagina.datos.map((bodega) => bodega.id_bodega));
      expect(ids).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(paginas.flatMap((pagina) => pagina.datos.map((bodega) => bodega.codigo))).toEqual(['E', 'D', 'C', 'B', 'A']);
    });

    it('meta.total es el de TODAS las filas (un número exacto) en cada página; no el tamaño de la página', async () => {
      for (const pagina of await recorrer({}, 2)) {
        expect(pagina.meta.total).toBe(5);
        expect(typeof pagina.meta.total).toBe('number');
      }
      const primera = (await request.get('/bodegas').query({ por_pagina: 2 }).set(ADM)).body;
      expect(primera.datos).toHaveLength(2);
      expect(primera.meta).toEqual({ pagina: 1, por_pagina: 2, total: 5 });
    });

    it('meta devuelve la página y el por_pagina pedidos', async () => {
      const res = await request.get('/bodegas').query({ pagina: 2, por_pagina: 2 }).set(ADM);
      expect(res.body.meta).toEqual({ pagina: 2, por_pagina: 2, total: 5 });
      expect(res.body.datos.map((bodega) => bodega.id_bodega)).toEqual([3, 4]);
    });

    it('con ?activa el recorrido cubre solo las filtradas y meta.total es el de las filtradas', async () => {
      const paginas = await recorrer({ activa: 'false' }, 1);
      expect(paginas.map((pagina) => pagina.meta.total)).toEqual([2, 2]);
      expect(paginas.flatMap((pagina) => pagina.datos.map((bodega) => bodega.codigo))).toEqual(['D', 'B']);
      const activas = await recorrer({ activa: 'true' }, 2);
      expect(activas.flatMap((pagina) => pagina.datos.map((bodega) => bodega.codigo))).toEqual(['E', 'C', 'A']);
    });

    it('una página fuera de rango → 200 con datos vacíos y el total exacto (no 0)', async () => {
      const res = await request.get('/bodegas').query({ pagina: 99, por_pagina: 2 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ datos: [], meta: { pagina: 99, por_pagina: 2, total: 5 } });
    });

    it('la página más alta que admite la validación (2147483647) no rompe el OFFSET de la base: 200 con datos vacíos y el total exacto', async () => {
      for (const porPagina of [100, 1]) {
        const res = await request.get('/bodegas').query({ pagina: 2147483647, por_pagina: porPagina }).set(ADM);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ datos: [], meta: { pagina: 2147483647, por_pagina: porPagina, total: 5 } });
      }
    });

    it('por_pagina=100 (lo que pide ms-reportes) devuelve todas en una sola página', async () => {
      const res = await request.get('/bodegas').query({ pagina: 1, por_pagina: 100 }).set(ADM);
      expect(res.status).toBe(200);
      expect(res.body.datos).toHaveLength(5);
      expect(res.body.meta).toEqual({ pagina: 1, por_pagina: 100, total: 5 });
    });

    it.each([
      ['por_pagina=0', { por_pagina: '0' }, ['por_pagina']],
      ['por_pagina=101', { por_pagina: '101' }, ['por_pagina']],
      ['por_pagina=abc', { por_pagina: 'abc' }, ['por_pagina']],
      ['pagina=0', { pagina: '0' }, ['pagina']],
      ['pagina=-1', { pagina: '-1' }, ['pagina']],
      ['pagina=0 y por_pagina=500', { pagina: '0', por_pagina: '500' }, ['pagina', 'por_pagina']],
      ['activa=quizas, pagina=0 y por_pagina=500', { activa: 'quizas', pagina: '0', por_pagina: '500' }, ['activa', 'pagina', 'por_pagina']],
    ])('%s → 422 con todos los parámetros inválidos', async (_descripcion, query, campos) => {
      expect((await request.get('/bodegas').query({ por_pagina: '100' }).set(ADM)).status).toBe(200);
      datosNoValidos(await request.get('/bodegas').query(query).set(ADM), campos);
    });
  });

  describe('lecturas sin X-User-Id (llamadas internas válidas, D8)', () => {
    it('GET /bodegas sin cabeceras de identidad → 200 (ms-reportes y las tareas programadas no mandan X-User-Id)', async () => {
      await crearBodega(db, { codigo: 'B1' });
      const res = await request.get('/bodegas').query({ pagina: 1, por_pagina: 100 }).set('X-Request-Id', 'reportes-1');
      expect(res.status).toBe(200);
      expect(res.body.datos).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
    });

    it.each(['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'])('un %s puede listar', async (rol) => {
      await crearBodega(db, { codigo: 'B1' });
      const res = await request.get('/bodegas').set(headers(rol, { idBodega: rol === 'OPERADOR_BODEGA' ? 1 : undefined }));
      expect(res.status).toBe(200);
      expect(res.body.datos).toHaveLength(1);
    });

    it('con una cabecera de identidad inválida la lectura sí es 401 (nunca se ignora en silencio)', async () => {
      expect((await request.get('/bodegas').set(ADM)).status).toBe(200);
      esError(await request.get('/bodegas').set({ 'X-User-Id': 'abc', 'X-User-Rol': 'ADMINISTRADOR' }), 401, 'NO_AUTENTICADO');
    });
  });
});

describe('GET /bodegas/:id', () => {
  it('→ 200 con la bodega y exactamente sus seis campos', async () => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    const res = await request.get(`/bodegas/${creada.id_bodega}`).set(ADM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_bodega: creada.id_bodega, codigo: 'B1', nombre: 'Bodega B1', ciudad: 'Manizales', direccion: 'Calle B1', activa: true });
    expect(Object.keys(res.body).sort()).toEqual([...CLAVES].sort());
  });

  it('una bodega inactiva también se consulta: se da de baja, no se borra', async () => {
    const inactiva = await crearBodega(db, { codigo: 'B1', activa: false });
    const res = await request.get(`/bodegas/${inactiva.id_bodega}`).set(ADM);
    expect(res.status).toBe(200);
    expect(res.body.activa).toBe(false);
  });

  it('GET /bodegas/999 → 404 NO_EXISTE', async () => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    expect((await request.get(`/bodegas/${creada.id_bodega}`).set(ADM)).status).toBe(200);
    recursoNoExiste(await request.get('/bodegas/999').set(ADM));
  });

  it.each(['abc', '0', '-1', '1.5', '07', '1e3', '2147483648', '99999999999', '99999999999999999999'])(
    'el id %p → 404 NO_EXISTE (nunca llega a la base ni da un 500)',
    async (id) => {
      const creada = await crearBodega(db, { codigo: 'B1' });
      expect((await request.get(`/bodegas/${creada.id_bodega}`).set(ADM)).status).toBe(200);
      recursoNoExiste(await request.get(`/bodegas/${id}`).set(ADM));
    },
  );

  it('el id más alto que cabe en el INTEGER (2147483647) llega a la base y es 404, no un 500', async () => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    expect((await request.get(`/bodegas/${creada.id_bodega}`).set(ADM)).status).toBe(200);
    recursoNoExiste(await request.get('/bodegas/2147483647').set(ADM));
  });

  it('un id con un escape de porcentaje inválido (%ZZ) → 400 PETICION_MAL_FORMADA de Express, nunca un 500', async () => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    expect((await request.get(`/bodegas/${creada.id_bodega}`).set(ADM)).status).toBe(200);
    esError(await request.get('/bodegas/%ZZ').set(ADM), 400, 'PETICION_MAL_FORMADA');
  });

  it('un id escrito con escapes válidos (%31 = "1") es el mismo recurso', async () => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    expect(creada.id_bodega).toBe(1);
    const res = await request.get('/bodegas/%31').set(ADM);
    expect(res.status).toBe(200);
    expect(res.body.id_bodega).toBe(1);
  });

  it('sin X-User-Id → 200 (lectura interna)', async () => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    const res = await request.get(`/bodegas/${creada.id_bodega}`);
    expect(res.status).toBe(200);
    expect(res.body.codigo).toBe('B1');
  });
});

describe('PUT /bodegas/:id', () => {
  const NUEVOS = { nombre: 'Nuevo nombre', ciudad: 'Pereira', direccion: 'Calle 9 # 8-7' };
  let bodega;

  beforeEach(async () => {
    bodega = await crearBodega(db, { codigo: 'MZL' });
  });

  const put = (id, cuerpo, cabeceras = ADM) => request.put(`/bodegas/${id}`).set(cabeceras).send(cuerpo);

  it('cambia nombre, ciudad y direccion pero no el codigo (el codigo del cuerpo se ignora)', async () => {
    const res = await put(bodega.id_bodega, { ...NUEVOS, codigo: 'X' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_bodega: bodega.id_bodega, codigo: 'MZL', ...NUEVOS, activa: true });
    expect(await filas()).toEqual([{ id_bodega: bodega.id_bodega, codigo: 'MZL', ...NUEVOS, activa: true }]);
  });

  it('no cambia `activa` ni `id_bodega` aunque vengan en el cuerpo', async () => {
    const res = await put(bodega.id_bodega, { ...NUEVOS, activa: false, id_bodega: 77 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_bodega: bodega.id_bodega, codigo: 'MZL', ...NUEVOS, activa: true });
    expect(await filas()).toEqual([{ id_bodega: bodega.id_bodega, codigo: 'MZL', ...NUEVOS, activa: true }]);
  });

  it('recorta los espacios, como el alta', async () => {
    const res = await put(bodega.id_bodega, { nombre: '  Nuevo nombre ', ciudad: 'Pereira\n', direccion: ' Calle 9 # 8-7 ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(NUEVOS);
  });

  it('repetir el mismo PUT devuelve lo mismo (idempotente por naturaleza)', async () => {
    const primera = await put(bodega.id_bodega, NUEVOS);
    const segunda = await put(bodega.id_bodega, NUEVOS);
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual(primera.body);
  });

  it('una bodega inactiva también se edita y sigue inactiva', async () => {
    const inactiva = await crearBodega(db, { codigo: 'OLD', activa: false });
    const res = await put(inactiva.id_bodega, NUEVOS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ codigo: 'OLD', ...NUEVOS, activa: false });
  });

  it('a un id inexistente → 404 NO_EXISTE (y con uno que existe, 200)', async () => {
    expect((await put(bodega.id_bodega, NUEVOS)).status).toBe(200);
    recursoNoExiste(await put(999, NUEVOS));
    expect((await filas())).toHaveLength(1);
  });

  it.each(['abc', '0', '07', '2147483648', '99999999999'])('el id %p → 404 NO_EXISTE', async (id) => {
    expect((await put(bodega.id_bodega, NUEVOS)).status).toBe(200);
    recursoNoExiste(await put(id, NUEVOS));
  });

  // Tabla 9: el cuerpo es {nombre, ciudad, direccion} y la sección 4.1 dice que solo los campos terminados en ? son
  // opcionales: los tres son obligatorios.
  it.each([
    [{ ciudad: 'Pereira', direccion: 'Calle 9' }, ['nombre']],
    [{ nombre: 'N', direccion: 'Calle 9' }, ['ciudad']],
    [{ nombre: 'N', ciudad: 'Pereira' }, ['direccion']],
    [{ nombre: 'N' }, ['ciudad', 'direccion']],
    [{}, ['nombre', 'ciudad', 'direccion']],
    [{ codigo: 'X' }, ['nombre', 'ciudad', 'direccion']],
  ])('con el cuerpo %j → 422 sobre %j y la bodega queda intacta', async (cuerpo, campos) => {
    expect((await put(bodega.id_bodega, NUEVOS)).status).toBe(200);
    datosNoValidos(await put(bodega.id_bodega, cuerpo), campos);
    expect(await filas()).toEqual([{ id_bodega: bodega.id_bodega, codigo: 'MZL', ...NUEVOS, activa: true }]);
  });

  it('sin cuerpo y con text/plain → 422 con los tres campos, no un 500', async () => {
    datosNoValidos(await request.put(`/bodegas/${bodega.id_bodega}`).set(ADM), ['nombre', 'ciudad', 'direccion']);
    const plano = await request.put(`/bodegas/${bodega.id_bodega}`).set(ADM).set('Content-Type', 'text/plain').send(JSON.stringify(NUEVOS));
    datosNoValidos(plano, ['nombre', 'ciudad', 'direccion']);
  });

  it('un cuerpo que es un arreglo → 422 sobre "cuerpo"', async () => {
    datosNoValidos(await put(bodega.id_bodega, [NUEVOS]), ['cuerpo']);
  });

  describe.each(['nombre', 'ciudad', 'direccion'])('el campo %s', (campo) => {
    const max = LARGOS[campo];

    it.each(NO_TEXTOS)('con %s → 422 sobre ese campo (no un 500)', async (_descripcion, valor) => {
      expect((await put(bodega.id_bodega, NUEVOS)).status).toBe(200);
      datosNoValidos(await put(bodega.id_bodega, { ...NUEVOS, [campo]: valor }), [campo]);
      expect((await filas())[0][campo]).toBe(NUEVOS[campo]);
    });

    it.each([['vacío', ''], ['solo espacios', '  ']])('%s → 422 sobre ese campo', async (_descripcion, valor) => {
      datosNoValidos(await put(bodega.id_bodega, { ...NUEVOS, [campo]: valor }), [campo]);
    });

    it(`acepta ${max} caracteres y rechaza ${max + 1} con 422, nunca un 500`, async () => {
      const exacto = await put(bodega.id_bodega, { ...NUEVOS, [campo]: 'y'.repeat(max) });
      expect(exacto.status).toBe(200);
      expect(exacto.body[campo]).toBe('y'.repeat(max));
      datosNoValidos(await put(bodega.id_bodega, { ...NUEVOS, [campo]: 'y'.repeat(max + 1) }), [campo]);
      expect((await filas())[0][campo]).toBe('y'.repeat(max));
    });

    it('rechaza el carácter nulo con 422', async () => {
      datosNoValidos(await put(bodega.id_bodega, { ...NUEVOS, [campo]: 'a\u0000b' }), [campo]);
    });

    it('rechaza un sustituto UTF-16 suelto con 422 y la bodega queda intacta', async () => {
      const cuerpo = JSON.stringify({ ...NUEVOS, [campo]: 'a#b' }).replace('#', '\\udc00');
      const res = await request.put(`/bodegas/${bodega.id_bodega}`).set(ADM).set('Content-Type', 'application/json').send(cuerpo);
      datosNoValidos(res, [campo]);
      expect(await filas()).toEqual([bodega]);
    });
  });

  it('sin X-User-Id → 401 y no cambia nada; con él, 200', async () => {
    const { 'X-User-Id': _usuario, ...sinUsuario } = ADM;
    esError(await put(bodega.id_bodega, NUEVOS, sinUsuario), 401, 'NO_AUTENTICADO');
    expect(await filas()).toEqual([bodega]);
    expect((await put(bodega.id_bodega, NUEVOS)).status).toBe(200);
  });

  it('la identidad se exige antes que el id y el cuerpo: sin X-User-Id, a un id inexistente o con un cuerpo inválido → 401', async () => {
    esError(await request.put('/bodegas/999').send(NUEVOS), 401, 'NO_AUTENTICADO');
    esError(await request.put(`/bodegas/${bodega.id_bodega}`).send({ nombre: 5 }), 401, 'NO_AUTENTICADO');
    esError(await request.put('/bodegas/abc').send({}), 401, 'NO_AUTENTICADO');
  });

  it('con X-User-Id inválido → 401', async () => {
    esError(await put(bodega.id_bodega, NUEVOS, { ...ADM, 'X-User-Id': 'abc' }), 401, 'NO_AUTENTICADO');
    expect(await filas()).toEqual([bodega]);
    expect((await put(bodega.id_bodega, NUEVOS)).status).toBe(200);
  });
});

describe.each([['inactivar', false], ['activar', true]])('POST /bodegas/:id/%s', (accion, activaFinal) => {
  const post = (id, cabeceras = ADM) => request.post(`/bodegas/${id}/${accion}`).set(cabeceras);
  const estadoInicial = !activaFinal;
  let bodega;

  beforeEach(async () => {
    bodega = await crearBodega(db, { codigo: 'MZL', activa: estadoInicial });
  });

  it(`→ 200 con la bodega completa y activa: ${activaFinal}; queda guardado y no cambia nada más`, async () => {
    const res = await post(bodega.id_bodega);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...bodega, activa: activaFinal });
    expect(await filas()).toEqual([{ ...bodega, activa: activaFinal }]);
  });

  it('es idempotente: repetirla devuelve 200 con el estado final, no un 409', async () => {
    const primera = await post(bodega.id_bodega);
    const segunda = await post(bodega.id_bodega);
    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(segunda.body).toEqual(primera.body);
    expect(segunda.body.activa).toBe(activaFinal);
  });

  it('solo cambia la bodega indicada', async () => {
    const otra = await crearBodega(db, { codigo: 'OTRA', activa: estadoInicial });
    await post(bodega.id_bodega);
    const guardadas = await filas();
    expect(guardadas.find((fila) => fila.id_bodega === bodega.id_bodega).activa).toBe(activaFinal);
    expect(guardadas.find((fila) => fila.id_bodega === otra.id_bodega).activa).toBe(estadoInicial);
  });

  it('a un id inexistente → 404 NO_EXISTE (y con uno que existe, 200)', async () => {
    expect((await post(bodega.id_bodega)).status).toBe(200);
    recursoNoExiste(await post(999));
  });

  it.each(['abc', '0', '07', '2147483648', '99999999999'])('el id %p → 404 NO_EXISTE', async (id) => {
    expect((await post(bodega.id_bodega)).status).toBe(200);
    recursoNoExiste(await post(id));
  });

  it('sin X-User-Id → 401 y no cambia nada; con él, 200', async () => {
    const { 'X-User-Id': _usuario, ...sinUsuario } = ADM;
    esError(await post(bodega.id_bodega, sinUsuario), 401, 'NO_AUTENTICADO');
    expect(await filas()).toEqual([bodega]);
    expect((await post(bodega.id_bodega)).status).toBe(200);
  });

  it('sin X-User-Id y a un id inexistente → 401, no 404', async () => {
    esError(await request.post(`/bodegas/999/${accion}`), 401, 'NO_AUTENTICADO');
  });

  it('con X-User-Id inválido → 401', async () => {
    esError(await post(bodega.id_bodega, { ...ADM, 'X-User-Id': '-3' }), 401, 'NO_AUTENTICADO');
    expect(await filas()).toEqual([bodega]);
    expect((await post(bodega.id_bodega)).status).toBe(200);
  });
});

describe('ciclo completo: inactivar y activar', () => {
  it('POST inactivar → 200 activa:false; POST activar → 200 activa:true; el listado por ?activa lo sigue', async () => {
    const creada = await control('MZL');
    expect(creada.activa).toBe(true);

    const inactivada = await request.post(`/bodegas/${creada.id_bodega}/inactivar`).set(ADM);
    expect(inactivada.status).toBe(200);
    expect(inactivada.body.activa).toBe(false);
    expect((await request.get('/bodegas').query({ activa: 'false' }).set(ADM)).body.datos.map((b) => b.id_bodega)).toEqual([creada.id_bodega]);
    expect((await request.get('/bodegas').query({ activa: 'true' }).set(ADM)).body.datos).toEqual([]);
    // No se borra: sigue consultable por id.
    expect((await request.get(`/bodegas/${creada.id_bodega}`).set(ADM)).body.activa).toBe(false);

    const activada = await request.post(`/bodegas/${creada.id_bodega}/activar`).set(ADM);
    expect(activada.status).toBe(200);
    expect(activada.body.activa).toBe(true);
    expect((await request.get('/bodegas').query({ activa: 'true' }).set(ADM)).body.datos.map((b) => b.id_bodega)).toEqual([creada.id_bodega]);
  });
});

describe('un fallo de la base (500)', () => {
  // La base «rota» lanza en el primer acceso: simula una caída de PostgreSQL sin tocar la base de pruebas.
  const dbRota = () => {
    throw new Error('secreto-de-la-base: password authentication failed');
  };

  it.each([
    ['GET', '/bodegas', undefined],
    ['GET', '/bodegas/1', undefined],
    ['POST', '/bodegas', BODEGA],
    ['PUT', '/bodegas/1', { nombre: 'N', ciudad: 'C', direccion: 'D' }],
    ['POST', '/bodegas/1/inactivar', undefined],
    ['POST', '/bodegas/1/activar', undefined],
  ])('%s %s → 500 ERROR_INTERNO sin mensaje ni traza; el registro lleva {nombre, mensaje, pila} y el request_id (D18)', async (metodo, ruta, cuerpo) => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const app = createApp({ db: dbRota, clients: {}, logger, env: entornoValido() });
    const peticion = supertest(app)[metodo.toLowerCase()](ruta).set(ADM).set('X-Request-Id', 'prueba-500');
    const res = await (cuerpo ? peticion.send(cuerpo) : peticion);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno del servidor', detalles: [] } });
    expect(res.text).not.toContain('secreto');
    expect(res.text).not.toContain('password');
    expect(res.text).not.toMatch(/\bat\s.+\(/); // ninguna línea de pila

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [registro] = logger.error.mock.calls[0];
    expect(registro).toMatchObject({
      request_id: 'prueba-500',
      estado: 500,
      codigo: 'ERROR_INTERNO',
      error: { nombre: 'Error', mensaje: expect.stringContaining('secreto-de-la-base'), pila: expect.stringContaining('secreto-de-la-base') },
    });
  });
});

describe('rutas que no existen en bodegas', () => {
  it.each([
    ['DELETE', '/bodegas/1'],
    ['PATCH', '/bodegas/1'],
    ['GET', '/bodegas/1/inactivar'],
    ['PUT', '/bodegas'],
    ['POST', '/bodegas/1'],
  ])('%s %s → 404 NO_EXISTE (las bodegas no se borran: se inactivan)', async (metodo, ruta) => {
    const creada = await crearBodega(db, { codigo: 'B1' });
    expect((await request.get(`/bodegas/${creada.id_bodega}`).set(ADM)).status).toBe(200);
    const res = await request[metodo.toLowerCase()](ruta).set(ADM);
    esError(res, 404, 'NO_EXISTE');
    expect(res.body.error.mensaje).toBe('La ruta solicitada no existe');
    expect(await filas()).toEqual([creada]);
  });
});
