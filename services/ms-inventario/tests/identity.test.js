const { AppError } = require('../src/errors');
const { identity, requireUser, scopeBodega, ROLES } = require('../src/middleware/identity');
const { miniApp, UUID } = require('./helpers/miniapp');

// Identidad sola (sin requestLog): `identity` debe resolver el request_id por su cuenta.
const appIdentidad = () =>
  miniApp(
    (app) => {
      app.get('/yo', (req, res) => res.json(req.identity));
      app.post('/escribir', (req, res) => res.status(201).json(requireUser(req.identity)));
    },
    { conRequestLog: false, logger: { info() {}, error() {} } },
  );

const NO_AUTENTICADO = { error: { codigo: 'NO_AUTENTICADO', mensaje: expect.any(String), detalles: [] } };

// Valores que no son un entero positivo representable: ninguno puede ser 500 ni ignorarse en silencio (D20).
const ENTEROS_INVALIDOS = ['0', '-1', 'abc', '1.5', '99999999999999999999', '1e3', '12abc', '0x10', '+5', '', '2147483648', '1, 2'];

describe('identity', () => {
  it('lee X-User-Id, X-User-Rol y X-User-Bodega, y propaga X-Request-Id', async () => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set({ 'X-User-Id': '7', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': '3', 'X-Request-Id': 'abc-123' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ idUsuario: 7, rol: 'OPERADOR_BODEGA', idBodega: 3, requestId: 'abc-123' });
  });

  it('sin X-Request-Id genera un UUID distinto en cada petición', async () => {
    const { request } = appIdentidad();
    const [a, b] = [await request.get('/yo'), await request.get('/yo')];
    expect(a.body.requestId).toMatch(UUID);
    expect(b.body.requestId).toMatch(UUID);
    expect(a.body.requestId).not.toBe(b.body.requestId);
  });

  it.each([['vacío', ''], ['solo espacios', '   '], ['con caracteres no permitidos', 'a b;c'], ['de más de 128 caracteres', 'x'.repeat(129)]])(
    'un X-Request-Id %s se reemplaza por un UUID nuevo',
    async (_descripcion, valor) => {
      const { request } = appIdentidad();
      const res = await request.get('/yo').set('X-Request-Id', valor);
      expect(res.body.requestId).toMatch(UUID);
    },
  );

  it.each(ROLES)('acepta el rol %s', async (rol) => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set({ 'X-User-Id': '1', 'X-User-Rol': rol });
    expect(res.status).toBe(200);
    expect(res.body.rol).toBe(rol);
  });

  it('los cuatro roles son exactamente ADMINISTRADOR, OPERADOR_BODEGA, VENDEDOR y CONTADOR', () => {
    expect([...ROLES].sort()).toEqual(['ADMINISTRADOR', 'CONTADOR', 'OPERADOR_BODEGA', 'VENDEDOR']);
  });

  it.each(['HACKER', 'administrador', 'ADMIN', 'ADMINISTRADOR,CONTADOR', ''])('rol %p fuera de los cuatro → 401 NO_AUTENTICADO', async (rol) => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set({ 'X-User-Id': '1', 'X-User-Rol': rol });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(NO_AUTENTICADO);
  });

  it('un rol fuera de los cuatro también es 401 en una llamada sin X-User-Id', async () => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set('X-User-Rol', 'HACKER');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(NO_AUTENTICADO);
  });

  it.each(ENTEROS_INVALIDOS)('X-User-Id %p → 401 NO_AUTENTICADO, nunca 500', async (valor) => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set({ 'X-User-Id': valor, 'X-User-Rol': 'ADMINISTRADOR' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(NO_AUTENTICADO);
  });

  it.each(ENTEROS_INVALIDOS)('X-User-Bodega %p (cuando viene) → 401 NO_AUTENTICADO, nunca 500', async (valor) => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set({ 'X-User-Id': '1', 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': valor });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(NO_AUTENTICADO);
  });

  it.each(['1', '2147483647'])('los extremos válidos %s se aceptan como número (techo: INTEGER de PostgreSQL)', async (valor) => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set({ 'X-User-Id': valor, 'X-User-Rol': 'OPERADOR_BODEGA', 'X-User-Bodega': valor });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ idUsuario: Number(valor), idBodega: Number(valor) });
  });

  it('X-User-Id sin X-User-Rol → 401 (el Gateway siempre manda las dos juntas)', async () => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set('X-User-Id', '1');
    expect(res.status).toBe(401);
    expect(res.body).toEqual(NO_AUTENTICADO);
  });

  it('GET sin X-User-Id es válido (llamada interna): idUsuario, rol e idBodega quedan en null', async () => {
    const { request } = appIdentidad();
    const res = await request.get('/yo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ idUsuario: null, rol: null, idBodega: null, requestId: expect.stringMatching(UUID) });
  });

  it('una llamada interna con X-User-Rol pero sin X-User-Id conserva el rol', async () => {
    const { request } = appIdentidad();
    const res = await request.get('/yo').set('X-User-Rol', 'CONTADOR');
    expect(res.body).toMatchObject({ idUsuario: null, rol: 'CONTADOR' });
  });

  it('una escritura sin X-User-Id → 401 NO_AUTENTICADO por requireUser', async () => {
    const { request } = appIdentidad();
    const res = await request.post('/escribir').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual(NO_AUTENTICADO);
  });

  it('una escritura con X-User-Id válido pasa requireUser', async () => {
    const { request } = appIdentidad();
    const res = await request.post('/escribir').set({ 'X-User-Id': '9', 'X-User-Rol': 'VENDEDOR' }).send({});
    expect(res.status).toBe(201);
    expect(res.body.idUsuario).toBe(9);
  });

  it('con requestLog delante, identity reutiliza el mismo request_id (uno solo por petición)', async () => {
    let visto;
    const { request } = miniApp((app) => app.get('/yo', (req, res) => { visto = req.identity.requestId; res.json({}); }), {
      logger: { info() {}, error() {} },
    });
    const res = await request.get('/yo').set('X-Request-Id', 'del-gateway-1');
    expect(visto).toBe('del-gateway-1');
    expect(res.headers['x-request-id']).toBe('del-gateway-1');
  });

  it('identity es un middleware (req, res, next) que fija req.identity y llama a next', () => {
    const req = { headers: { 'x-user-id': '5', 'x-user-rol': 'CONTADOR' } };
    const next = jest.fn();
    identity(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.identity).toMatchObject({ idUsuario: 5, rol: 'CONTADOR', idBodega: null });
  });
});

describe('requireUser', () => {
  it('devuelve la misma identidad cuando hay idUsuario', () => {
    const identidad = { idUsuario: 4, rol: 'VENDEDOR', idBodega: null, requestId: 'r' };
    expect(requireUser(identidad)).toBe(identidad);
  });

  it('lanza AppError 401 NO_AUTENTICADO cuando idUsuario es null', () => {
    let error;
    try {
      requireUser({ idUsuario: null, rol: null, idBodega: null, requestId: 'r' });
    } catch (capturado) {
      error = capturado;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 401, codigo: 'NO_AUTENTICADO' });
  });
});

describe('scopeBodega', () => {
  const capturar = (funcion) => {
    try {
      funcion();
    } catch (error) {
      return error;
    }
    throw new Error('Se esperaba un error y no se lanzó ninguno');
  };
  const sinPermiso = (error) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 403, codigo: 'SIN_PERMISO' });
  };

  it.each(['ADMINISTRADOR', 'CONTADOR'])('%s pasa lo pedido, sea una bodega o ninguna', (rol) => {
    expect(scopeBodega({ rol, idBodega: null }, 2)).toBe(2);
    expect(scopeBodega({ rol, idBodega: null }, undefined)).toBeUndefined();
    expect(scopeBodega({ rol, idBodega: 9 }, 2)).toBe(2);
  });

  it('VENDEDOR y las llamadas internas (rol null) también pasan lo pedido: solo el operador se limita', () => {
    expect(scopeBodega({ rol: 'VENDEDOR', idBodega: null }, 3)).toBe(3);
    expect(scopeBodega({ rol: null, idBodega: null }, 3)).toBe(3);
    expect(scopeBodega({ rol: null, idBodega: null }, undefined)).toBeUndefined();
  });

  it('OPERADOR_BODEGA sin pedido → su bodega', () => {
    expect(scopeBodega({ rol: 'OPERADOR_BODEGA', idBodega: 1 }, undefined)).toBe(1);
  });

  it('OPERADOR_BODEGA que pide su propia bodega → su bodega', () => {
    expect(scopeBodega({ rol: 'OPERADOR_BODEGA', idBodega: 1 }, 1)).toBe(1);
  });

  it('OPERADOR_BODEGA que pide otra bodega → 403 SIN_PERMISO', () => {
    const error = capturar(() => scopeBodega({ rol: 'OPERADOR_BODEGA', idBodega: 1 }, 2));
    sinPermiso(error);
    expect(error.message).toMatch(/bodega/i);
  });

  it('OPERADOR_BODEGA sin X-User-Bodega → 403 SIN_PERMISO, pida o no una bodega', () => {
    sinPermiso(capturar(() => scopeBodega({ rol: 'OPERADOR_BODEGA', idBodega: null }, undefined)));
    sinPermiso(capturar(() => scopeBodega({ rol: 'OPERADOR_BODEGA', idBodega: null }, 5)));
  });
});
